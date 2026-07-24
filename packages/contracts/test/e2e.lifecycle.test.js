const { expect } = require('chai')
const { ethers } = require('hardhat')
const crypto = require('crypto')
const { buildGenesis } = require('./helpers/genesis')
const { signAuthorization } = require('./helpers/authorization')
const { sdkRoot, signInput, p2pkhScript, u64be, mineSingleTxHeader, EASY_BITS, bitsToTarget } = require('./helpers/ecash')

const { Address, Coin, KeyRing, Output, Script, bcrypto } = require(sdkRoot + '/node_modules/@hansekontor/checkout-components')
const { PreimageMTX } = require(sdkRoot + '/dist/src/preimage')
const { mintCovenantV2, mintCovenantV2Ops, buildMintOpReturnV2, buildAuthorizationMessage } = require(sdkRoot + '/dist/src/script')
const { runCovenant, signDER } = require(sdkRoot + '/dist/src/covenantInterpreter')
const { SLP_DUST_SATS } = require(sdkRoot + '/dist/src/constants')
const { Hash160, secp256k1 } = bcrypto

// Full round trip, both chains, real cryptography and a real (if hand-interpreted,
// see covenantInterpreter.ts) covenant execution throughout -- no stage re-derives
// its own fresh test data, each one consumes exactly what the previous stage
// actually produced, the same way a real user/minter/burner would have to:
//
//   1. deposit()      ethers.js / Hardhat EVM
//   2. confirmDeposit()  Authorizer signs the digest the *contract itself* computed
//   3. getAuthorization() -- the "anyone can query" step (overview.md `5.` step 5):
//      every byte the mint step below uses comes from this public call, not from
//      local variables still in scope from step 1/2.
//   4. mint  -- a real PreimageMTX spending a real Coin at the real covenant P2SH
//      address, verified by the real covenant opcode sequence (mintCovenantV2Ops)
//      via runCovenant. The Authorizer's signature fed into this step is the
//      *actual* (v, r, s) confirmDeposit() verified on-chain via ecrecover,
//      re-encoded from Ethereum's (v, r, s) serialization to DER (secp256k1's
//      curve math doesn't care which chain's serialization convention is used --
//      same private key, same signature, two encodings) -- not a fresh signature
//      produced for this test.
//   5. burn  -- the recipient's own key (the same key whose HASH160 was named as
//      xecRecipient at deposit time) spends the exact coin the mint step produced.
//   6. release()  the EVM verifies the burn's real eCash signatures and a real,
//      mined-to-a-real-difficulty-floor block header/Merkle proof, then releases
//      collateral to an address derived from the burner's own pubkey -- proving
//      the same keypair that received the mint on XEC also receives the payout on
//      Ethereum, without that address ever being a caller-supplied argument
//      anywhere in this flow (contracts-spec.md `2.2`).
describe('bbridge end-to-end lifecycle (deposit -> confirm -> mint -> burn -> release)', function () {
  const feeAmount = 1_000n
  const tokenDecimals = 6 // matches USDC/USDT
  const xecDecimals = 9 // XEC is the more precise side; scale = 1000, exact both ways
  const scale = 1000n
  const minConfirmations = 3
  const refundDelay = 20
  const minDifficultyTarget = ethers.BigNumber.from(bitsToTarget(EASY_BITS).toString())

  it('moves value from an ETH depositor to an XEC recipient and back to a (different) ETH address', async function () {
    const [depositor] = await ethers.getSigners()
    const authorizerWallet = ethers.Wallet.createRandom()
    // Same private key, both chains: an uncompressed-pubkey Keccak derivation gives
    // the Authorizer's Ethereum address; a compressed serialization of the exact same
    // secp256k1 keypair is what gets baked into the eCash covenant below. There is
    // only ever one Authorizer keypair -- the two chains just serialize its public
    // key differently.
    const authorizerEcashRing = KeyRing.fromPrivate(Buffer.from(authorizerWallet.privateKey.slice(2), 'hex'), true)

    // The party that will hold the minted wrapped token and later burn it. Its
    // HASH160 is what the depositor names as xecRecipient -- nothing about deposit()
    // requires the depositor to control this key themselves (overview.md `5.` step 6:
    // anyone can complete a mint on the recipient's behalf).
    const recipientRing = KeyRing.generate()
    const xecRecipient = '0x' + Hash160.digest(recipientRing.getPublicKey()).toString('hex')

    // The party that actually broadcasts (here: constructs) the mint transaction.
    const minterRing = KeyRing.generate()

    const { rawTx: rawGenesisTx } = buildGenesis({ decimals: xecDecimals })

    const Token = await ethers.getContractFactory('MockERC20')
    const token = await Token.deploy('Test USD', 'TUSD')
    await token.deployed()
    const depositAmount = ethers.utils.parseUnits('250', 6)
    await token.mint(depositor.address, depositAmount)

    const Bridge = await ethers.getContractFactory('BridgeLock')
    const bridge = await Bridge.deploy(
      token.address,
      tokenDecimals,
      rawGenesisTx,
      authorizerWallet.address,
      feeAmount,
      minConfirmations,
      minDifficultyTarget,
      refundDelay
    )
    await bridge.deployed()
    const xecTokenId = await bridge.xecTokenId()
    const chainId = await bridge.chainId()

    // -- 1. Lock (overview.md `5.` step 1) --------------------------------------
    await token.connect(depositor).approve(bridge.address, depositAmount)
    const depositTx = await bridge.connect(depositor).deposit(depositAmount, xecRecipient)
    const depositReceipt = await depositTx.wait()
    const { depositId } = depositReceipt.events.find((e) => e.event === 'DepositLocked').args

    expect(await token.balanceOf(bridge.address)).to.equal(depositAmount)
    expect(await token.balanceOf(depositor.address)).to.equal(0)

    // -- 2. Confirmation (overview.md `5.` steps 3-4) ----------------------------
    for (let i = 0; i < minConfirmations; i++) await ethers.provider.send('evm_mine')

    // The vault UTXO the Authorizer is naming as this deposit's single-use nonce --
    // stands in for a real, independently-funded coin already sitting at the
    // covenant's P2SH address on XEC (contracts-spec.md `4.`'s utxoTxid/utxoIndex).
    // Reused verbatim as the real Coin's own outpoint in the mint step below, not
    // regenerated -- the whole point of binding it into the signed message is that
    // it names one specific, real coin.
    const utxoTxid = '0x' + crypto.randomBytes(32).toString('hex')
    const utxoIndex = 0

    const { xecAmount: preConfirmXecAmount, xecRecipient: storedXecRecipient } = await bridge.getAuthorization(depositId)
    const { v, r, s } = await signAuthorization(authorizerWallet, {
      depositId,
      chainId,
      utxoTxid,
      utxoIndex,
      xecTokenId,
      xecAmount: preConfirmXecAmount,
      xecRecipient: storedXecRecipient
    })

    await expect(bridge.confirmDeposit(depositId, utxoTxid, utxoIndex, v, r, s))
      .to.emit(bridge, 'DepositConfirmed')
      .withArgs(depositId, utxoTxid, utxoIndex)

    // -- 3. Publication: anyone (this test included) reads the authorization back
    // from public contract state (overview.md `5.` step 5) -- everything from here
    // on uses only what this call returns, not the locally-held v/r/s/xecAmount above.
    const auth = await bridge.getAuthorization(depositId)
    expect(auth.confirmed).to.equal(true)
    expect(auth.xecAmount).to.equal(depositAmount.sub(feeAmount).mul(scale)) // exact: XEC is the more precise side

    const tokenIdBuf = Buffer.from(xecTokenId.slice(2), 'hex')
    const xecRecipientBuf = Buffer.from(auth.xecRecipient.slice(2), 'hex')
    const xecAmountNum = auth.xecAmount.toNumber()
    const authUtxoTxidBuf = Buffer.from(auth.utxoTxid.slice(2), 'hex')
    const authUtxoIndex = auth.utxoIndex

    // -- 4. Mint (overview.md `5.` step 6) ---------------------------------------
    const covenantScript = mintCovenantV2(authorizerEcashRing.getPublicKey())
    const vaultCoin = new Coin({
      hash: authUtxoTxidBuf,
      index: authUtxoIndex,
      script: Script.fromAddress(Address.fromScripthash(covenantScript.hash160())),
      value: 1000
    })

    const mintOutput = new Output({ script: buildMintOpReturnV2(tokenIdBuf, [xecAmountNum]), value: 0 })
    const recipientOutput = new Output({ address: Address.fromPubkeyhash(xecRecipientBuf), value: SLP_DUST_SATS })

    const mintTx = new PreimageMTX()
    mintTx.addCoin(vaultCoin)
    mintTx.outputs = [mintOutput, recipientOutput]

    const mintSigHashType = Script.hashType.ALL | Script.hashType.SIGHASH_FORKID
    const flags = Script.flags.STANDARD_VERIFY_FLAGS
    mintTx.template(minterRing)
    const preimage = mintTx.getPreimage(0, covenantScript, vaultCoin.value, mintSigHashType, false)
    const realSighash = mintTx.signatureHash(0, covenantScript, vaultCoin.value, mintSigHashType, flags)
    // Deliberately not tx.signature(...) -- see contracts-spec.md `8.`'s note on
    // that wrapper's Schnorr-by-default behavior.
    const minterSig = Buffer.concat([signDER(realSighash, minterRing.privateKey), Buffer.from([mintSigHashType])])

    const message = buildAuthorizationMessage(
      Buffer.from(depositId.slice(2), 'hex'),
      BigInt(chainId.toString()),
      authUtxoTxidBuf,
      authUtxoIndex,
      tokenIdBuf,
      xecAmountNum,
      xecRecipientBuf
    )
    // The exact (v, r, s) getAuthorization() returned -- ecrecover's own serialization
    // of the Authorizer's ECDSA signature -- re-encoded to DER for the covenant's
    // OP_CHECKDATASIGVERIFY. Same signature, same curve, different wire format; not a
    // fresh signature produced for the eCash side.
    const authSig = secp256k1.signatureExport(Buffer.concat([Buffer.from(auth.r.slice(2), 'hex'), Buffer.from(auth.s.slice(2), 'hex')]))

    const mintAccepted = runCovenant(
      mintCovenantV2Ops(authorizerEcashRing.getPublicKey()),
      [minterSig, minterRing.getPublicKey(), preimage, authSig, message],
      { realSighash }
    )
    expect(mintAccepted, 'covenant rejected a mint authorized by the ETH contract\'s own confirmDeposit() signature').to.equal(true)

    mintTx.inputs[0].script.fromItems([minterSig, minterRing.getPublicKey(), preimage, authSig, message, covenantScript.toRaw()])
    const mintTxid = mintTx.hash()

    // -- 5. Burn (overview.md `6.` steps 1-2) ------------------------------------
    // The recipient spends exactly the coin the mint transaction above produced at
    // output index 1 -- not a freshly synthesized one.
    const mintedCoin = new Coin({ hash: mintTxid, index: 1, script: p2pkhScript(xecRecipientBuf), value: SLP_DUST_SATS })

    const stampValue = 2000
    const stampCoin = new Coin({
      hash: crypto.randomBytes(32),
      index: 0,
      script: p2pkhScript(Hash160.digest(authorizerEcashRing.getPublicKey())),
      value: stampValue
    })

    const assetId = Buffer.concat([Buffer.from(bridge.address.replace(/^0x/, ''), 'hex'), Buffer.alloc(12)])
    const burnOpReturn = new Script()
      .pushSym('return')
      .pushData(Buffer.concat([Buffer.from('SLP', 'ascii'), Buffer.alloc(1)]))
      .pushPush(Buffer.alloc(1, 2))
      .pushData(Buffer.from('BURN', 'ascii'))
      .pushData(tokenIdBuf)
      .pushData(u64be(BigInt(xecAmountNum)))
      .pushData(assetId)
      .pushData(xecRecipientBuf) // 2026-07 review: Authorizer-attested recipient hash160
      .compile()

    const burnTx = new PreimageMTX()
    burnTx.addCoin(mintedCoin)
    burnTx.addCoin(stampCoin)
    burnTx.addOutput(burnOpReturn, 0)

    const SIGHASH_ALL = 0x01
    const SIGHASH_FORKID = 0x40
    const SIGHASH_ANYONECANPAY = 0x80

    burnTx.template(recipientRing)
    const burnSig = signInput(
      burnTx,
      0,
      mintedCoin.script,
      mintedCoin.value,
      recipientRing.privateKey,
      SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY,
      flags
    )
    burnTx.inputs[0].script.fromItems([burnSig, recipientRing.getPublicKey()])

    burnTx.template(authorizerEcashRing)
    const postageSig = signInput(
      burnTx,
      1,
      stampCoin.script,
      stampCoin.value,
      authorizerEcashRing.privateKey,
      SIGHASH_ALL | SIGHASH_FORKID,
      flags
    )
    burnTx.inputs[1].script.fromItems([postageSig, authorizerEcashRing.getPublicKey()])

    burnTx.check(flags) // both inputs are plain P2PKH -- the real VM validates these

    // -- 6. Proof and release (overview.md `6.` step 3) --------------------------
    const burnTxid = burnTx.hash()
    const header = mineSingleTxHeader(burnTxid) // single-tx block: merkleRoot == burnTxid, empty branch

    const expectedEthRecipient = ethers.utils.computeAddress('0x' + recipientRing.getPublicKey().toString('hex'))
    const bridgeBalanceBeforeRelease = await token.balanceOf(bridge.address)

    const releaseTx = await bridge.release('0x' + burnTx.toRaw().toString('hex'), stampValue, [], 0, '0x' + header.toString('hex'))
    const releaseReceipt = await releaseTx.wait()
    const releaseEvent = releaseReceipt.events.find((e) => e.event === 'WithdrawalReleased')

    // Both fees (the deposit-side feeAmount and the withdrawal-side feeAmountXec,
    // which is feeAmount scaled exactly since XEC is the more precise side) are the
    // only value lost across the round trip.
    const expectedReleaseAmount = depositAmount.sub(feeAmount).sub(feeAmount)

    expect(releaseEvent.args.recipient).to.equal(expectedEthRecipient)
    expect(releaseEvent.args.recipient).to.not.equal(depositor.address) // recipient is decoupled from depositor by design
    expect(releaseEvent.args.amount).to.equal(expectedReleaseAmount)
    expect(releaseEvent.args.tokenId).to.equal(xecTokenId)

    const stampKey = ethers.utils.solidityKeccak256(['bytes32', 'uint32'], ['0x' + stampCoin.hash.toString('hex'), stampCoin.index])
    expect(await bridge.stampUtxoConsumedBy(stampKey)).to.equal('0x' + burnTxid.toString('hex'))
    expect(await token.balanceOf(expectedEthRecipient)).to.equal(expectedReleaseAmount)
    expect(await token.balanceOf(bridge.address)).to.equal(bridgeBalanceBeforeRelease.sub(expectedReleaseAmount))
    // What remains locked in the contract is exactly both collected fees -- no value
    // created or destroyed across the full round trip beyond the two fixed fees.
    expect(await token.balanceOf(bridge.address)).to.equal(2n * feeAmount)
  })
})

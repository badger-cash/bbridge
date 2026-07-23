# Entry Point Map

> BridgeLock | 4 entry points | 3 permissionless | 1 role-gated (self-scoped) | 0 admin-only

---

## Protocol Flow Paths

### Setup

None. No admin setup exists — `token`, `authorizer`, `feeAmount`, `minConfirmations`, `xecNetworkId`, `minDifficultyTarget` are all fixed at construction (`BridgeLock.sol:83-97`); nothing is configured after deployment.

### Deposit / Confirm Flow (User + Authorizer)

`deposit()` → [off-chain: Authorizer observes the deposit]  ◄── `minConfirmations` Ethereum blocks must elapse
                                                    → `confirmDeposit()`  ◄── relayed by anyone, content signed by the Authorizer
                                                          ├─→ `getAuthorization()`  ◄── public, anyone can read the attestation
                                                          └─→ [off-chain: XEC-side self-mint covenant, out of scope]

`deposit()` → `refund()`  ◄── only before `confirmDeposit()` succeeds, only callable by the original depositor

### Withdrawal Flow (User + Authorizer, off-chain then on-chain)

[off-chain: user burns the wrapped token on XEC; Authorizer co-signs a postage input] → [off-chain: burn transaction mines into a block]
  → `release()`  ◄── burn tx must clear the PoW floor, a valid Merkle inclusion proof, and both signatures

---

## Permissionless

Entry points callable by any address with no effective access restriction, sorted tokens-in, tokens-out, no-movement.

### `BridgeLock.deposit()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | User (depositor) |
| Parameters | `amount` (user-controlled), `xecRecipient` (user-controlled) |
| Call chain | `→ BridgeLock.deposit() → IERC20.safeTransferFrom()` |
| State modified | `deposits[depositId]` (created), `_depositNonce` (+1) |
| Value flow | User → BridgeLock (`amount` of `token`) |
| Reentrancy guard | no (not needed — state written before the external call) |

### `BridgeLock.release()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone (need not be the burner) |
| Parameters | `rawBurnTx` (user-signed), `stampValue` (caller-supplied, bound only via the stamp signature check), `merkleBranch` (caller-supplied), `merkleIndex` (caller-supplied), `rawHeader` (caller-supplied) |
| Call chain | `→ BridgeLock.release() → EcashTx.parse() → EcashTx.extractSigAndPubkey()/parseDER()/decompress()/verifyAgainstPubkey() → Sighash.digest() → Difficulty.meetsFloor() → MerkleProof.verify() → IERC20.safeTransfer()` |
| State modified | `redeemed[burnTxid]` |
| Value flow | BridgeLock → derived `ethRecipient` (`releaseAmount` of `token`) |
| Reentrancy guard | no (not needed — `redeemed[burnTxid]` set before the external call) |

### `BridgeLock.confirmDeposit()`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Anyone (typically a relayer forwarding the Authorizer's off-chain signature) |
| Parameters | `depositId` (caller-controlled, must reference an existing deposit), `utxoRef` (Authorizer-determined), `v`/`r`/`s` (Authorizer-signed) |
| Call chain | `→ BridgeLock.confirmDeposit() → ecrecover()` (precompile) |
| State modified | `deposits[depositId].confirmed`, `_authorizations[depositId]` |
| Value flow | none |
| Reentrancy guard | no (no external call) |

---

## Role-Gated

### Original Depositor *(self-scoped — restricted to `deposits[depositId].depositor`, not a protocol-wide role)*

#### `BridgeLock.refund()`

| Aspect | Detail |
|--------|--------|
| Visibility | external, internal `msg.sender == d.depositor` check (no modifier) |
| Caller | The specific address that called `deposit()` for this `depositId` |
| Parameters | `depositId` (caller-controlled, must reference caller's own deposit) |
| Call chain | `→ BridgeLock.refund() → IERC20.safeTransfer()` |
| State modified | `deposits[depositId].refunded` |
| Value flow | BridgeLock → depositor (full original locked amount, fee included) |
| Reentrancy guard | no (not needed — `refunded` set before the external call) |

---

## Admin-Only

None. No admin, owner, or privileged role exists anywhere in this contract (`contracts-spec.md` §3); every deployment parameter is immutable and there is no setter.

---

## Excluded from scope

`BridgeLock.getAuthorization()` — `view`, excluded per entry-point rules (view functions are not entry points). `MockERC20.mint()` — mock contract, test-only, excluded per scope filtering.

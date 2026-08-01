// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EcashTx} from "../lib/EcashTx.sol";
import {Sighash} from "../lib/Sighash.sol";
import {MerkleProof} from "../lib/MerkleProof.sol";
import {Difficulty} from "../lib/Difficulty.sol";

/// @title Where release()'s gas actually goes.
///
/// @dev Test-only, and never deployed anywhere real. It exists because
/// `hardhat-gas-reporter` measures whole calls: it says release() costs about 448,000
/// gas and stops, which is enough to know the total and not enough to know what to do
/// about it. Optimising against that number alone is guesswork.
///
/// Measured with `gasleft()` deltas rather than by giving each stage its own external
/// call. A per-call approach would fold the 21,000 transaction base and the calldata
/// cost into every stage, and calldata here is the burn transaction -- hundreds of
/// bytes -- so the overhead would swamp what is being measured. A delta around an
/// inlined internal call measures the work and nothing else.
///
/// Deliberately mirrors release()'s real sequence, using the same libraries against the
/// same transaction the release tests build, so the parts sum to something comparable
/// to the whole rather than to a simplified stand-in.
contract GasProbe {
    struct Step {
        string name;
        uint256 gas;
    }

    Step[] private steps;

    function record(string memory name, uint256 used) private {
        steps.push(Step(name, used));
    }

    function results() external view returns (Step[] memory) {
        return steps;
    }

    /// @dev Walks release()'s verification path, timing each stage.
    ///
    /// The storage writes and the ERC20 transfer are deliberately absent: their cost is
    /// fixed and known from the yellow paper (20,000 per new slot) rather than
    /// discoverable, and including a token here would measure a mock rather than USDC.
    /// What is unknown, and therefore what this measures, is the interpreted
    /// byte-shuffling: parsing, sighash reconstruction, signature recovery, proofs.
    function profile(
        bytes calldata rawBurnTx,
        uint64 burnInputValue,
        uint64 stampValue,
        bytes32[] calldata merkleBranch,
        uint256 merkleIndex,
        bytes calldata rawHeader,
        uint256 maxAcceptableTarget
    ) external {
        delete steps;
        uint256 g;

        g = gasleft();
        bytes32 burnTxid = sha256(abi.encodePacked(sha256(rawBurnTx)));
        record("txid (double sha256)", g - gasleft());

        g = gasleft();
        EcashTx.Tx memory parsedTx = EcashTx.parse(rawBurnTx);
        record("EcashTx.parse", g - gasleft());

        g = gasleft();
        EcashTx.hash160(parsedTx.inputs[0].scriptSig);
        record("hash160 (sha256+ripemd160)", g - gasleft());

        // --- burn input, SIGHASH_ALL|FORKID|ANYONECANPAY ------------------------
        g = gasleft();
        (bytes memory sig0, bytes memory pub0) = EcashTx.extractSigAndPubkey(parsedTx.inputs[0].scriptSig);
        record("extractSigAndPubkey (burn)", g - gasleft());

        g = gasleft();
        (uint256 r0, uint256 s0,) = EcashTx.parseDER(sig0);
        record("parseDER (burn)", g - gasleft());

        g = gasleft();
        (uint256 x0, uint256 y0) = EcashTx.decompress(pub0);
        record("decompress (burn, MODEXP)", g - gasleft());

        g = gasleft();
        bytes memory scriptCode0 = EcashTx.p2pkhScriptCode(EcashTx.hash160(pub0));
        record("p2pkhScriptCode (burn)", g - gasleft());

        // ANYONECANPAY, so hashPrevouts and hashSequence are zero and only hashOutputs
        // is actually computed -- the cheaper of the two sighashes by construction.
        g = gasleft();
        bytes32 digest0 = Sighash.digest(parsedTx, 0, scriptCode0, burnInputValue, 0x01 | 0x40 | 0x80);
        record("Sighash.digest (burn, ANYONECANPAY)", g - gasleft());

        g = gasleft();
        EcashTx.verifyAgainstPubkey(digest0, r0, s0, x0, y0);
        record("verifyAgainstPubkey (burn, ecrecover)", g - gasleft());

        g = gasleft();
        EcashTx.addressFromPubkey(x0, y0);
        record("addressFromPubkey (burn)", g - gasleft());

        // --- stamp input, SIGHASH_ALL|FORKID ------------------------------------
        g = gasleft();
        (bytes memory sig1, bytes memory pub1) = EcashTx.extractSigAndPubkey(parsedTx.inputs[1].scriptSig);
        record("extractSigAndPubkey (stamp)", g - gasleft());

        g = gasleft();
        (uint256 r1, uint256 s1,) = EcashTx.parseDER(sig1);
        record("parseDER (stamp)", g - gasleft());

        g = gasleft();
        (uint256 x1, uint256 y1) = EcashTx.decompress(pub1);
        record("decompress (stamp, MODEXP)", g - gasleft());

        g = gasleft();
        bytes memory scriptCode1 = EcashTx.p2pkhScriptCode(EcashTx.hash160(pub1));
        record("p2pkhScriptCode (stamp)", g - gasleft());

        // No ANYONECANPAY here, so this one pays for hashPrevouts and hashSequence as
        // well -- and recomputes hashOutputs, which the burn sighash above already
        // produced identically. That duplication is the thing worth pricing.
        g = gasleft();
        bytes32 digest1 = Sighash.digest(parsedTx, 1, scriptCode1, stampValue, 0x01 | 0x40);
        record("Sighash.digest (stamp, ALL)", g - gasleft());

        g = gasleft();
        EcashTx.verifyAgainstPubkey(digest1, r1, s1, x1, y1);
        record("verifyAgainstPubkey (stamp, ecrecover)", g - gasleft());

        // --- inclusion proof ----------------------------------------------------
        g = gasleft();
        Difficulty.meetsFloor(rawHeader, maxAcceptableTarget);
        record("Difficulty.meetsFloor", g - gasleft());

        g = gasleft();
        bytes32 root = Difficulty.headerMerkleRoot(rawHeader);
        record("Difficulty.headerMerkleRoot", g - gasleft());

        g = gasleft();
        MerkleProof.verify(burnTxid, merkleBranch, merkleIndex, root);
        record("MerkleProof.verify", g - gasleft());
    }
}

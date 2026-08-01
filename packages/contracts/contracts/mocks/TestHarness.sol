// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "../lib/MerkleProof.sol";
import {Difficulty} from "../lib/Difficulty.sol";
import {EcashTx} from "../lib/EcashTx.sol";

/// @notice Test-only wrapper exposing internal library functions externally so they
/// can be called directly from tests, without going through BridgeLock's own state.
contract TestHarness {
    function readPush(bytes calldata script, uint256 offset) external pure returns (bytes memory data, uint256 newOffset) {
        return EcashTx.readPush(script, offset);
    }

    function extractSigAndPubkey(bytes calldata scriptSig) external pure returns (bytes memory sig, bytes memory pubkey) {
        return EcashTx.extractSigAndPubkey(scriptSig);
    }

    function merkleVerify(bytes32 leaf, bytes32[] calldata branch, uint256 index, bytes32 root) external pure returns (bool) {
        return MerkleProof.verify(leaf, branch, index, root);
    }

    function headerHash(bytes calldata rawHeader) external pure returns (bytes32) {
        return Difficulty.headerHash(rawHeader);
    }

    function headerBits(bytes calldata rawHeader) external pure returns (uint32) {
        return Difficulty.headerBits(rawHeader);
    }

    function headerMerkleRoot(bytes calldata rawHeader) external pure returns (bytes32) {
        return Difficulty.headerMerkleRoot(rawHeader);
    }

    function meetsFloor(bytes calldata rawHeader, uint256 maxAcceptableTarget) external pure returns (bool) {
        return Difficulty.meetsFloor(rawHeader, maxAcceptableTarget);
    }

    function bitsToTarget(uint32 bits) external pure returns (uint256) {
        return Difficulty.bitsToTarget(bits);
    }
}

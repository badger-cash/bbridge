// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "../lib/MerkleProof.sol";
import {Difficulty} from "../lib/Difficulty.sol";

/// @notice Test-only wrapper exposing internal library functions externally so they
/// can be called directly from tests, without going through BridgeLock's own state.
contract TestHarness {
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

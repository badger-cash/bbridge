// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Difficulty
/// @notice Bitcoin/eCash-family compact-bits target conversion and the single-header
/// proof-of-work floor check described in docs/overview.md `6.`/`7.` and
/// contracts-spec.md `6.` step 5 -- deliberately just a self-consistency + floor
/// check, not header-chain continuity (see overview.md `10.`, "resolved").
library Difficulty {
    /// @dev Converts Bitcoin-style compact `bits` (first byte = exponent, remaining
    /// three bytes = mantissa) to a full-width target, per the standard algorithm
    /// (equivalent to Bitcoin Core's `arith_uint256::SetCompact`, negative/overflow
    /// flag handling omitted as out of scope for a floor check on real headers).
    function bitsToTarget(uint32 bits) internal pure returns (uint256 target) {
        uint256 exponent = bits >> 24;
        uint256 mantissa = bits & 0x007fffff;

        if (exponent <= 3) {
            target = mantissa >> (8 * (3 - exponent));
        } else {
            target = mantissa << (8 * (exponent - 3));
        }
    }

    /// @dev Interprets a 32-byte hash in internal (natural double-SHA256 output) byte
    /// order as the little-endian integer Bitcoin-family consensus compares against
    /// `target` -- NOT the reversed "display" order used for human-readable block
    /// hashes (same internal/display distinction documented in
    /// packages/sdk/src/merkle.ts for txids and merkle roots).
    function hashToUint(bytes32 internalOrderHash) internal pure returns (uint256 result) {
        for (uint256 i = 0; i < 32; i++) {
            result |= uint256(uint8(internalOrderHash[i])) << (8 * i);
        }
    }

    /// @dev HASH256 of an 80-byte block header (version||prevBlock||merkleRoot||time||bits||nonce).
    function headerHash(bytes calldata rawHeader) internal pure returns (bytes32) {
        require(rawHeader.length == 80, "header must be 80 bytes");
        return sha256(abi.encodePacked(sha256(rawHeader)));
    }

    /// @dev Reads the `bits` field (bytes 72..75, little-endian) from a raw header.
    function headerBits(bytes calldata rawHeader) internal pure returns (uint32) {
        require(rawHeader.length == 80, "header must be 80 bytes");
        bytes4 be;
        for (uint256 i = 0; i < 4; i++) {
            be |= bytes4(rawHeader[75 - i]) >> (8 * i);
        }
        return uint32(be);
    }

    /// @dev Reads the `merkleRoot` field (bytes 36..67) from a raw header, straight
    /// byte-order copy (no reversal) -- same internal-order convention as everywhere
    /// else in this codebase (packages/sdk's abstractblock.js reads/writes it the
    /// same way).
    function headerMerkleRoot(bytes calldata rawHeader) internal pure returns (bytes32 result) {
        require(rawHeader.length == 80, "header must be 80 bytes");
        for (uint256 i = 0; i < 32; i++) {
            result |= bytes32(uint256(uint8(rawHeader[36 + i]))) << (8 * (31 - i));
        }
    }

    /// @dev True if `rawHeader`'s own hash is self-consistent with the difficulty its
    /// own `bits` field claims, AND that difficulty is at least as hard as the fixed
    /// floor represented by `maxAcceptableTarget` (a *ceiling* on target -- lower
    /// target means higher difficulty, so "clears the floor" means the header's own
    /// implied target must be at or below this value). This is the "second factor"
    /// described in overview.md `7.`, not an independent inclusion guarantee.
    function meetsFloor(bytes calldata rawHeader, uint256 maxAcceptableTarget) internal pure returns (bool) {
        uint256 target = bitsToTarget(headerBits(rawHeader));
        if (target > maxAcceptableTarget) return false;

        uint256 hashValue = hashToUint(headerHash(rawHeader));
        return hashValue <= target;
    }
}

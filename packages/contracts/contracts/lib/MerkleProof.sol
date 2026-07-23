// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerkleProof
/// @notice Verifies Bitcoin/eCash-family Merkle inclusion proofs. Must stay in sync
/// with packages/sdk/src/merkle.ts's algorithm (backed by bcrypto's merkle.js) --
/// same leaf/branch/index convention, same duplicate-last-node handling (the classic
/// Bitcoin behavior described in that file's own header comment, not RFC 6962).
library MerkleProof {
    /// @dev Recomputes the Merkle root from a leaf and its branch, following the same
    /// algorithm as bcrypto's `deriveRoot`: at each level, `index`'s parity picks
    /// which side the sibling goes on, and a sibling equal to the accumulated root
    /// on the "odd" side signals the classic duplicate-node malleation (CVE-2012-2459)
    /// and forces a mismatch (via a hash no real proof could target) rather than a
    /// false-positive match.
    function deriveRoot(bytes32 leaf, bytes32[] calldata branch, uint256 index) internal pure returns (bytes32) {
        bytes32 root = leaf;

        for (uint256 i = 0; i < branch.length; i++) {
            bytes32 sibling = branch[i];

            if ((index & 1) == 1 && sibling == root) {
                return bytes32(0);
            }

            root = (index & 1) == 1 ? hash256(sibling, root) : hash256(root, sibling);
            index >>= 1;
        }

        return root;
    }

    function verify(bytes32 leaf, bytes32[] calldata branch, uint256 index, bytes32 root) internal pure returns (bool) {
        return deriveRoot(leaf, branch, index) == root;
    }

    /// @dev HASH256(left || right) = sha256(sha256(left || right)), the Bitcoin-family
    /// Merkle parent hash.
    function hash256(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(abi.encodePacked(left, right))));
    }
}

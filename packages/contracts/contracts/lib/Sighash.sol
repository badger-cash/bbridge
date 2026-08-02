// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EcashTx} from "./EcashTx.sol";

/// @title Sighash
/// @notice Computes the BIP143-style sighash digest for a single input of an
/// already-parsed eCash transaction, replicating packages/sdk's PreimageMTX
/// (src/preimage.ts) exactly, for the sighash types release() needs (overview.md
/// `6.`): SIGHASH_ALL|FORKID (the Authorizer's stamp input) and
/// SIGHASH_ALL|ANYONECANPAY|FORKID (the user's burn input). SIGHASH_NONE/SINGLE are
/// not implemented -- neither case used here is ever anything but (a variant of)
/// SIGHASH_ALL, so hashOutputs is always computed unconditionally, unlike the more
/// general branching in preimage.ts.
library Sighash {
    uint32 internal constant SIGHASH_ALL = 0x01;
    uint32 internal constant SIGHASH_ANYONECANPAY = 0x80;
    uint32 internal constant SIGHASH_FORKID = 0x40;

    /// @param sighashType the full combined type value (e.g. 0x41 for ALL|FORKID,
    /// 0xc1 for ALL|FORKID|ANYONECANPAY) -- matches how packages/sdk always
    /// constructs it (`Script.hashType.ALL | Script.hashType.SIGHASH_FORKID`, etc.)
    /// as one value, not separate fields.
    function digest(
        EcashTx.Tx memory transaction,
        uint256 inputIndex,
        bytes memory scriptCode,
        uint64 inputValue,
        uint32 sighashType
    ) internal pure returns (bytes32) {
        bool anyoneCanPay = (sighashType & SIGHASH_ANYONECANPAY) != 0;

        bytes32 hashPrevouts = bytes32(0);
        bytes32 hashSequence = bytes32(0);

        if (!anyoneCanPay) {
            hashPrevouts = hash256(prevoutsBytes(transaction));
            hashSequence = hash256(sequencesBytes(transaction));
        }

        bytes32 hashOutputs = hash256(outputsBytes(transaction));

        EcashTx.Input memory inp = transaction.inputs[inputIndex];

        bytes memory preimage = abi.encodePacked(
            leU32(transaction.version),
            hashPrevouts,
            hashSequence,
            inp.prevoutHash,
            leU32(inp.prevoutIndex),
            varInt(scriptCode.length),
            scriptCode,
            leU64(inputValue),
            leU32(inp.sequence),
            hashOutputs,
            leU32(transaction.locktime),
            leU32(sighashType)
        );

        return hash256(preimage);
    }

    function prevoutsBytes(EcashTx.Tx memory transaction) private pure returns (bytes memory result) {
        for (uint256 i = 0; i < transaction.inputs.length; i++) {
            result = abi.encodePacked(result, transaction.inputs[i].prevoutHash, leU32(transaction.inputs[i].prevoutIndex));
        }
    }

    function sequencesBytes(EcashTx.Tx memory transaction) private pure returns (bytes memory result) {
        for (uint256 i = 0; i < transaction.inputs.length; i++) {
            result = abi.encodePacked(result, leU32(transaction.inputs[i].sequence));
        }
    }

    function outputsBytes(EcashTx.Tx memory transaction) private pure returns (bytes memory result) {
        for (uint256 i = 0; i < transaction.outputs.length; i++) {
            EcashTx.Output memory o = transaction.outputs[i];
            result = abi.encodePacked(result, leU64(o.value), varInt(o.script.length), o.script);
        }
    }

    /*
     * Fixed-width value types rather than `bytes memory`.
     *
     * These are called about a dozen times per digest -- once per input for the
     * prevout index and the sequence, once per output for the value, and five more in
     * the preimage itself. Returning `bytes memory` meant each call allocated a small
     * array, filled it a byte at a time with a bounds check per byte, and was then
     * copied a second time by the `abi.encodePacked` that consumed it.
     *
     * `abi.encodePacked` writes a `bytesN` inline, so returning `bytes4`/`bytes8`
     * removes both the allocation and the copy while producing identical bytes.
     */

    /// @dev uint32 to its little-endian 4 bytes: 0xAABBCCDD becomes DD CC BB AA.
    function leU32(uint32 value) internal pure returns (bytes4) {
        return bytes4(
            (value << 24) |
            ((value & 0x0000ff00) << 8) |
            ((value >> 8) & 0x0000ff00) |
            (value >> 24)
        );
    }

    /// @dev uint64 to its little-endian 8 bytes, by the standard pairwise byte swap:
    /// exchange adjacent bytes, then adjacent pairs, then the two halves.
    function leU64(uint64 value) internal pure returns (bytes8) {
        uint64 v = value;
        v = ((v & 0x00ff00ff00ff00ff) << 8) | ((v >> 8) & 0x00ff00ff00ff00ff);
        v = ((v & 0x0000ffff0000ffff) << 16) | ((v >> 16) & 0x0000ffff0000ffff);
        v = (v << 32) | (v >> 32);
        return bytes8(v);
    }

    /// @dev Bitcoin-style CompactSize varint encoding.
    function varInt(uint256 value) internal pure returns (bytes memory result) {
        if (value < 0xfd) {
            result = new bytes(1);
            result[0] = bytes1(uint8(value));
        } else if (value <= 0xffff) {
            result = new bytes(3);
            result[0] = 0xfd;
            result[1] = bytes1(uint8(value));
            result[2] = bytes1(uint8(value >> 8));
        } else if (value <= 0xffffffff) {
            result = new bytes(5);
            result[0] = 0xfe;
            for (uint256 i = 0; i < 4; i++) result[1 + i] = bytes1(uint8(value >> (8 * i)));
        } else {
            result = new bytes(9);
            result[0] = 0xff;
            for (uint256 i = 0; i < 8; i++) result[1 + i] = bytes1(uint8(value >> (8 * i)));
        }
    }

    function hash256(bytes memory data) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(data)));
    }
}

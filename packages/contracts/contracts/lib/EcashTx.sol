// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EcashTx
/// @notice Minimal eCash/Bitcoin-family transaction parsing and signature-related
/// helpers -- just enough for release() (contracts-spec.md `5.`-`6.`) to parse a
/// two-input postage-style burn transaction (overview.md `6.`), not a general-purpose
/// parser. DRAFT: only tested against that specific shape; other shapes (more inputs,
/// non-P2PKH scriptSigs, OP_PUSHDATA2+ pushes, non-canonical DER) are not handled and
/// will revert.
library EcashTx {
    struct Input {
        bytes32 prevoutHash;
        uint32 prevoutIndex;
        bytes scriptSig;
        uint32 sequence;
    }

    struct Output {
        uint64 value;
        bytes script;
    }

    struct Tx {
        uint32 version;
        Input[] inputs;
        Output[] outputs;
        uint32 locktime;
    }

    // secp256k1 field prime and curve parameter b (y^2 = x^3 + 7)
    uint256 private constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 private constant B = 7;

    // ==========================================================================
    // Transaction parsing
    // ==========================================================================

    function parse(bytes calldata raw) internal pure returns (Tx memory result) {
        uint256 offset = 0;

        result.version = readUint32LE(raw, offset);
        offset += 4;

        uint256 inputCount;
        (inputCount, offset) = readVarInt(raw, offset);
        result.inputs = new Input[](inputCount);
        for (uint256 i = 0; i < inputCount; i++) {
            Input memory inp;
            inp.prevoutHash = readBytes32(raw, offset);
            offset += 32;
            inp.prevoutIndex = readUint32LE(raw, offset);
            offset += 4;

            uint256 scriptLen;
            (scriptLen, offset) = readVarInt(raw, offset);
            inp.scriptSig = raw[offset:offset + scriptLen];
            offset += scriptLen;

            inp.sequence = readUint32LE(raw, offset);
            offset += 4;

            result.inputs[i] = inp;
        }

        uint256 outputCount;
        (outputCount, offset) = readVarInt(raw, offset);
        result.outputs = new Output[](outputCount);
        for (uint256 i = 0; i < outputCount; i++) {
            Output memory outp;
            outp.value = readUint64LE(raw, offset);
            offset += 8;

            uint256 scriptLen;
            (scriptLen, offset) = readVarInt(raw, offset);
            outp.script = raw[offset:offset + scriptLen];
            offset += scriptLen;

            result.outputs[i] = outp;
        }

        result.locktime = readUint32LE(raw, offset);
        offset += 4;
    }

    // ==========================================================================
    // Primitive readers
    // ==========================================================================

    function readUint32LE(bytes calldata data, uint256 offset) internal pure returns (uint32 value) {
        for (uint256 i = 0; i < 4; i++) {
            value |= uint32(uint8(data[offset + i])) << uint32(8 * i);
        }
    }

    function readUint64LE(bytes calldata data, uint256 offset) internal pure returns (uint64 value) {
        for (uint256 i = 0; i < 8; i++) {
            value |= uint64(uint8(data[offset + i])) << uint64(8 * i);
        }
    }

    /// @dev Straight byte-order copy (no reversal) -- matches how a 32-byte field is
    /// laid out in the source bytes.
    function readBytes32(bytes calldata data, uint256 offset) internal pure returns (bytes32 result) {
        for (uint256 i = 0; i < 32; i++) {
            result |= bytes32(uint256(uint8(data[offset + i]))) << (8 * (31 - i));
        }
    }

    /// @dev Bitcoin-style CompactSize varint.
    function readVarInt(bytes calldata data, uint256 offset) internal pure returns (uint256 value, uint256 newOffset) {
        uint8 first = uint8(data[offset]);
        if (first < 0xfd) {
            return (first, offset + 1);
        } else if (first == 0xfd) {
            value = uint256(uint8(data[offset + 1])) | (uint256(uint8(data[offset + 2])) << 8);
            return (value, offset + 3);
        } else if (first == 0xfe) {
            for (uint256 i = 0; i < 4; i++) {
                value |= uint256(uint8(data[offset + 1 + i])) << (8 * i);
            }
            return (value, offset + 5);
        } else {
            for (uint256 i = 0; i < 8; i++) {
                value |= uint256(uint8(data[offset + 1 + i])) << (8 * i);
            }
            return (value, offset + 9);
        }
    }

    // ==========================================================================
    // Script parsing
    // ==========================================================================

    /// @dev Reads one push (OP_0 zero-length push, direct push 0x01-0x4b, or
    /// OP_PUSHDATA1 0x4c) from a script held in memory. OP_PUSHDATA2+ is not
    /// supported (not needed for a signature or a compressed pubkey, both well
    /// under 76 bytes, nor for any SLP GENESIS/BURN field this library parses).
    function readPush(bytes memory script, uint256 offset) internal pure returns (bytes memory data, uint256 newOffset) {
        uint8 opcode = uint8(script[offset]);
        uint256 len;
        uint256 dataStart;

        if (opcode == 0) {
            len = 0;
            dataStart = offset + 1;
        } else if (opcode >= 1 && opcode <= 75) {
            len = opcode;
            dataStart = offset + 1;
        } else if (opcode == 0x4c) {
            len = uint8(script[offset + 1]);
            dataStart = offset + 2;
        } else {
            revert("EcashTx: unsupported push opcode");
        }

        data = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            data[i] = script[dataStart + i];
        }
        newOffset = dataStart + len;
    }

    /// @dev Extracts (signature-with-sighashtype-byte, pubkey) from a standard P2PKH
    /// scriptSig: `<push sig> <push pubkey>`.
    function extractSigAndPubkey(bytes memory scriptSig) internal pure returns (bytes memory sig, bytes memory pubkey) {
        uint256 offset = 0;
        (sig, offset) = readPush(scriptSig, offset);
        (pubkey, offset) = readPush(scriptSig, offset);
    }

    // ==========================================================================
    // DER signature parsing
    // ==========================================================================

    /// @dev Parses `0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s> <sighashtype>`.
    /// A leading 0x00 padding byte within r/s (DER's non-negativity rule) is handled
    /// implicitly: it contributes only to bit positions shifted out of a uint256 when
    /// present, which is harmless since it's always zero when it appears.
    function parseDER(bytes memory sigWithType) internal pure returns (uint256 r, uint256 s, uint8 sighashType) {
        require(uint8(sigWithType[0]) == 0x30, "EcashTx: not a DER sequence");
        uint256 offset = 2; // skip 0x30 and the total-length byte (assumes short-form length)

        require(uint8(sigWithType[offset]) == 0x02, "EcashTx: expected r marker");
        offset += 1;
        uint256 rLen = uint8(sigWithType[offset]);
        offset += 1;
        r = readBigEndianUint(sigWithType, offset, rLen);
        offset += rLen;

        require(uint8(sigWithType[offset]) == 0x02, "EcashTx: expected s marker");
        offset += 1;
        uint256 sLen = uint8(sigWithType[offset]);
        offset += 1;
        s = readBigEndianUint(sigWithType, offset, sLen);
        offset += sLen;

        sighashType = uint8(sigWithType[offset]);
    }

    function readBigEndianUint(bytes memory data, uint256 offset, uint256 len) internal pure returns (uint256 value) {
        for (uint256 i = 0; i < len; i++) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }

    // ==========================================================================
    // secp256k1 pubkey decompression and address derivation
    // ==========================================================================

    /// @dev Recovers (x, y) from a 33-byte compressed pubkey via y = sqrt(x^3+7) mod p,
    /// valid because secp256k1's p is 3 mod 4. Uses the MODEXP precompile (0x05).
    function decompress(bytes memory compressed) internal view returns (uint256 x, uint256 y) {
        require(compressed.length == 33, "EcashTx: expected compressed pubkey");
        uint8 prefix = uint8(compressed[0]);
        require(prefix == 0x02 || prefix == 0x03, "EcashTx: bad compressed pubkey prefix");

        for (uint256 i = 0; i < 32; i++) {
            x = (x << 8) | uint8(compressed[1 + i]);
        }

        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), B, P);
        y = modexp(rhs, (P + 1) / 4, P);
        // modexp yields a real square root only when rhs is a quadratic residue (i.e.
        // x is a genuine curve x-coordinate); for an off-curve x it returns a y with
        // y^2 == -rhs, a bogus point. Reject it rather than pass an off-curve (x,y) to
        // addressFromPubkey/verifyAgainstPubkey (2026-07 review, round 5 lead).
        require(mulmod(y, y, P) == rhs, "EcashTx: point not on curve");

        bool yIsOdd = (y & 1) == 1;
        bool wantOdd = prefix == 0x03;
        if (yIsOdd != wantOdd) {
            y = P - y;
        }
    }

    function modexp(uint256 base, uint256 exponent, uint256 modulus) internal view returns (uint256 result) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x20)
            mstore(add(ptr, 0x20), 0x20)
            mstore(add(ptr, 0x40), 0x20)
            mstore(add(ptr, 0x60), base)
            mstore(add(ptr, 0x80), exponent)
            mstore(add(ptr, 0xa0), modulus)
            let success := staticcall(gas(), 0x05, ptr, 0xc0, ptr, 0x20)
            if iszero(success) { revert(0, 0) }
            result := mload(ptr)
        }
    }

    /// @dev Ethereum-style address derived from a pubkey's (x, y): the same
    /// last-20-bytes-of-Keccak256 derivation packages/sdk's buildOutOracle already
    /// implements (script.ts), applied here to a compressed pubkey pulled from a
    /// scriptSig instead of one supplied directly by a caller.
    function addressFromPubkey(uint256 x, uint256 y) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(x, y)))));
    }

    /// @dev HASH160 = RIPEMD160(SHA256(data)), the standard P2PKH pubkey-hash.
    function hash160(bytes memory data) internal pure returns (bytes20) {
        return bytes20(ripemd160(abi.encodePacked(sha256(data))));
    }

    /// @dev Standard P2PKH scriptCode: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG.
    function p2pkhScriptCode(bytes20 pubkeyHash) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"76a914", pubkeyHash, hex"88ac");
    }

    /// @dev Verifies a (r, s) secp256k1 signature against a known pubkey by trying
    /// both possible recovery ids and checking either recovers to that pubkey's
    /// address -- since a scriptSig signature carries no explicit recovery id (P2PKH
    /// doesn't need one; the pubkey is provided directly), unlike the Authorizer's
    /// signature in BridgeLock.confirmDeposit, which is produced recoverable on purpose.
    function verifyAgainstPubkey(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y) internal pure returns (bool) {
        address expected = addressFromPubkey(x, y);
        return ecrecover(digest, 27, bytes32(r), bytes32(s)) == expected
            || ecrecover(digest, 28, bytes32(r), bytes32(s)) == expected;
    }
}

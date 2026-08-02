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
    ///
    /// A single calldataload, because the EVM word is already big-endian and this
    /// field is already 32 bytes: the byte-at-a-time loop this replaces was
    /// reassembling, one shift at a time, exactly the word the machine would have
    /// handed over whole. The bounds check the loop performed per index is explicit
    /// now, since calldataload past the end yields zeros rather than reverting.
    function readBytes32(bytes calldata data, uint256 offset) internal pure returns (bytes32 result) {
        require(offset + 32 <= data.length, "EcashTx: read runs past end of data");
        assembly ("memory-safe") {
            result := calldataload(add(data.offset, offset))
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

        // The byte-at-a-time copy this replaces carried an implicit bounds check on
        // every index -- a script claiming a 72-byte push while holding 40 bytes
        // panicked rather than reading on. The word-wise copy below has no such check,
        // so it is made explicit here. Without it a truncated scriptSig would read
        // whatever memory happens to follow and hand back a well-formed-looking
        // signature, which is the difference between a rejected burn and an accepted
        // forgery.
        require(dataStart + len <= script.length, "EcashTx: push runs past end of script");

        data = new bytes(len);

        // Word-wise rather than byte-wise: the old loop cost about 310 gas per byte,
        // and a signature plus a pubkey is ~106 of them on every one of release()'s two
        // inputs. Copying 32 at a time is the single largest saving available in this
        // library (see test/gasProfile.test.js).
        //
        // memory-safe: `new bytes(len)` allocates a 32-byte-aligned region, so writing
        // whole words up to the rounded-up length stays inside this allocation. The
        // final read may take up to 31 bytes from past the end of `script`, which lands
        // only in `data`'s own padding -- bytes beyond `len` that no reader of a
        // `bytes` value ever observes.
        assembly ("memory-safe") {
            let src := add(add(script, 0x20), dataStart)
            let dst := add(data, 0x20)
            for { let i := 0 } lt(i, len) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
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
        require(offset + len <= data.length, "EcashTx: read runs past end of data");
        if (len == 0) return 0;

        if (len >= 32) {
            // The loop this replaces shifted left once per byte, so with len > 32
            // everything before the final 32 bytes was pushed out of the uint256 and
            // discarded. That is not incidental -- DER encodes r and s as 33 bytes
            // whenever the leading bit would otherwise read as a sign, and the
            // discarded byte is exactly that 0x00 pad. Reading the last 32 bytes
            // produces the identical value; anything else would reject valid
            // signatures.
            assembly ("memory-safe") {
                value := mload(add(add(data, 0x20), add(offset, sub(len, 32))))
            }
        } else {
            assembly ("memory-safe") {
                value := shr(mul(8, sub(32, len)), mload(add(add(data, 0x20), offset)))
            }
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

        // Bytes 1..32 are a big-endian 32-byte integer, which is what an EVM word
        // already is -- so one mload, at the data start plus the prefix byte. The
        // length is required to be exactly 33 above, so this cannot overrun.
        assembly ("memory-safe") {
            x := mload(add(compressed, 0x21))
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

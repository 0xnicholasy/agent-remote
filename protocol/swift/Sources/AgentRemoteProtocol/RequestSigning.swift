import CryptoKit
import Foundation
import Security

/// Pure, CryptoKit-based signing helpers for the pairing and request-envelope protocol described
/// in docs/pairing-v0.md. Deliberately free of UIKit/WatchKit so it stays unit-testable on macOS.
///
/// Pairing v2: the Watch sends its X25519 public key, both sides derive a 3-digit confirmation
/// code from the handshake (commit-then-reveal, so a relay cannot choose keys after seeing the
/// other side's nonce), the operator confirms the Watch's own code matches, and only then does the
/// bridge register the device. Mirrors the bridge's TypeScript implementation byte for byte -- see
/// docs/pairing-v0.md, "Pairing code" section (renamed "Pairing" for v2) and "Enrollment".
public enum RequestSigning {
    /// `commit = hex(SHA256("agentremote-pair-commit-v2\n" + watchNonce))`.
    public static func commitment(watchNonce: String) -> String {
        hex(Data(SHA256.hash(data: Data("agentremote-pair-commit-v2\n\(watchNonce)".utf8))))
    }

    /// Checks a claimed commitment against the (now revealed) `watchNonce`. Provided for parity
    /// with the bridge's `checkCommitment`; the Watch itself never needs this (it only ever
    /// checks the bridge's derived code against its own, both already 3-digit integers).
    public static func checkCommitment(_ commit: String, watchNonce: String) -> Bool {
        commit == commitment(watchNonce: watchNonce)
    }

    /// `"agentremote-pair-confirm-v2\n" + bridgeId + "\n" + bridgePublicKey + "\n" +
    /// devicePublicKey + "\n" + bridgeNonce + "\n" + watchNonce`. Both sides must compute this
    /// identically -- see bridge/src/auth/pairing.ts's `pairTranscript`.
    public static func pairTranscript(
        bridgeId: String,
        bridgePublicKeyHex: String,
        devicePublicKeyHex: String,
        bridgeNonceHex: String,
        watchNonceHex: String
    ) -> String {
        "agentremote-pair-confirm-v2\n\(bridgeId)\n\(bridgePublicKeyHex)\n\(devicePublicKeyHex)\n\(bridgeNonceHex)\n\(watchNonceHex)"
    }

    /// `uint32be(SHA256(transcript)[0..4]) mod 900 + 100` -- a 3-digit code, 100..999.
    public static func confirmCode(transcript: String) -> Int {
        let digest = Data(SHA256.hash(data: Data(transcript.utf8)))
        let value = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return Int(value % 900) + 100
    }

    /// `X25519(ownPrivate, peerPublic)` as a CryptoKit `SharedSecret`, ready for
    /// `deriveDeviceKey(shared:transcript:)` below.
    public static func sharedSecret(
        privateKey: Curve25519.KeyAgreement.PrivateKey,
        peerPublicKeyHex: String
    ) throws -> SharedSecret {
        let peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(hex: peerPublicKeyHex))
        return try privateKey.sharedSecretFromKeyAgreement(with: peerPublicKey)
    }

    /// `deviceKey = HKDF-SHA256(ikm=shared, salt=SHA256(transcript), info="agentremote-device-key-v2", length 32)`.
    public static func deriveDeviceKey(shared: SharedSecret, transcript: String) -> SymmetricKey {
        let salt = Data(SHA256.hash(data: Data(transcript.utf8)))
        return shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: Data("agentremote-device-key-v2".utf8),
            outputByteCount: 32
        )
    }

    /// `"key_" + first 8 hex characters of SHA-256(deviceKey)`. Unchanged from pairing v1.
    public static func keyId(for deviceKey: SymmetricKey) -> String {
        let digest = deviceKey.withUnsafeBytes { SHA256.hash(data: Data($0)) }
        return "key_" + String(hex(Data(digest)).prefix(8))
    }

    /// The six-line signing string, joined by `\n` with no trailing newline. The path line is
    /// the request target exactly as sent, including any query string.
    public static func signingString(
        method: String,
        pathWithQuery: String,
        timestamp: String,
        nonce: String,
        bodySHA256: String
    ) -> String {
        [
            "v1",
            method.uppercased(),
            pathWithQuery,
            timestamp,
            nonce,
            bodySHA256,
        ].joined(separator: "\n")
    }

    /// `"v1=" + HMAC(deviceKey, signingString)`, hex-encoded lowercase.
    public static func signature(deviceKey: SymmetricKey, signingString: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(signingString.utf8), using: deviceKey)
        return "v1=" + hex(Data(mac))
    }

    /// SHA-256 of the raw request body, lowercase hex; SHA-256 of the empty string when there is
    /// no body.
    public static func bodySHA256(_ body: Data?) -> String {
        hex(Data(SHA256.hash(data: body ?? Data())))
    }

    /// `n` cryptographically random bytes, hex encoded lowercase. Used for nonces and device ids.
    public static func randomHex(bytes: Int) -> String {
        var data = Data(count: bytes)
        let status = data.withUnsafeMutableBytes { pointer in
            SecRandomCopyBytes(kSecRandomDefault, bytes, pointer.baseAddress!)
        }
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed with status \(status)")
        return hex(data)
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

extension Data {
    /// Decodes a lowercase (or uppercase) hex string into raw bytes. Traps on odd length or a
    /// non-hex character, mirroring the bridge's `Buffer.from(hex, "hex")` failure mode closely
    /// enough for this protocol layer -- callers pass wire-format hex, never free-form input.
    init(hex: String) {
        precondition(hex.count % 2 == 0, "hex string must have an even number of characters")
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index ..< next], radix: 16) else {
                preconditionFailure("invalid hex character in \(hex)")
            }
            bytes.append(byte)
            index = next
        }
        self = Data(bytes)
    }
}

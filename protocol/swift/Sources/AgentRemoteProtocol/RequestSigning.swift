import CryptoKit
import Foundation
import Security

/// Pairing code normalisation and formatting. Mirrors the bridge's TypeScript implementation
/// byte for byte -- see docs/pairing-v0.md, section "Pairing code".
public enum PairingCode {
    /// Crockford base32 without the check symbol.
    private static let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// Uppercase, map the Crockford aliases (I/L -> 1, O -> 0), then drop everything else,
    /// including the display dashes. Order matters: aliasing must run before stripping, or the
    /// aliased characters would be discarded as "outside the alphabet" first.
    public static func normalize(_ raw: String) -> String {
        var result = ""
        result.reserveCapacity(raw.count)
        for character in raw.uppercased() {
            let mapped: Character
            switch character {
            case "I", "L": mapped = "1"
            case "O": mapped = "0"
            default: mapped = character
            }
            if alphabet.contains(mapped) {
                result.append(mapped)
            }
        }
        return result
    }

    /// Groups a normalised 12-character code for display: `ABCD-EFGH-JKMN`.
    public static func format(_ normalized: String) -> String {
        let chars = Array(normalized)
        return stride(from: 0, to: chars.count, by: 4)
            .map { String(chars[$0 ..< min($0 + 4, chars.count)]) }
            .joined(separator: "-")
    }
}

/// Pure, CryptoKit-based signing helpers for the pairing and request-envelope protocol described
/// in docs/pairing-v0.md. Deliberately free of UIKit/WatchKit so it stays unit-testable on macOS.
public enum RequestSigning {
    /// `HMAC(code, "agentremote-pair-v1\n" + deviceId + "\n" + deviceName + "\n" + nonce)`,
    /// with the normalised pairing code used directly (UTF-8) as the HMAC key.
    public static func pairingProof(code: String, deviceId: String, deviceName: String, nonce: String) -> String {
        let message = "agentremote-pair-v1\n\(deviceId)\n\(deviceName)\n\(nonce)"
        let key = SymmetricKey(data: Data(code.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return hex(Data(mac))
    }

    /// `HKDF-SHA256(ikm: code, salt: deviceId + "\n" + nonce, info: "agentremote-device-key-v1", length: 32)`.
    public static func deriveDeviceKey(code: String, deviceId: String, nonce: String) -> SymmetricKey {
        let ikm = SymmetricKey(data: Data(code.utf8))
        let salt = Data("\(deviceId)\n\(nonce)".utf8)
        let info = Data("agentremote-device-key-v1".utf8)
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: info, outputByteCount: 32)
    }

    /// `"key_" + first 8 hex characters of SHA-256(deviceKey)`.
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

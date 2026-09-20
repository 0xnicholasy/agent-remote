import CryptoKit
import Foundation
import Security

/// The stored credential from a successful `/v1/pair` exchange. Once paired, every request
/// carries the four `X-AgentRemote-*` headers signed with `deviceKey`. See docs/pairing-v0.md.
struct DeviceCredential: Sendable, Equatable {
    var deviceId: String
    var keyId: String
    var deviceKeyData: Data
    var bridgeId: String
    var baseURL: URL

    var deviceKey: SymmetricKey { SymmetricKey(data: deviceKeyData) }
}

/// Storage seam for `DeviceCredential` so tests can substitute an in-memory store in place of
/// the Keychain.
protocol CredentialStore: Sendable {
    func load() -> DeviceCredential?
    func save(_ credential: DeviceCredential) throws
    func clear() throws
}

/// Surfaces a Keychain write/delete failure instead of letting it be swallowed, so a caller
/// can't believe pairing succeeded when the credential was never persisted.
enum CredentialStoreError: Error, CustomStringConvertible, Sendable, Equatable {
    case keychainWrite(OSStatus)
    case keychainDelete(OSStatus)
    case encodingFailed

    var description: String {
        switch self {
        case .keychainWrite(let status): "Keychain write failed (OSStatus \(status))."
        case .keychainDelete(let status): "Keychain delete failed (OSStatus \(status))."
        case .encodingFailed: "Failed to encode the device credential for storage."
        }
    }
}

/// Keychain-backed credential store. Never logs key material.
final class KeychainCredentialStore: CredentialStore, @unchecked Sendable {
    private static let service = "com.agentremote.watch"
    private static let account = "device-credential"

    private struct Wire: Codable {
        var deviceId: String
        var keyId: String
        var deviceKeyHex: String
        var bridgeId: String
        var baseURL: String
    }

    func load() -> DeviceCredential? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data),
              let keyData = Data(hexEncoded: wire.deviceKeyHex),
              let url = URL(string: wire.baseURL)
        else { return nil }
        return DeviceCredential(
            deviceId: wire.deviceId,
            keyId: wire.keyId,
            deviceKeyData: keyData,
            bridgeId: wire.bridgeId,
            baseURL: url
        )
    }

    func save(_ credential: DeviceCredential) throws {
        let wire = Wire(
            deviceId: credential.deviceId,
            keyId: credential.keyId,
            deviceKeyHex: credential.deviceKeyData.hexEncodedString(),
            bridgeId: credential.bridgeId,
            baseURL: credential.baseURL.absoluteString
        )
        guard let data = try? JSONEncoder().encode(wire) else {
            throw CredentialStoreError.encodingFailed
        }

        let deleteStatus = SecItemDelete(baseQuery() as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw CredentialStoreError.keychainDelete(deleteStatus)
        }
        var addQuery = baseQuery()
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw CredentialStoreError.keychainWrite(addStatus)
        }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychainDelete(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
    }
}

/// In-memory credential store for tests and previews.
final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private var stored: DeviceCredential?

    init(_ initial: DeviceCredential? = nil) {
        stored = initial
    }

    func load() -> DeviceCredential? { stored }
    func save(_ credential: DeviceCredential) { stored = credential }
    func clear() { stored = nil }
}

extension Data {
    init?(hexEncoded string: String) {
        guard string.count.isMultiple(of: 2) else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(string.count / 2)
        var index = string.startIndex
        while index < string.endIndex {
            let next = string.index(index, offsetBy: 2)
            guard let byte = UInt8(string[index ..< next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self = Data(bytes)
    }

    func hexEncodedString() -> String {
        map { String(format: "%02x", $0) }.joined()
    }
}

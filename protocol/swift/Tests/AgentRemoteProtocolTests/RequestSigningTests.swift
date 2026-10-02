import CryptoKit
import Foundation
import Testing

@testable import AgentRemoteProtocol

// Fixed vector shared with the bridge's TypeScript tests (bridge/src/auth/vector.test.ts) so both
// implementations can be cross-checked against the same numbers. See docs/pairing-v0.md. The two
// X25519 key pairs are reconstructed from fixed raw private scalars (0x11/0x22 repeated) purely so
// this vector is deterministic; production key pairs are always freshly random.
private let vectorBridgeId = "brg_9f2c4a1b"
private let vectorBridgeNonceHex = "00112233445566778899aabbccddeeff"
private let vectorWatchNonceHex = "aabbccddeeff00112233445566778899"
private let vectorBridgePrivateScalarHex = String(repeating: "11", count: 32)
private let vectorDevicePrivateScalarHex = String(repeating: "22", count: 32)
private let vectorBridgePublicKeyHex = "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13"
private let vectorDevicePublicKeyHex = "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20"
private let vectorCommit = "44451b47ea1548fd1831d57eaedcda2cdbf53014acf86792e29b0b9459938068"
private let vectorCode = 487
private let vectorDeviceKeyHex = "bc6bd2bbeea0b02933e110b3082774c163d7574cd28a17650e4b6c4c4c35c781"
private let vectorKeyId = "key_4217872d"

private func privateKey(fromScalarHex hex: String) -> Curve25519.KeyAgreement.PrivateKey {
    // swiftlint:disable:next force_try
    try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(hex: hex))
}

@Suite("Pairing v2: commitment and confirmation code")
struct PairingCommitmentTests {
    @Test func commitmentIsDeterministicAndMatchesTheFixedVector() {
        let commit = RequestSigning.commitment(watchNonce: vectorWatchNonceHex)
        #expect(commit == vectorCommit)
        #expect(RequestSigning.checkCommitment(commit, watchNonce: vectorWatchNonceHex))
        #expect(!RequestSigning.checkCommitment(commit, watchNonce: vectorBridgeNonceHex))
    }

    @Test func confirmCodeIsAlwaysThreeDigits() {
        for i in 0..<50 {
            let code = RequestSigning.confirmCode(transcript: "transcript-\(i)")
            #expect(code >= 100 && code <= 999)
        }
    }
}

@Suite("Pairing v2 fixed vector")
struct PairingVectorTests {
    @Test func fixedScalarsProduceTheDocumentedPublicKeys() {
        let bridgeKey = privateKey(fromScalarHex: vectorBridgePrivateScalarHex)
        let deviceKey = privateKey(fromScalarHex: vectorDevicePrivateScalarHex)
        #expect(bridgeKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined() == vectorBridgePublicKeyHex)
        #expect(deviceKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined() == vectorDevicePublicKeyHex)
    }

    @Test func transcriptCodeAndDeviceKeyMatchTheDocumentedLiterals() throws {
        let bridgeKey = privateKey(fromScalarHex: vectorBridgePrivateScalarHex)
        let deviceKey = privateKey(fromScalarHex: vectorDevicePrivateScalarHex)

        let transcript = RequestSigning.pairTranscript(
            bridgeId: vectorBridgeId,
            bridgePublicKeyHex: vectorBridgePublicKeyHex,
            devicePublicKeyHex: vectorDevicePublicKeyHex,
            bridgeNonceHex: vectorBridgeNonceHex,
            watchNonceHex: vectorWatchNonceHex
        )
        let expectedTranscript = [
            "agentremote-pair-confirm-v2",
            vectorBridgeId,
            vectorBridgePublicKeyHex,
            vectorDevicePublicKeyHex,
            vectorBridgeNonceHex,
            vectorWatchNonceHex,
        ].joined(separator: "\n")
        #expect(transcript == expectedTranscript)
        #expect(RequestSigning.confirmCode(transcript: transcript) == vectorCode)

        let sharedFromBridge = try RequestSigning.sharedSecret(privateKey: bridgeKey, peerPublicKeyHex: vectorDevicePublicKeyHex)
        let sharedFromDevice = try RequestSigning.sharedSecret(privateKey: deviceKey, peerPublicKeyHex: vectorBridgePublicKeyHex)

        let keyFromBridge = RequestSigning.deriveDeviceKey(shared: sharedFromBridge, transcript: transcript)
        let keyFromDevice = RequestSigning.deriveDeviceKey(shared: sharedFromDevice, transcript: transcript)
        let keyFromBridgeHex = keyFromBridge.withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()
        let keyFromDeviceHex = keyFromDevice.withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()

        #expect(keyFromBridgeHex == vectorDeviceKeyHex)
        #expect(keyFromDeviceHex == vectorDeviceKeyHex)
        #expect(RequestSigning.keyId(for: keyFromBridge) == vectorKeyId)
    }
}

@Suite("Signing string and signature")
struct SigningStringTests {
    private static let vectorMethod = "POST"
    private static let vectorPath = "/v1/commands"
    private static let vectorTimestamp = "2026-09-20T10:15:00.000Z"
    private static let vectorNonce = "00112233445566778899aabbccddeeff"
    private static let vectorBody = Data(#"{"a":1}"#.utf8)

    @Test func signingStringMatchesFixedVector() {
        let bodyHash = RequestSigning.bodySHA256(Self.vectorBody)
        let signingString = RequestSigning.signingString(
            method: Self.vectorMethod,
            pathWithQuery: Self.vectorPath,
            timestamp: Self.vectorTimestamp,
            nonce: Self.vectorNonce,
            bodySHA256: bodyHash
        )
        let expected = """
        v1
        POST
        /v1/commands
        2026-09-20T10:15:00.000Z
        00112233445566778899aabbccddeeff
        015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862
        """
        #expect(signingString == expected)
    }

    @Test func signatureUsingTheV2DeviceKeyHasTheDocumentedShape() throws {
        let bridgeKey = privateKey(fromScalarHex: vectorBridgePrivateScalarHex)
        let shared = try RequestSigning.sharedSecret(privateKey: bridgeKey, peerPublicKeyHex: vectorDevicePublicKeyHex)
        let transcript = RequestSigning.pairTranscript(
            bridgeId: vectorBridgeId,
            bridgePublicKeyHex: vectorBridgePublicKeyHex,
            devicePublicKeyHex: vectorDevicePublicKeyHex,
            bridgeNonceHex: vectorBridgeNonceHex,
            watchNonceHex: vectorWatchNonceHex
        )
        let deviceKey = RequestSigning.deriveDeviceKey(shared: shared, transcript: transcript)
        let bodyHash = RequestSigning.bodySHA256(Self.vectorBody)
        let signingString = RequestSigning.signingString(
            method: Self.vectorMethod,
            pathWithQuery: Self.vectorPath,
            timestamp: Self.vectorTimestamp,
            nonce: Self.vectorNonce,
            bodySHA256: bodyHash
        )
        let signature = RequestSigning.signature(deviceKey: deviceKey, signingString: signingString)
        #expect(signature.hasPrefix("v1="))
        #expect(signature.count == 67)
    }

    @Test func emptyBodyHashesToTheEmptyStringDigest() {
        #expect(RequestSigning.bodySHA256(nil) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }
}

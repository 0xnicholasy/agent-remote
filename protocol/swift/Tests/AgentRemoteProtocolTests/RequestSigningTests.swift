import CryptoKit
import Foundation
import Testing

@testable import AgentRemoteProtocol

// Fixed vector shared with the bridge's TypeScript tests so both implementations can be
// cross-checked against the same numbers. See docs/pairing-v0.md.
private let vectorCode = "ABCDEFGHJKMN"
private let vectorDeviceId = "dev_9f2c4a1b7d3e5061"
private let vectorDeviceName = "Test Watch"
private let vectorNonce = "00112233445566778899aabbccddeeff"
private let vectorMethod = "POST"
private let vectorPath = "/v1/commands"
private let vectorTimestamp = "2026-09-20T10:15:00.000Z"
private let vectorBody = Data(#"{"a":1}"#.utf8)

@Suite("PairingCode normalisation")
struct PairingCodeTests {
    @Test func stripsDashesAndUppercases() {
        #expect(PairingCode.normalize("abcd-efgh-jkmn") == "ABCDEFGHJKMN")
    }

    @Test func mapsCrockfordAliases() {
        // I/L -> 1, O -> 0.
        #expect(PairingCode.normalize("ILO") == "110")
        #expect(PairingCode.normalize("il-oo-xx") == "1100XX")
    }

    @Test func stripsCharactersOutsideTheAlphabet() {
        // U is not in the Crockford alphabet used here and has no alias, so it is dropped.
        #expect(PairingCode.normalize("AU BZ!!") == "ABZ")
    }

    @Test func formatsAsFourFourFourGroups() {
        #expect(PairingCode.format("ABCDEFGHJKMN") == "ABCD-EFGH-JKMN")
    }
}

@Suite("Pairing proof and device key derivation")
struct PairingCryptoTests {
    @Test func proofIsDeterministic() {
        let first = RequestSigning.pairingProof(
            code: vectorCode, deviceId: vectorDeviceId, deviceName: vectorDeviceName, nonce: vectorNonce
        )
        let second = RequestSigning.pairingProof(
            code: vectorCode, deviceId: vectorDeviceId, deviceName: vectorDeviceName, nonce: vectorNonce
        )
        #expect(first == second)
    }

    @Test func proofMatchesFixedVector() {
        let proof = RequestSigning.pairingProof(
            code: vectorCode, deviceId: vectorDeviceId, deviceName: vectorDeviceName, nonce: vectorNonce
        )
        #expect(proof == "7a7c4223ee9042311a66a05098b446d4db027b9c498f2dff2acdef6b88e925ae")
    }

    @Test func sameInputsAgreeOnDeviceKey() {
        let a = RequestSigning.deriveDeviceKey(code: vectorCode, deviceId: vectorDeviceId, nonce: vectorNonce)
        let b = RequestSigning.deriveDeviceKey(code: vectorCode, deviceId: vectorDeviceId, nonce: vectorNonce)
        #expect(a.dataRepresentation == b.dataRepresentation)
    }

    @Test func differentNonceProducesADifferentKey() {
        let a = RequestSigning.deriveDeviceKey(code: vectorCode, deviceId: vectorDeviceId, nonce: vectorNonce)
        let b = RequestSigning.deriveDeviceKey(
            code: vectorCode, deviceId: vectorDeviceId, nonce: "ffffffffffffffffffffffffffffffff"
        )
        #expect(a.dataRepresentation != b.dataRepresentation)
    }

    @Test func keyIdMatchesFixedVector() {
        let key = RequestSigning.deriveDeviceKey(code: vectorCode, deviceId: vectorDeviceId, nonce: vectorNonce)
        #expect(RequestSigning.keyId(for: key) == "key_cd7749ef")
    }
}

@Suite("Signing string and signature")
struct SigningStringTests {
    @Test func signingStringMatchesFixedVector() {
        let bodyHash = RequestSigning.bodySHA256(vectorBody)
        let signingString = RequestSigning.signingString(
            method: vectorMethod,
            pathWithQuery: vectorPath,
            timestamp: vectorTimestamp,
            nonce: vectorNonce,
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

    @Test func signatureMatchesFixedVector() {
        let key = RequestSigning.deriveDeviceKey(code: vectorCode, deviceId: vectorDeviceId, nonce: vectorNonce)
        let bodyHash = RequestSigning.bodySHA256(vectorBody)
        let signingString = RequestSigning.signingString(
            method: vectorMethod,
            pathWithQuery: vectorPath,
            timestamp: vectorTimestamp,
            nonce: vectorNonce,
            bodySHA256: bodyHash
        )
        let signature = RequestSigning.signature(deviceKey: key, signingString: signingString)
        #expect(signature == "v1=e1702c4ff741df5df3e1dd59f0819a1a9f4bf56ee2dee410aa6dfac763b13032")
    }

    @Test func emptyBodyHashesToTheEmptyStringDigest() {
        #expect(RequestSigning.bodySHA256(nil) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }
}

private extension SymmetricKey {
    var dataRepresentation: Data { withUnsafeBytes { Data($0) } }
}

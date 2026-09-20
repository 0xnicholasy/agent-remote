import XCTest
import AgentRemoteProtocol

/// Covers the client-side pieces of M3 slice 1 that do not need a live bridge: signed-request
/// header construction, the unpaired failure mode, and the bridge error-code mapping. See
/// docs/pairing-v0.md.
final class BridgeClientAuthTests: XCTestCase {
    private func makeCredential() -> DeviceCredential {
        let key = RequestSigning.deriveDeviceKey(
            code: "ABCDEFGHJKMN", deviceId: "dev_9f2c4a1b7d3e5061", nonce: "00112233445566778899aabbccddeeff"
        )
        return DeviceCredential(
            deviceId: "dev_9f2c4a1b7d3e5061",
            keyId: "key_cd7749ef",
            deviceKeyData: key.withUnsafeBytes { Data($0) },
            bridgeId: "brg_12345678",
            baseURL: URL(string: "http://localhost:8787")!
        )
    }

    func testUnpairedRequestsFailWithoutHittingTheNetwork() async {
        let client = BridgeClient(credentialStore: InMemoryCredentialStore())

        do {
            _ = try await client.events(after: 0, wait: 0)
            XCTFail("expected .notPaired")
        } catch BridgeError.notPaired {
            // expected
        } catch {
            XCTFail("expected .notPaired, got \(error)")
        }

        do {
            try await client.send(.sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")), sessionId: "s")
            XCTFail("expected .notPaired")
        } catch BridgeError.notPaired {
            // expected
        } catch {
            XCTFail("expected .notPaired, got \(error)")
        }
    }

    func testSignedRequestCarriesTheFourHeadersAndAVerifiableSignature() async throws {
        let credential = makeCredential()
        let client = BridgeClient(credentialStore: InMemoryCredentialStore(credential))

        let url = URL(string: "http://localhost:8787/v1/events?after=3&wait=25")!
        let request = try await client.signedRequest(method: "GET", url: url, body: nil)

        let device = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Device"))
        let timestamp = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Timestamp"))
        let nonce = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Nonce"))
        let signature = try XCTUnwrap(request.value(forHTTPHeaderField: "X-AgentRemote-Signature"))

        XCTAssertEqual(device, credential.deviceId)
        XCTAssertEqual(nonce.count, 32)
        XCTAssertTrue(signature.hasPrefix("v1="))
        XCTAssertEqual(signature.count, 3 + 64)

        // The path line must be the request target exactly as sent, including the query string.
        let expectedSigningString = RequestSigning.signingString(
            method: "GET",
            pathWithQuery: "/v1/events?after=3&wait=25",
            timestamp: timestamp,
            nonce: nonce,
            bodySHA256: RequestSigning.bodySHA256(nil)
        )
        let expectedSignature = RequestSigning.signature(deviceKey: credential.deviceKey, signingString: expectedSigningString)
        XCTAssertEqual(signature, expectedSignature)
    }

    func testSigningIsFreshPerRequest() async throws {
        let client = BridgeClient(credentialStore: InMemoryCredentialStore(makeCredential()))
        let url = URL(string: "http://localhost:8787/v1/sessions")!

        let first = try await client.signedRequest(method: "GET", url: url, body: nil)
        let second = try await client.signedRequest(method: "GET", url: url, body: nil)

        XCTAssertNotEqual(
            first.value(forHTTPHeaderField: "X-AgentRemote-Nonce"),
            second.value(forHTTPHeaderField: "X-AgentRemote-Nonce")
        )
    }

    func testErrorCodeMapping() {
        XCTAssertEqual(BridgeError.from(status: 401, code: "unauthenticated", message: ""), .unauthenticated)
        XCTAssertEqual(BridgeError.from(status: 403, code: "device_revoked", message: ""), .deviceRevoked)
        XCTAssertEqual(BridgeError.from(status: 401, code: "stale_request", message: ""), .staleRequest)
        XCTAssertEqual(BridgeError.from(status: 401, code: "replayed_request", message: ""), .replayedRequest)
        XCTAssertEqual(BridgeError.from(status: 403, code: "action_not_allowed", message: ""), .actionNotAllowed)
        XCTAssertEqual(BridgeError.from(status: 403, code: "project_not_allowed", message: ""), .projectNotAllowed)
        XCTAssertEqual(BridgeError.from(status: 410, code: "decision_expired", message: ""), .decisionExpired)
        XCTAssertEqual(BridgeError.from(status: 409, code: "command_id_conflict", message: ""), .commandIdConflict)
        // Unknown/pre-existing codes fall back to the generic case so old 409 handling still works.
        XCTAssertEqual(BridgeError.from(status: 409, code: nil, message: "stale binding"), .http(status: 409, message: "stale binding"))
    }
}

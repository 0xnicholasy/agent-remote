import XCTest
import AgentRemoteProtocol

/// A stand-in bridge client that never touches the network. `sendResult` controls what the
/// next `send` call returns or throws, so a test can pick exactly one outcome per decision.
actor FakeBridgeClient: BridgeClientProtocol {
    enum SendResult {
        case success(CommandResponse)
        case failure(any Error & Sendable)
    }

    private var sendResult: SendResult = .success(CommandResponse())

    func setSendResult(_ result: SendResult) {
        sendResult = result
    }

    func setBaseURL(_ url: URL) async {}

    func events(after: Int, wait: Int) async throws -> EventsPage {
        EventsPage(events: [], lastEventId: after, skipped: 0)
    }

    func send(_ payload: CommandPayload, sessionId: String) async throws -> CommandResponse {
        switch sendResult {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }
}

/// Covers the 409-versus-retry contract of `approve`/`reject`/`answer`: a stale binding (409)
/// clears the pending card with a status line, any other failure keeps the card for retry, and
/// success clears it.
@MainActor
final class SessionStoreDecisionTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decodeEvent(_ json: String) throws -> AgentEvent {
        try decoder.decode(AgentEvent.self, from: Data(json.utf8))
    }

    /// Builds a store already bound to "sess_1" with a pending approval card, backed by a
    /// fake client whose next `send` result is under the test's control.
    private func makeStoreWithPendingApproval() async throws -> (SessionStore, FakeBridgeClient) {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)

        let started = try decodeEvent("""
        {
            "eventId": 1, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        store.apply(started)

        let approvalRequested = try decodeEvent("""
        {
            "eventId": 2, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:01.000Z", "type": "approval.requested",
            "payload": {
                "binding": {
                    "approvalId": "appr_1", "sessionId": "sess_1", "turnId": "turn_1",
                    "toolCallId": "tool_1", "actionDigest": "digest",
                    "expiresAt": "2026-09-17T00:05:00.000Z"
                },
                "kind": "command",
                "title": "Run git push origin main"
            }
        }
        """)
        store.apply(approvalRequested)

        XCTAssertNotNil(store.pendingApproval, "setup should leave a pending approval card")
        return (store, client)
    }

    func testStaleBindingClearsCardAndSetsStatus() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 409, message: "stale binding")))

        await store.approve()

        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.statusKind, .requestInvalid)
        XCTAssertFalse(store.isSending)
    }

    func testOtherFailureKeepsCardAndReenablesButtons() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 500, message: "boom")))

        await store.reject()

        XCTAssertNotNil(store.pendingApproval)
        XCTAssertEqual(store.statusKind, .error)
        XCTAssertFalse(store.isSending)
    }

    func testSuccessClearsCard() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))

        await store.approve()

        XCTAssertNil(store.pendingApproval)
        XCTAssertFalse(store.isSending)
    }
}

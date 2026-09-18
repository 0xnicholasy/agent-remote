import XCTest
import AgentRemoteProtocol

/// A stand-in bridge client that never touches the network. `sendResult` controls what the
/// next `send` call returns or throws, so a test can pick exactly one outcome per decision.
actor FakeBridgeClient: BridgeClientProtocol {
    enum SendResult {
        case success(CommandResponse)
        case failure(any Error & Sendable)
    }

    struct RecordedSend {
        let payload: CommandPayload
        let sessionId: String
    }

    private var sendResult: SendResult = .success(CommandResponse())
    /// One page per call, returned in order; the last one repeats once the list is exhausted.
    private var eventsResults: [Result<EventsPage, any Error & Sendable>] = []
    private(set) var sentCalls: [RecordedSend] = []

    func setSendResult(_ result: SendResult) {
        sendResult = result
    }

    /// Queues the pages/errors `events(after:wait:)` returns on successive calls.
    func setEventsResults(_ results: [Result<EventsPage, any Error & Sendable>]) {
        eventsResults = results
    }

    func setBaseURL(_ url: URL) async {}

    func events(after: Int, wait: Int) async throws -> EventsPage {
        guard !eventsResults.isEmpty else {
            return EventsPage(events: [], lastEventId: after, skipped: 0)
        }
        let result = eventsResults.count > 1 ? eventsResults.removeFirst() : eventsResults[0]
        switch result {
        case .success(let page): return page
        case .failure(let error): throw error
        }
    }

    func send(_ payload: CommandPayload, sessionId: String) async throws -> CommandResponse {
        sentCalls.append(RecordedSend(payload: payload, sessionId: sessionId))
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

    /// Locks in that decisions are scoped to the approval's own binding, not whatever the
    /// store's `sessionId` happens to be -- a regression here would send to the wrong session.
    func testApproveSendsRequestSessionId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()

        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.sessionId, "sess_1")
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

    /// Regression for E-003: after reconnect() drops the old binding, a session.started for a
    /// different id must be applied instead of silently dropped by the cross-session guard.
    func testReconnectAllowsNewSessionToRebind() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()
        XCTAssertEqual(store.sessionId, "sess_1")

        await store.reconnect()
        XCTAssertNil(store.sessionId)
        XCTAssertNil(store.pendingApproval)

        let started = try decodeEvent("""
        {
            "eventId": 10, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-17T00:10:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        store.apply(started)

        XCTAssertEqual(store.sessionId, "sess_2")
    }

    /// Regression for E-004: once a session completes, a later session.started for a new id
    /// must rebind rather than being dropped by the guard forever.
    func testSessionCompletedAllowsLaterSessionToRebind() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let completed = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "session.completed",
            "payload": { "reason": "completed" }
        }
        """)
        store.apply(completed)
        XCTAssertNil(store.sessionId)

        let started = try decodeEvent("""
        {
            "eventId": 4, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-17T00:03:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        store.apply(started)

        XCTAssertEqual(store.sessionId, "sess_2")
    }

    /// Regression for E-005: a clean page with nothing skipped should report .connected.
    func testPollLoopReportsConnected() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
        ])

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.statusKind, .connected)
    }

    /// Regression for E-005: a page reporting skipped (undecodable) events should report
    /// .skippedEvents, the state RootView branches its status line on.
    func testPollLoopReportsSkippedEvents() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 0, skipped: 2)),
        ])

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.statusKind, .skippedEvents)
    }

    /// Regression for E-005: when events() throws, the poll loop should report .reconnecting.
    func testPollLoopReportsReconnectingOnFailure() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)
        await client.setEventsResults([
            .failure(BridgeError.http(status: 500, message: "boom")),
        ])

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.statusKind, .reconnecting)
    }
}

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
    private var eventsCallCount = 0
    /// When set, the events() call at this 1-based count suspends until `openGate()` is
    /// called, so a test can simulate a network response that lands late (e.g. after a
    /// reconnect superseded the task that issued it).
    private var gateAtCall: Int?
    private var gateOpened = false
    private var gateContinuation: CheckedContinuation<Void, Never>?
    /// Same idea as the events() gate above, but for send() -- lets a test hold a
    /// createSession() response in flight while a reconnect() runs concurrently.
    private var sendGateAtCall: Int?
    private var sendGateOpened = false
    private var sendGateContinuation: CheckedContinuation<Void, Never>?
    private var sendCallCount = 0

    func setSendResult(_ result: SendResult) {
        sendResult = result
    }

    /// Queues the pages/errors `events(after:wait:)` returns on successive calls.
    func setEventsResults(_ results: [Result<EventsPage, any Error & Sendable>]) {
        eventsResults = results
    }

    /// Arms the events() call at `callNumber` (1-based) to block until `openGate()` runs.
    func gateEventsCall(_ callNumber: Int) {
        gateAtCall = callNumber
    }

    func openGate() {
        gateOpened = true
        gateContinuation?.resume()
        gateContinuation = nil
    }

    /// Arms the send() call at `callNumber` (1-based) to block until `openSendGate()` runs.
    func gateSendCall(_ callNumber: Int) {
        sendGateAtCall = callNumber
    }

    func openSendGate() {
        sendGateOpened = true
        sendGateContinuation?.resume()
        sendGateContinuation = nil
    }

    func setBaseURL(_ url: URL) async {}
    func pair(code: String, deviceName: String) async throws {}
    func isPaired() async -> Bool { true }

    func events(after: Int, wait: Int) async throws -> EventsPage {
        eventsCallCount += 1
        let currentCall = eventsCallCount
        let result: Result<EventsPage, any Error & Sendable>
        if eventsResults.isEmpty {
            result = .success(EventsPage(events: [], lastEventId: after, skipped: 0))
        } else if eventsResults.count > 1 {
            result = eventsResults.removeFirst()
        } else {
            result = eventsResults[0]
        }
        if gateAtCall == currentCall {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if gateOpened {
                    continuation.resume()
                } else {
                    gateContinuation = continuation
                }
            }
        }
        switch result {
        case .success(let page): return page
        case .failure(let error): throw error
        }
    }

    func send(_ payload: CommandPayload, sessionId: String) async throws -> CommandResponse {
        sentCalls.append(RecordedSend(payload: payload, sessionId: sessionId))
        sendCallCount += 1
        let currentCall = sendCallCount
        if sendGateAtCall == currentCall {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if sendGateOpened {
                    continuation.resume()
                } else {
                    sendGateContinuation = continuation
                }
            }
        }
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

    /// Builds a store already bound to "sess_1" with a pending question card, backed by a
    /// fake client whose next `send` result is under the test's control.
    private func makeStoreWithPendingQuestion() async throws -> (SessionStore, FakeBridgeClient) {
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

        let questionRequested = try decodeEvent("""
        {
            "eventId": 2, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:01.000Z", "type": "question.requested",
            "payload": {
                "questionId": "q_1", "turnId": "turn_1", "text": "Continue?",
                "options": [{ "id": "yes", "label": "Yes" }],
                "allowFreeText": true
            }
        }
        """)
        store.apply(questionRequested)

        XCTAssertNotNil(store.pendingQuestion, "setup should leave a pending question card")
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

    /// Regression for R-008: a poll task superseded by reconnect() must not be able to
    /// re-bind sessionId when its in-flight request finally resolves.
    func testStalePollGenerationDoesNotRebindAfterReconnect() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)

        let sessionAStarted = try decodeEvent("""
        {
            "eventId": 1, "sessionId": "sess_a", "provider": "mock",
            "timestamp": "2026-09-17T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        let staleSessionAStarted = try decodeEvent("""
        {
            "eventId": 2, "sessionId": "sess_a", "provider": "mock",
            "timestamp": "2026-09-17T00:00:01.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)

        // Call 1 (generation 1) binds sess_a. Call 2 (generation 1, still) is gated so it
        // stays in flight while reconnect() moves the store to generation 2. Call 3+
        // (generation 2) sees an empty page, so generation 2 never rebinds on its own.
        await client.setEventsResults([
            .success(EventsPage(events: [sessionAStarted], lastEventId: 1, skipped: 0)),
            .success(EventsPage(events: [staleSessionAStarted], lastEventId: 2, skipped: 0)),
            .success(EventsPage(events: [], lastEventId: 2, skipped: 0)),
        ])
        await client.gateEventsCall(2)

        store.start()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.sessionId, "sess_a")

        await store.reconnect()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertNil(store.sessionId)

        // Let the gated (generation 1) call finally resolve with sess_a's session.started.
        await client.openGate()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertNil(store.sessionId, "a stale generation's late response must not rebind sessionId")
    }

    /// Regression for R-007: a session ending while a card is pending must clear that card
    /// too, or answer()/approve() would silently no-op forever once sessionId is nil.
    func testSessionCompletedClearsPendingApproval() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let completed = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "session.completed",
            "payload": { "reason": "completed" }
        }
        """)
        store.apply(completed)

        XCTAssertNil(store.pendingApproval)
    }

    /// Regression for the round-2 critical finding: createSession()'s response can land after
    /// reconnect() has already bumped pollGeneration and cleared sessionId. The stale create
    /// must not rebind sessionId to a session the new generation knows nothing about.
    func testCreateSessionDoesNotRebindAfterConcurrentReconnect() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)
        await client.setSendResult(.success(CommandResponse(sessionId: "sess_created")))
        await client.gateSendCall(1)

        let createTask = Task { await store.createSession() }
        // Give createSession() a chance to reach the gated send before reconnect() runs.
        try await Task.sleep(for: .milliseconds(20))

        await store.reconnect()
        XCTAssertNil(store.sessionId)

        await client.openSendGate()
        let created = await createTask.value

        XCTAssertNil(created, "a rejected rebind must not hand back the stale id as if it were bound")
        XCTAssertNil(store.sessionId, "a stale generation's create response must not rebind sessionId")
    }

    /// Regression for the round-2 high finding: a bridge restart (event cursor rollback) must
    /// clear the session binding and any pending card the same way reconnect() does, or the
    /// store stays bound to a dead session with a stuck approval.
    func testBridgeRestartRollbackClearsSessionAndPendingApproval() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        XCTAssertEqual(store.sessionId, "sess_1")
        XCTAssertNotNil(store.pendingApproval)
        XCTAssertEqual(store.turnState, .waiting)

        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 100_000, skipped: 0)),
            .success(EventsPage(events: [], lastEventId: 1, skipped: 0)),
        ])

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(store.sessionId, "bridge restart must drop the dead session's binding")
        XCTAssertNil(store.pendingApproval, "bridge restart must not leave a stuck approval card")
        XCTAssertEqual(store.turnState, .idle, "bridge restart must not leave a stale waiting/thinking pill")
    }

    /// Regression for R-014: a 409 for a stale approve() must not stomp the status line for a
    /// newer, still-valid card that replaced it while the send was in flight.
    func testStale409DoesNotStompNewerCardStatus() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 409, message: "stale binding")))
        await client.gateSendCall(1)

        let approveTask = Task { await store.approve() }
        // Give approve() a chance to reach the gated send before the newer card arrives.
        try await Task.sleep(for: .milliseconds(20))

        let newerApprovalRequested = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "approval.requested",
            "payload": {
                "binding": {
                    "approvalId": "appr_2", "sessionId": "sess_1", "turnId": "turn_1",
                    "toolCallId": "tool_2", "actionDigest": "digest",
                    "expiresAt": "2026-09-17T00:05:00.000Z"
                },
                "kind": "command",
                "title": "Run git push origin main --force"
            }
        }
        """)
        store.apply(newerApprovalRequested)
        let statusLineBeforeStale409 = store.statusLine

        await client.openSendGate()
        await approveTask.value

        XCTAssertEqual(store.pendingApproval?.binding.approvalId, "appr_2", "the newer card must survive the stale 409")
        XCTAssertEqual(store.statusLine, statusLineBeforeStale409, "the newer card's status line must not be stomped by the stale 409")
        XCTAssertNotEqual(store.statusKind, .requestInvalid)
    }

    /// Regression for R-026: a stale 409 for answer(optionId:) must not stomp the status line
    /// for a newer, still-valid question card that replaced it while the send was in flight.
    func testAnswerOptionIdStale409DoesNotStompNewerCardStatus() async throws {
        let (store, client) = try await makeStoreWithPendingQuestion()
        await client.setSendResult(.failure(BridgeError.http(status: 409, message: "stale binding")))
        await client.gateSendCall(1)

        let answerTask = Task { await store.answer(optionId: "yes") }
        // Give answer() a chance to reach the gated send before the newer card arrives.
        try await Task.sleep(for: .milliseconds(20))

        let newerQuestionRequested = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "question.requested",
            "payload": {
                "questionId": "q_2", "turnId": "turn_1", "text": "Continue anyway?",
                "options": [{ "id": "yes", "label": "Yes" }],
                "allowFreeText": true
            }
        }
        """)
        store.apply(newerQuestionRequested)
        let statusLineBeforeStale409 = store.statusLine

        await client.openSendGate()
        await answerTask.value

        XCTAssertEqual(store.pendingQuestion?.questionId, "q_2", "the newer card must survive the stale 409")
        XCTAssertEqual(store.statusLine, statusLineBeforeStale409, "the newer card's status line must not be stomped by the stale 409")
        XCTAssertNotEqual(store.statusKind, .requestInvalid)
    }

    /// Regression for R-026: a stale 409 for answer(text:) must not stomp the status line for a
    /// newer, still-valid question card that replaced it while the send was in flight.
    func testAnswerTextStale409DoesNotStompNewerCardStatus() async throws {
        let (store, client) = try await makeStoreWithPendingQuestion()
        await client.setSendResult(.failure(BridgeError.http(status: 409, message: "stale binding")))
        await client.gateSendCall(1)

        let answerTask = Task { await store.answer(text: "Sure") }
        // Give answer() a chance to reach the gated send before the newer card arrives.
        try await Task.sleep(for: .milliseconds(20))

        let newerQuestionRequested = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "question.requested",
            "payload": {
                "questionId": "q_2", "turnId": "turn_1", "text": "Continue anyway?",
                "options": [{ "id": "yes", "label": "Yes" }],
                "allowFreeText": true
            }
        }
        """)
        store.apply(newerQuestionRequested)
        let statusLineBeforeStale409 = store.statusLine

        await client.openSendGate()
        await answerTask.value

        XCTAssertEqual(store.pendingQuestion?.questionId, "q_2", "the newer card must survive the stale 409")
        XCTAssertEqual(store.statusLine, statusLineBeforeStale409, "the newer card's status line must not be stomped by the stale 409")
        XCTAssertNotEqual(store.statusKind, .requestInvalid)
    }

    /// Regression for R-016: when createSession()'s rebind guard rejects the response (a
    /// reconnect() moved on to a new generation while the send was in flight), the stale id it
    /// carries must not be returned to sendPrompt() as a valid target.
    func testCreateSessionReturnsNilWhenRebindRejected() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)
        await client.setSendResult(.success(CommandResponse(sessionId: "sess_created")))
        await client.gateSendCall(1)

        let createTask = Task { await store.createSession() }
        try await Task.sleep(for: .milliseconds(20))

        // Hold reconnect()'s own poll loop's first events() call in flight, or its "Connected"
        // status write would race the guard's status write below.
        await client.gateEventsCall(1)
        await store.reconnect()
        await client.openSendGate()
        let created = await createTask.value

        XCTAssertNil(created, "a rejected rebind must not hand back the stale id")
        XCTAssertNil(store.sessionId)
        XCTAssertEqual(store.statusLine, "Session changed; prompt not sent")
        XCTAssertEqual(store.statusKind, .skippedEvents)
    }

    /// Regression for R-017: a session.started for a different id while already bound must
    /// surface a status line instead of being dropped with no trace.
    func testCrossSessionStartedSetsStatusLine() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let otherStarted = try decodeEvent("""
        {
            "eventId": 5, "sessionId": "sess_other", "provider": "mock",
            "timestamp": "2026-09-17T00:04:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        store.apply(otherStarted)

        XCTAssertEqual(store.sessionId, "sess_1", "the current session must not be replaced")
        XCTAssertEqual(store.statusKind, .skippedEvents)
        XCTAssertTrue(store.statusLine.contains("sess_other"))
    }

    /// Regression for R-019: a fatal .error event must reset the session binding and clear the
    /// pending card, while a recoverable one keeps the binding so in-flight events still apply.
    func testFatalErrorResetsSessionState() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let fatalError = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "error",
            "payload": { "code": "boom", "message": "fatal boom", "fatal": true }
        }
        """)
        store.apply(fatalError)

        XCTAssertNil(store.sessionId)
        XCTAssertNil(store.pendingApproval)
    }

    func testRecoverableErrorKeepsSessionBound() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let recoverableError = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "error",
            "payload": { "code": "boom", "message": "recoverable boom", "fatal": false }
        }
        """)
        store.apply(recoverableError)

        XCTAssertEqual(store.sessionId, "sess_1")
        XCTAssertNotNil(store.pendingApproval, "a recoverable error must not clear an unrelated pending card")
    }

    /// Regression for R-020: reject()'s 409 branch was never exercised; mirrors the existing
    /// approve() 409 test.
    func testRejectStaleBindingClearsCardAndSetsStatus() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 409, message: "stale binding")))

        await store.reject()

        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.statusKind, .requestInvalid)
        XCTAssertFalse(store.isSending)
    }

    /// Regression for R-021: apply() must bind to the sessionId of the first event it sees even
    /// when that event is not session.started, for example right after relaunch with a cursor
    /// already past that event.
    func testApplyBindsToFirstEventWhenNotSessionStarted() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)

        let turnStarted = try decodeEvent("""
        {
            "eventId": 7, "sessionId": "sess_mid", "provider": "mock",
            "timestamp": "2026-09-17T00:05:00.000Z", "type": "turn.started",
            "payload": { "turnId": "turn_1" }
        }
        """)
        store.apply(turnStarted)

        XCTAssertEqual(store.sessionId, "sess_mid")
    }

    /// Regression for R-024: pollLoop's post-loop Connected/Skipped status write used to run
    /// after applying the batch's events, clobbering the "Ignored session" status apply() sets
    /// for a cross-session session.started. The status write now happens before the loop, so
    /// apply()'s message must survive an otherwise-clean batch.
    func testCrossSessionStartedStatusSurvivesPollLoopBatch() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()

        let otherStarted = try decodeEvent("""
        {
            "eventId": 5, "sessionId": "sess_other", "provider": "mock",
            "timestamp": "2026-09-17T00:04:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        await client.setEventsResults([
            .success(EventsPage(events: [otherStarted], lastEventId: 5, skipped: 0)),
        ])

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.sessionId, "sess_1", "the current session must not be replaced")
        XCTAssertEqual(store.statusKind, .skippedEvents)
        XCTAssertTrue(store.statusLine.contains("sess_other"), "apply()'s Ignored session status must survive the batch")
    }

    /// Regression for R-022: an apply()-driven bind to a different session during the await in
    /// createSession() must not be overwritten by the create response.
    func testCreateSessionDoesNotOverwriteConcurrentApplyBind() async throws {
        let client = FakeBridgeClient()
        let store = SessionStore(client: client)
        await client.setSendResult(.success(CommandResponse(sessionId: "sess_created")))
        await client.gateSendCall(1)

        let createTask = Task { await store.createSession() }
        try await Task.sleep(for: .milliseconds(20))

        let started = try decodeEvent("""
        {
            "eventId": 1, "sessionId": "sess_other", "provider": "mock",
            "timestamp": "2026-09-17T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        store.apply(started)
        XCTAssertEqual(store.sessionId, "sess_other")

        await client.openSendGate()
        let created = await createTask.value

        XCTAssertNil(created, "same-generation create must not overwrite a session bound by apply()")
        XCTAssertEqual(store.sessionId, "sess_other", "the concurrently bound session must survive")
    }
}

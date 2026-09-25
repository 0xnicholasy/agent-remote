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
        let commandId: String
        let timestamp: String
    }

    private var sendResult: SendResult = .success(CommandResponse())
    /// Controls what `pair(code:deviceName:)` does; defaults to succeeding silently like the
    /// existing no-op did, so tests that never touch pairing are unaffected.
    private var pairResult: Result<Void, any Error & Sendable> = .success(())
    /// Backs `isPaired()`; defaults to `true` to preserve the previous hardcoded behavior for
    /// every test that does not care about pairing state.
    private var pairedFlag = true
    /// One page per call, returned in order; the last one repeats once the list is exhausted.
    private var eventsResults: [Result<EventsPage, any Error & Sendable>] = []
    private(set) var sentCalls: [RecordedSend] = []
    /// The `wait` argument of every events() call, in order.
    private(set) var waits: [Int] = []
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

    /// Arms the next `pair(code:deviceName:)` call to throw `error` instead of succeeding.
    func setPairResult(_ result: Result<Void, any Error & Sendable>) {
        pairResult = result
    }

    /// Sets what `isPaired()` reports, so a test can simulate "the credential store never
    /// got a credential" after a failed pair attempt.
    func setPaired(_ value: Bool) {
        pairedFlag = value
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
    func pair(code: String, deviceName: String) async throws {
        try pairResult.get()
    }
    func isPaired() async -> Bool { pairedFlag }

    func events(after: Int, wait: Int) async throws -> EventsPage {
        eventsCallCount += 1
        waits.append(wait)
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

    func send(_ payload: CommandPayload, sessionId: String, commandId: String, timestamp: String) async throws -> CommandResponse {
        sentCalls.append(RecordedSend(payload: payload, sessionId: sessionId, commandId: commandId, timestamp: timestamp))
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

    /// A private defaults suite per store. Poll loops from earlier tests are never stopped and
    /// keep persisting their cursor; in shared standard defaults the next test's store would
    /// start from that cursor.
    private func freshDefaults() -> UserDefaults {
        let name = "SessionStoreDecisionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func decodeEvent(_ json: String) throws -> AgentEvent {
        try decoder.decode(AgentEvent.self, from: Data(json.utf8))
    }

    /// Builds a store already bound to "sess_1" with a pending approval card, backed by a
    /// fake client whose next `send` result is under the test's control.
    private func makeStoreWithPendingApproval(
        defaults: UserDefaults? = nil
    ) async throws -> (SessionStore, FakeBridgeClient) {
        let client = FakeBridgeClient()
        let defaults = defaults ?? freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)

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
                "title": "Run git push origin main",
                "titleFidelity": "exact"
            }
        }
        """)
        store.apply(approvalRequested)

        XCTAssertNotNil(store.pendingApproval, "setup should leave a pending approval card")
        return (store, client)
    }

    /// Builds a store already bound to "sess_1" with a pending, desk-only approval card (M4):
    /// its `approval.requested` carries no `titleFidelity`, the fail-closed default.
    private func makeStoreWithPendingDeskOnlyApproval(
        defaults: UserDefaults? = nil
    ) async throws -> (SessionStore, FakeBridgeClient) {
        let client = FakeBridgeClient()
        let defaults = defaults ?? freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)

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
                "title": "Run git push origin main --force-with-lease…"
            }
        }
        """)
        store.apply(approvalRequested)

        XCTAssertNotNil(store.pendingApproval, "setup should leave a pending approval card")
        XCTAssertEqual(store.pendingApproval?.requiresDeskReview, true, "setup should be desk-only")
        return (store, client)
    }

    /// Builds a store already bound to "sess_1" with a pending question card, backed by a
    /// fake client whose next `send` result is under the test's control.
    private func makeStoreWithPendingQuestion(
        defaults: UserDefaults? = nil
    ) async throws -> (SessionStore, FakeBridgeClient) {
        let client = FakeBridgeClient()
        let defaults = defaults ?? freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)

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

    func testExpiredDecisionClearsCardAndSaysExpired() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.decisionExpired))

        await store.approve()

        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.actionOutcome, .expired)
        XCTAssertEqual(store.statusLine, "Decision expired before it reached the bridge")
        XCTAssertEqual(store.statusKind, .requestInvalid)
    }

    func testIndeterminateOutcomeIsShownNotGuessed() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.commandIndeterminate))

        await store.approve()

        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.actionOutcome, .indeterminate)
        XCTAssertEqual(store.statusLine, "Outcome unknown; check at the desk")
    }

    func testInteractionNotPendingIsNoLongerValid() async throws {
        let (store, client) = try await makeStoreWithPendingQuestion()
        await client.setSendResult(.failure(BridgeError.interactionNotPending))

        await store.answer(optionId: "yes")

        XCTAssertNil(store.pendingQuestion)
        XCTAssertEqual(store.actionOutcome, .noLongerValid)
        XCTAssertEqual(store.statusKind, .requestInvalid)
    }

    /// An offline send keeps the card, and repeating the same choice reuses the command id so a
    /// send that did land gets its recorded outcome instead of a second execution.
    func testOfflineKeepsCardAndSameChoiceRetriesWithSameCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.notConnectedToInternet)))

        await store.approve()

        XCTAssertNotNil(store.pendingApproval, "offline must keep the card for a retry")
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .offline)

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId, "a retry of the same choice must reuse the command id")
        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.actionOutcome, .acknowledged)
    }

    /// E-33: answer(optionId:) had no success-path test -- lock in that a successful send
    /// clears the question card and records the acknowledged outcome.
    func testAnswerOptionIdSuccessClearsCardAndAcknowledges() async throws {
        let (store, client) = try await makeStoreWithPendingQuestion()
        await client.setSendResult(.success(CommandResponse(accepted: true)))

        await store.answer(optionId: "yes")

        XCTAssertNil(store.pendingQuestion)
        XCTAssertEqual(store.actionOutcome, .acknowledged)
        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.sessionId, "sess_1")
    }

    /// E-33: answer(text:) had no offline-retry test -- lock in that an offline free-text
    /// answer keeps the card, and repeating the same text reuses the command id, same contract
    /// as approve()/answer(optionId:).
    func testAnswerTextOfflineRetryReusesCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingQuestion()
        await client.setSendResult(.failure(URLError(.notConnectedToInternet)))

        await store.answer(text: "Sure")

        XCTAssertNotNil(store.pendingQuestion, "offline must keep the card for a retry")
        XCTAssertEqual(store.outcome(forCard: "q_1"), .offline)

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.answer(text: "Sure")

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId, "a retry of the same free-text answer must reuse the command id")
        XCTAssertNil(store.pendingQuestion)
        XCTAssertEqual(store.actionOutcome, .acknowledged)
    }

    /// E-27: once the bridge reports the approval resolved, its transcript line carries the
    /// outcome, so the "Sent" banner must not stay under it.
    func testResolutionEventClearsSentOutcome() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.approve()
        XCTAssertEqual(store.actionOutcome, .acknowledged)

        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "accepted" }
        }
        """))

        XCTAssertNil(store.actionOutcome, "a resolved approval must not leave a stale Sent banner")
    }

    /// E-27: when the resolution event lands before the send's own response, the late response
    /// must not bring the "Sent" banner back.
    func testLateAcknowledgementAfterResolutionDoesNotShowSent() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.gateSendCall(1)
        let sending = Task { await store.approve() }
        try await Task.sleep(for: .milliseconds(50))

        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "accepted" }
        }
        """))
        await client.openSendGate()
        await sending.value

        XCTAssertNil(store.pendingApproval)
        XCTAssertNil(store.actionOutcome)
    }

    /// Regression for E-32: an approval.resolved for an id that is not the outcome's card must
    /// not wipe a still-current "Sent" banner belonging to a different card.
    func testUnrelatedApprovalResolvedDoesNotClearOutcome() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.approve()
        XCTAssertEqual(store.actionOutcome, .acknowledged)

        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_99", "decision": "accepted" }
        }
        """))

        XCTAssertEqual(store.actionOutcome, .acknowledged, "a resolution for an unrelated approval id must not clear this card's outcome")
    }

    /// Regression for E-32: same defect, question.answered side -- an unrelated question id
    /// must not wipe a still-current "Sent" banner belonging to a different card.
    func testUnrelatedQuestionAnsweredDoesNotClearOutcome() async throws {
        let (store, client) = try await makeStoreWithPendingQuestion()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.answer(optionId: "yes")
        XCTAssertEqual(store.actionOutcome, .acknowledged)

        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "question.answered",
            "payload": { "questionId": "q_99", "answer": "no" }
        }
        """))

        XCTAssertEqual(store.actionOutcome, .acknowledged, "a resolution for an unrelated question id must not clear this card's outcome")
    }

    /// E-28: a rate-limited send goes through decide() like an offline one: the card stays,
    /// the outcome is rateLimited, and the same choice retries with the same command id.
    func testRateLimitedKeepsCardAndRetriesWithSameCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.rateLimited))

        await store.reject()

        XCTAssertNotNil(store.pendingApproval, "rate limiting must keep the card for a retry")
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .rateLimited)

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.reject()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId)
        XCTAssertNil(store.pendingApproval)
    }

    /// C3-06: an accepted send whose reply cannot be read must not say "Not sent". The card
    /// stays with its own label, and the same choice retries under the same command id so the
    /// bridge replays its recorded outcome.
    func testUnreadableReplyKeepsCardAndRetriesWithSameCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.commandResponseUnreadable))

        await store.approve()

        XCTAssertNotNil(store.pendingApproval, "an unreadable reply must keep the card for a retry")
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .unconfirmed)
        XCTAssertNotEqual(ActionOutcome.unconfirmed.label, ActionOutcome.failed.label)

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId)
        XCTAssertEqual(calls[0].timestamp, calls[1].timestamp)
        XCTAssertNil(store.pendingApproval)
    }

    /// C3-07: a cancel whose outcome was lost retries under the same command id and body
    /// timestamp, instead of sending a second, distinct cancel.
    func testCancelRetryAfterLostResponseReusesCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))

        await store.cancel()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId)
        XCTAssertEqual(calls[0].timestamp, calls[1].timestamp)
    }

    /// C3-07: once a cancel is confirmed, the next cancel is a new command with a new id.
    func testCancelAfterConfirmedCancelUsesNewCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()

        await store.cancel()
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotEqual(calls[0].commandId, calls[1].commandId)
    }

    /// R-001: a double-tap while the first cancel is still in flight must not send a second,
    /// distinct cancel command -- cancel() is guarded by the same `isSending` flag as decide().
    func testConcurrentCancelSendsOnlyOneCommand() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await client.gateSendCall(1)

        let firstCancel = Task { await store.cancel() }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(store.isSending)

        // A second tap while the first is still in flight must be a no-op.
        await store.cancel()

        await client.openSendGate()
        await firstCancel.value

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 1, "a concurrent cancel must not send a second, distinct command")
        XCTAssertFalse(store.isSending)
    }

    /// R-002: cancel()'s response can land after reconnect() has already bumped pollGeneration
    /// and discarded the binding it was cancelling. The stale generation's outcome must not
    /// write status state or leave a retryable command id behind for a session the new
    /// generation knows nothing about (mirrors the guard in decide()/createSession()).
    func testCancelDoesNotWriteStateAfterConcurrentReconnect() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))
        await client.gateSendCall(1)

        let cancelTask = Task { await store.cancel() }
        try await Task.sleep(for: .milliseconds(20))

        await client.gateEventsCall(1)
        await store.reconnect()
        let statusLineAfterReconnect = store.statusLine
        let statusKindAfterReconnect = store.statusKind

        await client.openSendGate()
        await cancelTask.value

        XCTAssertEqual(store.statusLine, statusLineAfterReconnect, "a stale generation's cancel failure must not write the status line")
        XCTAssertEqual(store.statusKind, statusKindAfterReconnect)

        // Bind a new session under the new generation: a cancel for it must mint a fresh
        // command id instead of replaying the stale generation's cancel.
        store.apply(try decodeEvent("""
        {
            "eventId": 10, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-17T00:00:03.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """))
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotEqual(calls[0].commandId, calls[1].commandId, "a stale generation's cancel must not leave a retryable command id for a new session")
    }

    /// R-003: an unreadable reply (commandResponseUnreadable) keeps the pending cancel and a
    /// retry reuses the same command id and timestamp (same rule as decide()'s C3-06).
    func testCancelUnreadableReplyRetriesWithSameCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.commandResponseUnreadable))

        await store.cancel()

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId)
        XCTAssertEqual(calls[0].timestamp, calls[1].timestamp)
    }

    /// R-004: a terminal (non-retryable) cancel failure clears the pending cancel, so the next
    /// cancel mints a fresh command id instead of replaying the terminal one.
    func testCancelTerminalFailureDoesNotKeepRetryPath() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.decisionExpired))

        await store.cancel()

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotEqual(calls[0].commandId, calls[1].commandId, "a terminal cancel failure must not keep a retryable command id")
    }

    /// R-006: session.completed can land (via apply(), synchronously resetting the session
    /// binding and turnState) while a cancel send for the old session is still in flight. When
    /// that send then fails, the stale reply must not resurrect unconfirmedCancel for a session
    /// that no longer exists, nor stomp the just-set completed turnState via report(error).
    func testCancelDoesNotStompCompletedSessionAfterConcurrentCompletion() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))
        await client.gateSendCall(1)

        let cancelTask = Task { await store.cancel() }
        try await Task.sleep(for: .milliseconds(20))

        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "session.completed",
            "payload": { "reason": "completed" }
        }
        """))
        XCTAssertNil(store.sessionId)
        XCTAssertEqual(store.turnState, .completed)
        let statusLineAfterCompletion = store.statusLine
        let statusKindAfterCompletion = store.statusKind

        await client.openSendGate()
        await cancelTask.value

        XCTAssertEqual(store.turnState, .completed, "a stale in-flight cancel failure must not stomp the completed turn state")
        XCTAssertEqual(store.statusLine, statusLineAfterCompletion)
        XCTAssertEqual(store.statusKind, statusKindAfterCompletion)
    }

    /// R-011 (ACCEPTED, downgraded): a retried cancel's success can land after reconnect() has
    /// already bumped pollGeneration for the *same* bridge (discardLocalView(preservingUnconfirmedSend:
    /// true) keeps unconfirmedCancel across the reconnect). That stale-generation success must not
    /// clear unconfirmedCancel for a session the new generation later rebinds to, or a later cancel
    /// for that same session would mint a fresh command id instead of replaying the still-pending one.
    func testCancelStaleSuccessAfterReconnectDoesNotClearUnconfirmedCancel() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))
        await store.cancel()
        let c1 = (await client.sentCalls).last!.commandId

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await client.gateSendCall(2)

        let retryTask = Task { await store.cancel() }
        try await Task.sleep(for: .milliseconds(20))

        // Same host (hostText is unchanged), so reconnect() takes the sameBridge path and keeps
        // unconfirmedCancel while still bumping pollGeneration.
        await store.reconnect()

        await client.openSendGate()
        await retryTask.value

        // Rebind to the same session under the new generation.
        store.apply(try decodeEvent("""
        {
            "eventId": 10, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:03.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """))
        await client.setSendResult(.failure(URLError(.timedOut)))
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls[2].commandId, c1, "a stale generation's cancel success must not clear unconfirmedCancel for a session the new generation rebinds to")
    }

    /// R-005/R-009 (ACCEPTED contract): a retryable cancel failure sets an error status and
    /// turnState (report(error)'s side effect). A later successful retry reuses the failed
    /// cancel's command id and clears `unconfirmedCancel` -- proven here by a further failure
    /// minting a fresh command id instead of replaying the old one -- but it does NOT itself
    /// clear the error status/turnState (R-005 is accepted, not fixed: a clearing flag was tried
    /// and removed because it could wipe an unrelated live error). The stale error survives at
    /// most one poll round trip: the next successful poll page unconditionally rewrites
    /// statusLine/statusKind regardless of what set them.
    func testCancelRetrySucceedsButErrorStatusClearsOnlyOnNextPollPage() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))

        await store.cancel()
        XCTAssertEqual(store.turnState, .error, "setup: the failed cancel must have written the error turnState")
        XCTAssertEqual(store.statusKind, .error, "setup: the failed cancel must have written the error status")
        let failedCommandId = (await client.sentCalls).last!.commandId

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.cancel()

        let callsAfterRetry = await client.sentCalls
        XCTAssertEqual(callsAfterRetry.count, 2)
        XCTAssertEqual(callsAfterRetry[1].commandId, failedCommandId, "a successful retry must reuse the failed cancel's command id")
        XCTAssertEqual(store.turnState, .error, "ACCEPTED (R-005): a successful retry alone does not clear the error turnState")
        XCTAssertEqual(store.statusKind, .error, "ACCEPTED (R-005): a successful retry alone does not clear the error status")

        // A further failure must mint a fresh command id, proving the successful retry cleared
        // unconfirmedCancel rather than leaving the old (already-accepted) command id in place.
        await client.setSendResult(.failure(URLError(.timedOut)))
        await store.cancel()
        let callsAfterSecondFailure = await client.sentCalls
        XCTAssertEqual(callsAfterSecondFailure.count, 3)
        XCTAssertNotEqual(callsAfterSecondFailure[2].commandId, failedCommandId, "unconfirmedCancel must have been cleared by the successful retry, so this failure mints a fresh command id")

        // The next successful poll page unconditionally rewrites statusLine/statusKind, clearing
        // the stale error within one round trip.
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
        ])
        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertNotEqual(store.statusKind, .error, "the next successful poll page must clear the stale error status")
    }

    /// R-007: cancel() shares isSending with decide(); a decide() send in flight must make a
    /// concurrent cancel() tap a no-op, not a second command.
    func testCancelIsNoOpWhileDecideInFlight() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await client.gateSendCall(1)

        let approveTask = Task { await store.approve() }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(store.isSending)

        await store.cancel()

        await client.openSendGate()
        await approveTask.value

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 1, "a cancel() tap while decide() is sending must not add a second command")
        if case .approvalAccept = calls[0].payload {} else {
            XCTFail("the one command sent must be decide()'s, not cancel()'s")
        }
    }

    /// R-007 (reverse): a cancel() send in flight must make a concurrent decide() tap a no-op.
    func testDecideIsNoOpWhileCancelInFlight() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await client.gateSendCall(1)

        let cancelTask = Task { await store.cancel() }
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(store.isSending)

        await store.approve()

        await client.openSendGate()
        await cancelTask.value

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 1, "a decide() tap while cancel() is sending must not add a second command")
        if case .sessionCancel = calls[0].payload {} else {
            XCTFail("the one command sent must be cancel()'s, not decide()'s")
        }
        XCTAssertNotNil(store.pendingApproval, "the no-op approve() must leave the card in place")
    }

    /// R-008: resetSessionState()'s explicit `unconfirmedCancel = nil` must clear it even when
    /// the new session reuses the same sessionId the stale unconfirmedCancel was recorded
    /// under -- the sessionId-mismatch guard in cancel() alone would not catch this case.
    func testResetSessionStateClearsUnconfirmedCancelForReusedSessionId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))

        await store.cancel()
        let staleCommandId = (await client.sentCalls).last!.commandId

        // Session completes and a new session reuses the exact same id ("sess_1").
        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "session.completed",
            "payload": { "reason": "completed" }
        }
        """))
        store.apply(try decodeEvent("""
        {
            "eventId": 4, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:03:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """))
        XCTAssertEqual(store.sessionId, "sess_1")

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.cancel()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotEqual(calls[1].commandId, staleCommandId, "a fresh session reusing the same id must not replay the stale cancel's command id")
    }

    /// A different choice after an offline send is a different command, so it must not reuse
    /// the id (the bridge would refuse it as a conflict).
    func testOfflineThenDifferentChoiceUsesNewCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.timedOut)))

        await store.approve()
        await store.reject()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotEqual(calls[0].commandId, calls[1].commandId)
    }

    /// Regression for E-02: a generic (non-offline) failure does not mean the command never
    /// reached the bridge -- the response could simply have been lost. A retry of the same
    /// choice must reuse the id, or the bridge could apply the decision twice.
    func testFailedSendReusesCommandIdForSameChoice() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 500, message: "boom")))

        await store.approve()
        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId, "a retry of the same choice after a failure must reuse the command id")
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .failed)
    }

    /// A different choice after a generic failure is still a different command: it must not
    /// reuse the id the first choice remembered.
    func testFailedThenDifferentChoiceUsesNewCommandId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 500, message: "boom")))

        await store.approve()
        await store.reject()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertNotEqual(calls[0].commandId, calls[1].commandId)
    }

    /// Covers E-20: the body timestamp lives with the command id in `unconfirmedSend`, so a
    /// retry of the same choice resends both unchanged (the bridge's idempotency digest covers
    /// the whole body), while a different choice mints a fresh command id (its timestamp is
    /// minted alongside, but at millisecond resolution it can legitimately collide, so only
    /// the id is asserted).
    func testRetryReusesTimestampWithCommandIdAndNewChoiceMintsNewId() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 500, message: "boom")))

        await store.approve()
        await store.approve()
        await store.reject()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId)
        XCTAssertEqual(calls[0].timestamp, calls[1].timestamp, "a same-choice retry must resend the original body timestamp")
        XCTAssertNotEqual(calls[2].commandId, calls[1].commandId, "a different choice is a new command")
    }

    /// Covers E-24: an auth failure on a decision is terminal -- the card is cleared, the
    /// status line shows the auth text and the store stops on `.authFailed` rather than keeping
    /// the card for a retry that cannot succeed until the Watch is paired again.
    func testAuthFailureOnDecisionClearsCardAndSetsAuthFailed() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.unauthenticated))

        await store.approve()

        XCTAssertNil(store.pendingApproval, "an auth failure must not keep the card for a retry")
        XCTAssertEqual(store.actionOutcome, .authRequired)
        XCTAssertEqual(store.statusKind, .authFailed)
        XCTAssertEqual(store.statusLine, ActionOutcome.authRequired.statusText)
        XCTAssertEqual(store.statusLine, "Not authorized: pair this Watch again")
    }

    /// The outcome belongs to the card it was sent for; a newer card starts with none.
    func testOutcomeIsScopedToItsCard() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.networkConnectionLost)))
        await store.approve()
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .offline)

        store.apply(try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:02.000Z", "type": "approval.requested",
            "payload": {
                "binding": {
                    "approvalId": "appr_2", "sessionId": "sess_1", "turnId": "turn_1",
                    "toolCallId": "tool_2", "actionDigest": "digest2",
                    "expiresAt": "2026-09-17T00:05:00.000Z"
                },
                "kind": "command",
                "title": "Edit README.md"
            }
        }
        """))

        XCTAssertEqual(store.pendingApproval?.binding.approvalId, "appr_2")
        XCTAssertNil(store.outcome(forCard: "appr_2"))
    }

    /// Regression for E-29: a terminal failure (409-class, expired, etc.) for a card superseded
    /// by a newer approvalRequested while the send was in flight must not write its outcome
    /// under the old card's id -- that id is never queried again once the card is gone, so the
    /// write would just be a silent, unreachable leftover.
    func testStaleTerminalOutcomeDoesNotWriteToSupersededCard() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.decisionExpired))
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
                    "toolCallId": "tool_2", "actionDigest": "digest2",
                    "expiresAt": "2026-09-17T00:05:00.000Z"
                },
                "kind": "command",
                "title": "Edit README.md"
            }
        }
        """)
        store.apply(newerApprovalRequested)

        await client.openSendGate()
        await approveTask.value

        XCTAssertEqual(store.pendingApproval?.binding.approvalId, "appr_2", "the newer card must survive the stale terminal outcome")
        XCTAssertNil(store.outcome(forCard: "appr_1"), "a terminal outcome for a superseded card must not be recorded under its own (unreachable) id")
        XCTAssertNil(store.outcome(forCard: "appr_2"), "the superseded card's outcome must not leak onto the new card either")
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

    /// Regression for E-34: reconnect() to the same host (e.g. after a network blip) must not
    /// mint a fresh command id for an offline send that is still waiting to be retried, or the
    /// retry loses idempotency once the same card is replayed from the bridge.
    func testReconnectSameHostPreservesUnconfirmedSendForRetry() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(URLError(.notConnectedToInternet)))

        await store.approve()
        XCTAssertNotNil(store.pendingApproval, "offline must keep the card for a retry")

        await store.reconnect()
        XCTAssertNil(store.pendingApproval, "reconnect() discards the local view until the replay lands")

        // The replay after reconnect() re-delivers the same session and card.
        store.apply(try decodeEvent("""
        {
            "eventId": 1, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """))
        store.apply(try decodeEvent("""
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
                "title": "Run git push origin main",
                "titleFidelity": "exact"
            }
        }
        """))

        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].commandId, calls[1].commandId, "reconnect() to the same bridge must not mint a new command id for the retried choice")
        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.actionOutcome, .acknowledged)
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
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
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
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
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
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
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
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)

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

    /// A cancelled decision is a terminal outcome for the pending approval just like accepted,
    /// rejected or expired: apply() must remove the card so approve()/reject() cannot be called
    /// again against a binding the bridge already resolved.
    func testApprovalResolvedCancelledClearsPendingApproval() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let resolved = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "cancelled" }
        }
        """)
        store.apply(resolved)

        XCTAssertNil(store.pendingApproval)
    }

    /// Regression for the round-2 critical finding: createSession()'s response can land after
    /// reconnect() has already bumped pollGeneration and cleared sessionId. The stale create
    /// must not rebind sessionId to a session the new generation knows nothing about.
    func testCreateSessionDoesNotRebindAfterConcurrentReconnect() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
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

    /// Regression for E-01: a stale generic failure for approve() must not stomp the status
    /// line or turn state for a newer, still-valid card that replaced it while the send was in
    /// flight.
    func testStaleFailedDoesNotStompNewerCardStatus() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.http(status: 500, message: "boom")))
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
        let statusLineBeforeStaleFailure = store.statusLine
        let statusKindBeforeStaleFailure = store.statusKind

        await client.openSendGate()
        await approveTask.value

        XCTAssertEqual(store.pendingApproval?.binding.approvalId, "appr_2", "the newer card must survive the stale failure")
        XCTAssertEqual(store.statusLine, statusLineBeforeStaleFailure, "the newer card's status line must not be stomped by the stale failure")
        XCTAssertEqual(store.statusKind, statusKindBeforeStaleFailure, "the newer card's status kind must not be stomped by the stale failure")
    }

    /// Regression for E-05: classify() must not collapse a rate-limited response into the same
    /// generic outcome as an arbitrary failure -- the two need distinct messages so the Watch
    /// can tell the user which situation they are in.
    func testRateLimitedIsDistinctFromGenericFailure() async throws {
        XCTAssertEqual(ActionOutcome.classify(BridgeError.rateLimited), .rateLimited)
        XCTAssertNotEqual(ActionOutcome.classify(BridgeError.rateLimited), ActionOutcome.classify(BridgeError.http(status: 500, message: "boom")))
        XCTAssertNotEqual(ActionOutcome.rateLimited.label, ActionOutcome.failed.label)
    }

    /// Regression for E-05: an auth failure (revoked/unpaired/unauthenticated credential) must
    /// not be reported as a generic, retry-worthy failure -- retrying will never succeed until
    /// the Watch is paired again.
    func testAuthFailuresClassifyDistinctlyFromGenericFailure() async throws {
        XCTAssertEqual(ActionOutcome.classify(BridgeError.notPaired), .authRequired)
        XCTAssertEqual(ActionOutcome.classify(BridgeError.unauthenticated), .authRequired)
        XCTAssertEqual(ActionOutcome.classify(BridgeError.deviceRevoked), .authRequired)
        XCTAssertNotEqual(ActionOutcome.authRequired.label, ActionOutcome.failed.label)
    }

    /// Regression for E-11: commandIdConflict is the one classify() branch that had no test --
    /// it must be reported the same way a stale/superseded interaction is, not as a generic
    /// failure, since retrying with a fresh id would only be refused again.
    func testCommandIdConflictClassifiesAsNoLongerValid() async throws {
        XCTAssertEqual(ActionOutcome.classify(BridgeError.commandIdConflict), .noLongerValid)
    }

    /// Regression for E-11: a commandIdConflict from an in-flight decide() call clears the card
    /// and reports it as no longer valid, exactly like the other terminal outcomes.
    func testCommandIdConflictClearsCardAndSetsStatus() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.commandIdConflict))

        await store.approve()

        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.actionOutcome, .noLongerValid)
        XCTAssertEqual(store.statusKind, .requestInvalid)
    }

    /// Regression for E-09: decide()'s response can land after reconnect() has already bumped
    /// pollGeneration and discarded the card it was answering for. The stale response must not
    /// resurrect the outcome/status for a binding the new generation knows nothing about
    /// (mirrors the equivalent guard in createSession()).
    func testDecideDoesNotWriteOutcomeAfterConcurrentReconnect() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))
        await client.gateSendCall(1)

        let approveTask = Task { await store.approve() }
        // Give approve() a chance to reach the gated send before reconnect() runs.
        try await Task.sleep(for: .milliseconds(20))

        // Hold reconnect()'s own poll loop's first events() call in flight, or its "Syncing"
        // status write would race the assertions below.
        await client.gateEventsCall(1)
        await store.reconnect()
        XCTAssertNil(store.sessionId)
        XCTAssertNil(store.pendingApproval, "reconnect() must have already discarded the old card")

        await client.openSendGate()
        await approveTask.value

        XCTAssertNil(store.actionOutcome, "a stale generation's response must not resurrect an outcome for a discarded card")
        XCTAssertNil(store.pendingApproval, "a stale generation's response must not resurrect the discarded card")
    }

    /// Covers E-18: the catch-path twin of the test above. A terminal failure (which records its
    /// outcome even when the card is no longer current) landing after reconnect() bumped
    /// pollGeneration must not write any outcome or status line for the discarded binding.
    func testDecideFailureDoesNotWriteOutcomeAfterConcurrentReconnect() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.decisionExpired))
        await client.gateSendCall(1)

        let approveTask = Task { await store.approve() }
        try await Task.sleep(for: .milliseconds(20))

        await client.gateEventsCall(1)
        await store.reconnect()
        XCTAssertNil(store.pendingApproval, "reconnect() must have already discarded the old card")
        let statusLineAfterReconnect = store.statusLine
        let statusKindAfterReconnect = store.statusKind

        await client.openSendGate()
        await approveTask.value

        XCTAssertNil(store.actionOutcome, "a stale generation's failure must not record an outcome")
        XCTAssertNil(store.outcome(forCard: "appr_1"))
        XCTAssertEqual(store.statusLine, statusLineAfterReconnect, "a stale generation's failure must not write the status line")
        XCTAssertEqual(store.statusKind, statusKindAfterReconnect)
    }

    /// Covers E-05: action_not_allowed / project_not_allowed come from static device policy, so
    /// the same command can never succeed on retry. They must classify as a terminal outcome,
    /// not the generic retryable `.failed`.
    func testPolicyRefusalsClassifyAsTerminalNotAllowed() async throws {
        XCTAssertEqual(ActionOutcome.classify(BridgeError.actionNotAllowed), .notAllowed)
        XCTAssertEqual(ActionOutcome.classify(BridgeError.projectNotAllowed), .notAllowed)
        XCTAssertNotNil(ActionOutcome.notAllowed.statusText)
    }

    /// Covers E-05: a policy refusal clears the card instead of keeping it for a retry, and a
    /// later decision on a new card does not reuse the refused command id.
    func testPolicyRefusalClearsCardAndDoesNotKeepRetryPath() async throws {
        for error in [BridgeError.actionNotAllowed, BridgeError.projectNotAllowed] {
            let (store, client) = try await makeStoreWithPendingApproval()
            await client.setSendResult(.failure(error))

            await store.approve()

            XCTAssertNil(store.pendingApproval, "\(error) must not keep the card for a retry")
            XCTAssertEqual(store.actionOutcome, .notAllowed)
            XCTAssertEqual(store.statusLine, ActionOutcome.notAllowed.statusText)
            XCTAssertEqual(store.statusKind, .requestInvalid)
        }
    }

    /// M4: approve() must refuse to send anything for a desk-only approval (no `titleFidelity`,
    /// fail closed) -- the card was never shown the exact action, so there is nothing here to
    /// authorize. The card stays, and no command reaches the client at all.
    func testApproveSendsNothingForDeskOnlyApproval() async throws {
        let (store, client) = try await makeStoreWithPendingDeskOnlyApproval()

        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 0, "approve() must not send anything for a desk-only approval")
        XCTAssertNotNil(store.pendingApproval, "the card must stay in place")
        XCTAssertEqual(store.actionOutcome, .reviewAtDesk)
    }

    /// R-001 regression: approve() must not silently no-op the desk-only guard -- it has to
    /// surface a visible outcome on the current card, e.g. for a stale-card race where the
    /// card the user tapped Allow on was replaced by a desk-only one before this call ran.
    func testApproveSurfacesOutcomeForDeskOnlyGuard() async throws {
        let (store, client) = try await makeStoreWithPendingDeskOnlyApproval()

        await store.approve()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 0)
        XCTAssertEqual(store.actionOutcome, .reviewAtDesk)
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .reviewAtDesk)
    }

    /// M4: reject() is unaffected by the desk-only gate -- declining an action the user cannot
    /// verify is always safe, so it must still reach the bridge.
    func testRejectStillSendsForDeskOnlyApproval() async throws {
        let (store, client) = try await makeStoreWithPendingDeskOnlyApproval()
        await client.setSendResult(.success(CommandResponse(accepted: true)))

        await store.reject()

        let calls = await client.sentCalls
        XCTAssertEqual(calls.count, 1)
        if case .approvalReject = calls[0].payload {} else {
            XCTFail("expected an approval.reject command")
        }
        XCTAssertNil(store.pendingApproval)
        XCTAssertEqual(store.actionOutcome, .acknowledged)
    }

    /// R-002 regression: the bridge's `review_at_desk` refusal (e.g. if a stale client somehow
    /// did send approve() for a desk-only approval) gets its own outcome, not the generic
    /// `.notAllowed`, so the Watch can still say "review at the Mac" -- while remaining terminal
    /// and not retryable, same as a static policy refusal.
    func testReviewAtDeskClassifiesDistinctlyFromNotAllowed() async throws {
        XCTAssertEqual(ActionOutcome.classify(BridgeError.reviewAtDesk), .reviewAtDesk)
        XCTAssertNotEqual(ActionOutcome.reviewAtDesk, .notAllowed)
        XCTAssertNotNil(ActionOutcome.reviewAtDesk.statusText, "status text exists for callers that do clear the card on it")
    }

    /// R-005 regression: unlike a static policy refusal, the bridge's `review_at_desk` for a
    /// command that did reach it (decide()'s catch path) leaves the approval pending there, not
    /// decided -- so the card, and the Deny button on it, must stay, exactly like the local
    /// desk-only guard in approve().
    func testBridgeReviewAtDeskKeepsCardAndDenyAvailable() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setSendResult(.failure(BridgeError.reviewAtDesk))

        await store.approve()

        XCTAssertNotNil(store.pendingApproval, "the approval is still pending on the bridge; Deny must stay available")
        XCTAssertEqual(store.actionOutcome, .reviewAtDesk)
        XCTAssertEqual(store.outcome(forCard: "appr_1"), .reviewAtDesk)
    }

    /// Regression for R-016: when createSession()'s rebind guard rejects the response (a
    /// reconnect() moved on to a new generation while the send was in flight), the stale id it
    /// carries must not be returned to sendPrompt() as a valid target.
    func testCreateSessionReturnsNilWhenRebindRejected() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
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
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)

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
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
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

    /// Regression for R-010: `pairingError` was never asserted because the fake client never
    /// threw. A failing pair() must surface the error on the store and must not flip `paired`
    /// to true just because the call was attempted.
    func testPairFailureSetsPairingErrorAndLeavesUnpaired() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setPairResult(.failure(BridgeError.http(status: 400, message: "invalid pairing code")))
        // The real client only reports paired == true once a credential is actually stored;
        // simulate that a failed pair leaves the credential store empty.
        await client.setPaired(false)

        await store.pair(code: "ZZZZZZZZZZZZ", deviceName: "Test Watch")

        XCTAssertNotNil(store.pairingError, "a failing pair() must surface an error on the store")
        XCTAssertFalse(store.paired, "a failing pair() must not report the device as paired")
    }

    /// Regression for R-029: a terminal auth failure stops the poll loop, but a subsequent
    /// successful pair() must resume polling on its own -- without this, the loop stays dead
    /// until the app relaunches or the user changes host in Settings.
    func testSuccessfulRePairResumesPollingAfterTerminalAuthFailure() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        // Call 1 is a terminal auth failure that stops the loop; every call after (once
        // re-paired) sees a clean, empty page.
        await client.setEventsResults([
            .failure(BridgeError.deviceRevoked),
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
        ])

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.statusKind, .authFailed, "setup should leave the loop stopped on a terminal auth failure")

        await store.pair(code: "AAAAAAAAAAAA", deviceName: "Test Watch")
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.statusKind, .connected, "a successful re-pair must resume polling without a relaunch or host change")
    }

    // MARK: - Recovery (M3 slice 4)
    //
    // Each test parks its poll loop on the fake's gate after the last page, so it does not keep
    // spinning on the main actor for the rest of the run.

    /// A different bridgeId means the cursor, session and transcript belong to a log that no
    /// longer exists, even though the new bridge's event ids are higher than the cursor.
    func testBridgeIdChangeDiscardsSessionTranscriptAndCursor() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 2, skipped: 0, bridgeId: "brg_a")),
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
            .success(EventsPage(events: [], lastEventId: 7, skipped: 0, bridgeId: "brg_b")),
        ])
        await client.gateEventsCall(4)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(store.sessionId, "a different bridge must drop the old session binding")
        XCTAssertNil(store.pendingApproval, "a different bridge must not leave the old approval card")
        XCTAssertTrue(store.transcript.isEmpty, "the old bridge's transcript must not stay on screen")
        XCTAssertEqual(store.lastSeenEventId, 7, "the cursor must restart against the new bridge, not keep 900")
        XCTAssertEqual(store.syncState, .current)
    }

    /// A bridgeId loaded from defaults at init (i.e. persisted across a relaunch) must still be
    /// compared against later pages, or a relaunch would blind the bridge-change guard.
    func testPersistedBridgeIdSurvivesRelaunchAndDetectsChange() async throws {
        let defaults = freshDefaults()
        defaults.set("brg_a", forKey: "dev.agentremote.watch.bridgeId")
        defaults.set(5, forKey: "dev.agentremote.watch.lastSeenEventId")
        let (store, client) = try await makeStoreWithPendingApproval(defaults: defaults)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
            .success(EventsPage(events: [], lastEventId: 7, skipped: 0, bridgeId: "brg_b")),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(store.sessionId, "a bridgeId loaded at init must still detect a bridge change")
        XCTAssertNil(store.pendingApproval, "a bridge change after relaunch must not leave the old approval card")
        XCTAssertTrue(store.transcript.isEmpty, "a bridge change after relaunch must not leave the old transcript")
        XCTAssertEqual(store.lastSeenEventId, 7, "the cursor must restart against the new bridge")
    }

    /// reconnect() clears the stored bridgeId, or a relaunch right after would treat the old
    /// bridge's id as still current and silently drop the new bridge's first page as unchanged.
    func testReconnectClearsPersistedBridgeId() async throws {
        let defaults = freshDefaults()
        defaults.set("brg_a", forKey: "dev.agentremote.watch.bridgeId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            .failure(BridgeError.unauthenticated),
        ])

        await store.reconnect()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertNil(defaults.string(forKey: "dev.agentremote.watch.bridgeId"), "reconnect() must clear the persisted bridgeId")
    }

    /// The same bridgeId across pages is a continuation: nothing is discarded.
    func testSameBridgeIdKeepsSessionAndCard() async throws {
        let (store, client) = try await makeStoreWithPendingApproval()
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 2, skipped: 0, bridgeId: "brg_a")),
            .success(EventsPage(events: [], lastEventId: 3, skipped: 0, bridgeId: "brg_a")),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(store.sessionId, "sess_1")
        XCTAssertNotNil(store.pendingApproval)
    }

    /// A truncated page cannot be a continuation: the pending card and the session binding may
    /// have been resolved in the pruned events, so the store rebuilds from the page and says so.
    func testTruncatedCursorRebuildsFromPageAndMarksGap() async throws {
        let defaults = freshDefaults()
        defaults.set(2, forKey: "dev.agentremote.watch.lastSeenEventId")
        let (store, client) = try await makeStoreWithPendingApproval(defaults: defaults)
        let laterSession = try decodeEvent("""
        {
            "eventId": 50, "sessionId": "sess_9", "provider": "mock",
            "timestamp": "2026-09-18T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        await client.setEventsResults([
            .success(EventsPage(
                events: [laterSession], lastEventId: 50, skipped: 0,
                firstEventId: 50, truncated: true, bridgeId: "brg_a"
            )),
            .success(EventsPage(events: [], lastEventId: 50, skipped: 0, firstEventId: 50, bridgeId: "brg_a")),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(store.pendingApproval, "a card from before the gap must not survive it")
        XCTAssertEqual(store.sessionId, "sess_9", "the page after the gap must be applied, not ignored as another session")
        XCTAssertEqual(store.transcript.first?.id, "gap-50", "the gap must be stated in the transcript")
        XCTAssertEqual(store.lastSeenEventId, 50)
        XCTAssertEqual(store.syncState, .current)
    }

    /// A first launch (cursor 0) has shown nothing, so a truncated page is not a gap to report.
    func testTruncatedPageOnFreshCursorAddsNoGapLine() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 50, skipped: 0, firstEventId: 40, truncated: true)),
            .success(EventsPage(events: [], lastEventId: 50, skipped: 0, firstEventId: 40)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertFalse(store.transcript.contains { $0.id.hasPrefix("gap-") })
        XCTAssertEqual(store.lastSeenEventId, 50, "the fresh-cursor page must still be applied, not skipped")
        XCTAssertEqual(store.syncState, .current)
    }

    /// A truncated page missing `firstEventId` falls back to the "expired on the bridge" gap
    /// line keyed by `lastEventId`, which must not carry any event id in its text.
    func testTruncatedPageWithoutFirstEventIdUsesLastEventIdGapLine() async throws {
        let defaults = freshDefaults()
        defaults.set(5, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 60, skipped: 0, truncated: true)),
            .success(EventsPage(events: [], lastEventId: 60, skipped: 0)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(store.transcript.first?.id, "gap-60")
        XCTAssertFalse(store.transcript.first?.text.contains { $0.isNumber } ?? true, "the fallback gap line must not name an event id")
    }

    /// A truncated page's `firstEventId` can be 0 after an empty-journal restart (bridge event
    /// ids start at 1, so 0 never named a real event); it must fall back to the same
    /// "expired on the bridge" line as a missing `firstEventId`, not report "event 0".
    func testTruncatedPageWithZeroFirstEventIdUsesLastEventIdGapLine() async throws {
        let defaults = freshDefaults()
        defaults.set(10, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 50, skipped: 0, firstEventId: 0, truncated: true)),
            .success(EventsPage(events: [], lastEventId: 50, skipped: 0)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertTrue(store.transcript.contains { $0.text == "Earlier events expired on the bridge" })
        XCTAssertFalse(store.transcript.contains { $0.text.contains("event 0") })
    }

    /// Regression for C-1: `discardLocalView()` must clear `lastQuestion`, or a `question.answered`
    /// on the far side of a gap whose answer id collides with a discarded question's option id
    /// would render the OLD question's label instead of falling back to the raw answer.
    func testDiscardLocalViewClearsLastQuestionAcrossGap() async throws {
        let defaults = freshDefaults()
        defaults.set(5, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)

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
                "options": [{ "id": "o1", "label": "Old label" }],
                "allowFreeText": true
            }
        }
        """)
        store.apply(questionRequested)

        let questionAnswered = try decodeEvent("""
        {
            "eventId": 60, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-18T00:00:00.000Z", "type": "question.answered",
            "payload": { "questionId": "q_2", "answer": "o1" }
        }
        """)
        await client.setEventsResults([
            .success(EventsPage(
                events: [questionAnswered], lastEventId: 60, skipped: 0,
                firstEventId: 60, truncated: true
            )),
            .success(EventsPage(events: [], lastEventId: 60, skipped: 0, firstEventId: 60)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertFalse(store.transcript.contains { $0.text == "Old label" }, "the discarded question's label must not survive the gap")
        XCTAssertTrue(store.transcript.contains { $0.text == "o1" }, "an answer with no live question must fall back to the raw option id")
    }

    /// Syncing until the first page is applied, asked for without a long-poll wait; current
    /// afterwards, and only then does the loop park in a long poll.
    func testSyncStateBecomesCurrentAfterFirstPageThenLongPolls() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        XCTAssertEqual(store.syncState, .disconnected)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.syncState, .current)
        XCTAssertTrue(store.connected, "current is a connected state")
        let waits = await client.waits
        XCTAssertEqual(waits.first, 0, "the first poll must not park for the full long-poll wait")
        XCTAssertEqual(waits.dropFirst().first, 20)
    }

    func testFailedPollReportsDisconnected() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([.failure(URLError(.cannotConnectToHost))])

        store.start()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(store.syncState, .disconnected)
        XCTAssertFalse(store.connected)
    }

    /// reconnect() discards the old host's cursor and session, so the old "Current" must not
    /// survive into the window before the new host's first page.
    func testReconnectDropsCurrentBeforeNewHostAnswers() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
            // The new generation's loop ends here instead of spinning (see the MARK note above).
            .failure(BridgeError.unauthenticated),
        ])
        await client.gateEventsCall(2)

        store.start()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.syncState, .current)

        await store.reconnect()
        XCTAssertEqual(store.syncState, .syncing, "the old host's Current must not outlive reconnect()")
        XCTAssertTrue(store.connected, "syncing counts as connected by design")
    }

    /// A poll that fails must not strand the store as disconnected forever: once the initial
    /// backoff elapses and the bridge answers again, the store recovers to current.
    func testSyncStateReturnsToCurrentAfterBridgeAnswersAgain() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            .failure(URLError(.cannotConnectToHost)),
            .success(EventsPage(events: [], lastEventId: 0, skipped: 0)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.syncState, .disconnected)

        // The retry waits out the 1s initial backoff; poll rather than sleep a fixed
        // amount so a slow runner does not fail the test. Call 3 is gated, which parks
        // the loop once the recovery page is applied.
        let deadline = ContinuousClock.now + .seconds(5)
        while store.syncState != .current && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(store.syncState, .current)
        XCTAssertTrue(store.connected)
    }

    /// A truncated page that also crosses into a later session must bind to that later
    /// session, not the first (now-superseded) event in the page: apply()'s bind-on-first-event
    /// fallback would otherwise leave the store on the old session and drop the new session's
    /// events under the cross-session guard.
    func testTruncatedPageCrossingSessionBindsToLaterSession() async throws {
        let defaults = freshDefaults()
        defaults.set(10, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)

        let oldSessionEvent = try decodeEvent("""
        {
            "eventId": 41, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-18T00:00:00.000Z", "type": "agent.message",
            "payload": { "messageId": "m1", "role": "assistant", "text": "from sess_1", "final": true }
        }
        """)
        let newSessionStarted = try decodeEvent("""
        {
            "eventId": 42, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-18T00:00:01.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        let newSessionEvent = try decodeEvent("""
        {
            "eventId": 43, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-18T00:00:02.000Z", "type": "agent.message",
            "payload": { "messageId": "m2", "role": "assistant", "text": "from sess_2", "final": true }
        }
        """)
        await client.setEventsResults([
            .success(EventsPage(
                events: [oldSessionEvent, newSessionStarted, newSessionEvent], lastEventId: 43, skipped: 0,
                firstEventId: 40, truncated: true
            )),
            .success(EventsPage(events: [], lastEventId: 43, skipped: 0, firstEventId: 40)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(store.sessionId, "sess_2", "the page's later session must win the binding")
        XCTAssertTrue(store.transcript.contains { $0.text == "from sess_2" }, "the later session's own event must be applied, not dropped by the cross-session guard")
        XCTAssertNotEqual(store.statusKind, .skippedEvents, "the later session must not be treated as a foreign session to ignore")
        XCTAssertTrue(store.transcript.contains { $0.text == "Earlier events expired on the bridge; showing from event 40" })
    }

    /// reconnect() drops the old host's cursor and bridgeId before polling the new host, so the
    /// new host's first page is applied as a plain continuation -- no gap line -- even though the
    /// store still remembered a bridgeId from the old host.
    func testReconnectAppliesNewHostFirstPageWithoutGapLine() async throws {
        let defaults = freshDefaults()
        defaults.set("brg_a", forKey: "dev.agentremote.watch.bridgeId")
        defaults.set(5, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)

        let newHostEvent = try decodeEvent("""
        {
            "eventId": 6, "sessionId": "sess_new", "provider": "mock",
            "timestamp": "2026-09-18T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        await client.setEventsResults([
            .success(EventsPage(events: [newHostEvent], lastEventId: 6, skipped: 0, bridgeId: "brg_b")),
        ])

        await store.reconnect()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertFalse(store.transcript.contains { $0.id.hasPrefix("gap-") }, "a fresh cursor against the new host must not report a gap")
        XCTAssertTrue(store.transcript.contains { $0.text == "Session sess_new started" }, "the new host's events must be applied")
        XCTAssertEqual(store.syncState, .current)
        XCTAssertEqual(defaults.string(forKey: "dev.agentremote.watch.bridgeId"), "brg_b", "the new host's bridgeId must replace the old one")
    }

    /// A bridgeId change resets sessionId to nil and resyncs from a full replay (not a gap
    /// page), so the same "bind to the later session in the page" rule from the gap case must
    /// also apply here, or a page crossing a session boundary right after a bridge change would
    /// get stuck on the first (superseded) session, same as the gap regression above.
    func testBridgeIdChangeCrossingSessionBindsToLaterSession() async throws {
        let defaults = freshDefaults()
        defaults.set("brg_a", forKey: "dev.agentremote.watch.bridgeId")
        let (store, client) = try await makeStoreWithPendingApproval(defaults: defaults)
        XCTAssertEqual(store.sessionId, "sess_1")

        let s1Started = try decodeEvent("""
        {
            "eventId": 1, "sessionId": "s1", "provider": "mock",
            "timestamp": "2026-09-18T00:00:00.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        let s1Event = try decodeEvent("""
        {
            "eventId": 2, "sessionId": "s1", "provider": "mock",
            "timestamp": "2026-09-18T00:00:01.000Z", "type": "agent.message",
            "payload": { "messageId": "m1", "role": "assistant", "text": "from s1", "final": true }
        }
        """)
        let s2Started = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "s2", "provider": "mock",
            "timestamp": "2026-09-18T00:00:02.000Z", "type": "session.started",
            "payload": { "projectId": "prj_demo", "resumed": false }
        }
        """)
        let s2Event = try decodeEvent("""
        {
            "eventId": 4, "sessionId": "s2", "provider": "mock",
            "timestamp": "2026-09-18T00:00:03.000Z", "type": "agent.message",
            "payload": { "messageId": "m2", "role": "assistant", "text": "from s2", "final": true }
        }
        """)
        await client.setEventsResults([
            // Triggers the bridgeChanged reset + continue: cursor and view are discarded,
            // sessionId becomes nil, and the loop re-requests a full replay from 0.
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
            // A full replay (not truncated) that still crosses a session boundary.
            .success(EventsPage(
                events: [s1Started, s1Event, s2Started, s2Event], lastEventId: 4, skipped: 0,
                bridgeId: "brg_b"
            )),
            .success(EventsPage(events: [], lastEventId: 4, skipped: 0, bridgeId: "brg_b")),
        ])
        await client.gateEventsCall(4)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(store.sessionId, "s2", "the later session in the replay must win the binding")
        XCTAssertTrue(store.transcript.contains { $0.text == "from s2" }, "the later session's own event must be applied, not dropped by the cross-session guard")
        XCTAssertNotEqual(store.statusKind, .skippedEvents, "the later session must not be treated as a foreign session to ignore")
    }

    /// After a bridgeId-change resync, the next events() request must ask for whatever is
    /// there now (wait 0), not a long-poll wait: the store is not yet known to be current
    /// against the new bridge, same reasoning as the fresh-cursor "syncing" case. The store
    /// starts from an already-.current poll, so the pre-reset wait would have been 20.
    func testBridgeIdChangeUsesZeroWaitOnResync() async throws {
        let client = FakeBridgeClient()
        let defaults = freshDefaults()
        let store = SessionStore(client: client, defaults: defaults)
        await client.setEventsResults([
            // Call 1: settles knownBridgeId to brg_a and brings syncState to .current, so
            // call 2 below is a genuine long-poll request (wait 20) before the change.
            .success(EventsPage(events: [], lastEventId: 2, skipped: 0, bridgeId: "brg_a")),
            // Call 2: a different bridgeId triggers the reset + continue path.
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
        ])
        await client.gateEventsCall(4)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        let waits = await client.waits
        // The gated call's wait is recorded before it blocks, so 4 calls have logged a wait
        // by the time call 4 parks.
        XCTAssertEqual(waits.count, 4)
        XCTAssertEqual(waits[1], 20, "call 2 must be a genuine long-poll from an already-current store")
        XCTAssertEqual(waits[2], 0, "the request right after a bridge-change resync must not long-poll")
    }

    /// The bridge-change reset path must clear a pending question card, same as a gap: the
    /// card's answer may have arrived in the pruned/superseded state and can never be
    /// resolved on this bridge.
    func testBridgeIdChangeClearsPendingQuestion() async throws {
        // A bridge only counts as changed once one is known; without this the first page
        // would just record brg_b and the reset path would never run.
        let defaults = freshDefaults()
        defaults.set("brg_a", forKey: "dev.agentremote.watch.bridgeId")
        let (store, client) = try await makeStoreWithPendingQuestion(defaults: defaults)
        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
            .success(EventsPage(events: [], lastEventId: 900, skipped: 0, bridgeId: "brg_b")),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(store.pendingQuestion, "a bridge change must not leave the old question card")
    }

    /// The gap-discard path must also clear a pending question card, not just the session and
    /// transcript: the events that would have resolved it were pruned and can never arrive.
    func testTruncatedGapClearsPendingQuestion() async throws {
        let defaults = freshDefaults()
        defaults.set(5, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)

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

        await client.setEventsResults([
            .success(EventsPage(events: [], lastEventId: 60, skipped: 0, firstEventId: 60, truncated: true)),
            .success(EventsPage(events: [], lastEventId: 60, skipped: 0, firstEventId: 60)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(store.pendingQuestion, "a truncated gap must not leave the old question card")
    }

    func testResolutionLineNamesTheActionWhenKnown() {
        XCTAssertEqual(SessionStore.resolutionLine(.rejected, title: "Run git push"), "Denied: Run git push")
        XCTAssertEqual(SessionStore.resolutionLine(.accepted, title: "Edit README.md"), "Allowed: Edit README.md")
        XCTAssertEqual(SessionStore.resolutionLine(.expired, title: nil), "Approval expired")
    }

    /// Drives approval.resolved through the real apply() path: a matching approvalId must surface
    /// the pending approval's own title, not just clear the card.
    func testApprovalResolvedNamesTheApprovalWhenIdMatches() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let resolved = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "rejected" }
        }
        """)
        store.apply(resolved)

        XCTAssertTrue(
            store.transcript.contains { $0.text == "Denied: Run git push origin main" },
            "a matching approvalId must surface the approval's own title"
        )
    }

    /// A resolved event whose approvalId does not match the pending approval must not misattribute
    /// that approval's title to an unrelated decision.
    func testApprovalResolvedFallsBackWhenApprovalIdDoesNotMatch() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let resolved = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_unrelated", "decision": "rejected" }
        }
        """)
        store.apply(resolved)

        XCTAssertFalse(
            store.transcript.contains { $0.text.contains("Run git push origin main") },
            "an unrelated approvalId must not borrow the pending approval's title"
        )
        XCTAssertTrue(
            store.transcript.contains { $0.text == "Approval denied" },
            "an unknown approvalId falls back to the decision alone"
        )
    }

    /// Drives approval.resolved with a cancelled decision through the real apply() path: the
    /// cancelled branch of resolutionLine() must render "Cancelled: <title>", not just clear the
    /// pending card (that alone is covered by testApprovalResolvedCancelledClearsPendingApproval).
    func testApprovalResolvedCancelledNamesTheApprovalWhenIdMatches() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let resolved = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "cancelled" }
        }
        """)
        store.apply(resolved)

        XCTAssertTrue(
            store.transcript.contains { $0.text == "Cancelled: Run git push origin main" },
            "a matching approvalId must surface the approval's own title on the cancelled branch"
        )
    }

    /// Drives approval.resolved with a superseded decision through the real apply() path: the
    /// superseded branch of resolutionLine() must render "Superseded: <title>" when the pending
    /// approval's id matches.
    func testApprovalResolvedSupersededNamesTheApprovalWhenIdMatches() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let resolved = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "superseded" }
        }
        """)
        store.apply(resolved)

        XCTAssertTrue(
            store.transcript.contains { $0.text == "Superseded: Run git push origin main" },
            "a matching approvalId must surface the approval's own title on the superseded branch"
        )
    }

    /// Drives approval.resolved with an accepted decision through the real apply() path: the
    /// accepted branch of resolutionLine() was previously only unit-tested directly, never
    /// through apply(); this exercises the full event-to-transcript mapping.
    func testApprovalResolvedAcceptedNamesTheApprovalWhenIdMatches() async throws {
        let (store, _) = try await makeStoreWithPendingApproval()

        let resolved = try decodeEvent("""
        {
            "eventId": 3, "sessionId": "sess_1", "provider": "mock",
            "timestamp": "2026-09-17T00:02:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "accepted" }
        }
        """)
        store.apply(resolved)

        XCTAssertTrue(
            store.transcript.contains { $0.text == "Allowed: Run git push origin main" },
            "a matching approvalId must surface the approval's own title on the accepted branch"
        )
    }

    /// Mirrors the C-1 discardLocalView regression written for lastQuestion: discarding the local
    /// view across a truncated gap must also clear lastApproval, or an approval.resolved on the far
    /// side whose approvalId happens to match the discarded approval would render its OLD title.
    func testDiscardLocalViewClearsLastApprovalAcrossGap() async throws {
        let defaults = freshDefaults()
        defaults.set(5, forKey: "dev.agentremote.watch.lastSeenEventId")
        let client = FakeBridgeClient()
        let store = SessionStore(client: client, defaults: defaults)

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
                "title": "Old title"
            }
        }
        """)
        store.apply(approvalRequested)

        let approvalResolved = try decodeEvent("""
        {
            "eventId": 60, "sessionId": "sess_2", "provider": "mock",
            "timestamp": "2026-09-18T00:00:00.000Z", "type": "approval.resolved",
            "payload": { "approvalId": "appr_1", "decision": "rejected" }
        }
        """)
        await client.setEventsResults([
            .success(EventsPage(
                events: [approvalResolved], lastEventId: 60, skipped: 0,
                firstEventId: 60, truncated: true
            )),
            .success(EventsPage(events: [], lastEventId: 60, skipped: 0, firstEventId: 60)),
        ])
        await client.gateEventsCall(3)

        store.start()
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertFalse(
            store.transcript.contains { $0.text == "Denied: Old title" },
            "the discarded approval's title must not survive the gap"
        )
        XCTAssertTrue(
            store.transcript.contains { $0.text == "Approval denied" },
            "an approvalId reused after discard must fall back to the decision alone"
        )
    }
}

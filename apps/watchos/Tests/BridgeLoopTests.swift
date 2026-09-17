import XCTest
import AgentRemoteProtocol

/// Drives the whole mock turn through the app's own BridgeClient against a running bridge.
/// The test skips itself when no bridge is listening, so it is safe in a plain build.
struct LoopTimeout: Error, CustomStringConvertible {
    let type: AgentEventType
    var description: String { "timed out waiting for \(type.rawValue)" }
}

final class BridgeLoopTests: XCTestCase {
    private var cursor = 0

    func testCompletesTheMockLoop() async throws {
        let client = BridgeClient()
        do {
            _ = try await client.sessions()
        } catch {
            throw XCTSkip("No bridge on \(BridgeClient.defaultBaseURL): \(error)")
        }

        // Start from the current end of the log so earlier runs do not leak in.
        cursor = try await client.events(after: 0, wait: 0).lastEventId

        let placeholder = UUID().uuidString
        let created = try await client.send(
            .sessionCreate(SessionCreatePayload(projectId: "prj_demo", provider: "mock")),
            sessionId: placeholder
        )
        let sessionId = try XCTUnwrap(created.sessionId, "session.create returned no sessionId")
        XCTAssertEqual(created.accepted, true)

        let started = try await waitForEvent(client, sessionId: sessionId, type: .sessionStarted)
        XCTAssertEqual(started.sessionId, sessionId)

        try await client.send(.promptSend(PromptSendPayload(text: "run the tests")), sessionId: sessionId)

        let approvalEvent = try await waitForEvent(client, sessionId: sessionId, type: .approvalRequested)
        guard case .approvalRequested(let approval) = approvalEvent.payload else {
            return XCTFail("expected an approval payload")
        }
        XCTAssertEqual(approval.title, "Run git push origin main")

        try await client.send(
            .approvalAccept(ApprovalAcceptPayload(binding: approval.binding)),
            sessionId: approval.binding.sessionId
        )
        let resolvedEvent = try await waitForEvent(client, sessionId: sessionId, type: .approvalResolved)
        guard case .approvalResolved(let resolved) = resolvedEvent.payload else {
            return XCTFail("expected an approval resolution payload")
        }
        XCTAssertEqual(resolved.decision, .accepted)

        let questionEvent = try await waitForEvent(client, sessionId: sessionId, type: .questionRequested)
        guard case .questionRequested(let question) = questionEvent.payload else {
            return XCTFail("expected a question payload")
        }
        XCTAssertFalse(question.options.isEmpty)

        let option = try XCTUnwrap(question.options.first { $0.id == "opt_yes" })
        try await client.send(
            .questionAnswer(QuestionAnswerPayload(questionId: question.questionId, optionId: option.id)),
            sessionId: sessionId
        )

        let messageEvent = try await waitForEvent(client, sessionId: sessionId, type: .agentMessage)
        guard case .agentMessage(let message) = messageEvent.payload else {
            return XCTFail("expected an agent message payload")
        }
        XCTAssertEqual(message.text, "Pushed to origin/main and opened a pull request.")

        _ = try await waitForEvent(client, sessionId: sessionId, type: .turnCompleted)
    }

    /// Long polls until an event of `type` for `sessionId` shows up, advancing the cursor.
    private func waitForEvent(
        _ client: BridgeClient,
        sessionId: String,
        type: AgentEventType,
        attempts: Int = 6
    ) async throws -> AgentEvent {
        for _ in 0 ..< attempts {
            let response = try await client.events(after: cursor, wait: 5)
            for event in response.events {
                cursor = max(cursor, event.eventId)
                if event.sessionId == sessionId, event.type == type {
                    return event
                }
            }
        }
        throw LoopTimeout(type: type)
    }
}

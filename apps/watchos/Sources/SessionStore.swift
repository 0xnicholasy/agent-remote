import Foundation
import Observation
import AgentRemoteProtocol

/// One line of the conversation as the Watch shows it.
struct TranscriptItem: Identifiable, Hashable {
    enum Role: Hashable { case user, agent, system }

    let id: String
    let role: Role
    let text: String
}

/// Explicit status kind for the status line, so views branch on a typed value instead of
/// matching a substring of the human-readable text.
enum StatusKind: Equatable {
    case notConnected
    case connected
    case skippedEvents
    case reconnecting
    case requestInvalid
    case error
}

enum TurnState: String {
    case idle, thinking, running, waiting, completed, error

    var label: String {
        switch self {
        case .idle: "Idle"
        case .thinking: "Thinking"
        case .running: "Running"
        case .waiting: "Waiting for you"
        case .completed: "Done"
        case .error: "Error"
        }
    }
}

/// Holds everything the views render. It owns the long-poll loop, the event cursor and the
/// outgoing commands; the views only read its properties and call its methods.
@MainActor
@Observable
final class SessionStore {
    private static let hostKey = "dev.agentremote.watch.host"
    private static let cursorKey = "dev.agentremote.watch.lastSeenEventId"
    private static let projectId = "prj_demo"
    private static let provider = "mock"

    private(set) var transcript: [TranscriptItem] = []
    private(set) var pendingApproval: ApprovalRequest?
    private(set) var pendingQuestion: QuestionRequestedPayload?
    private(set) var turnState: TurnState = .idle
    private(set) var sessionId: String?
    private(set) var lastSeenEventId: Int
    private(set) var connected = false
    private(set) var statusLine = "Not connected"
    private(set) var statusKind: StatusKind = .notConnected
    private(set) var isSending = false

    var hostText: String {
        didSet { UserDefaults.standard.set(hostText, forKey: SessionStore.hostKey) }
    }

    let speaker: Speaker
    @ObservationIgnored private let client: any BridgeClientProtocol
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    /// Bumped on every start()/reconnect() so a poll task from a superseded generation can
    /// tell its own results are stale even when it was not cancelled in time to observe it.
    @ObservationIgnored private var pollGeneration = 0
    /// Kept so an answered question can be shown by its label rather than its option id.
    @ObservationIgnored private var lastQuestion: QuestionRequestedPayload?

    /// `client` is injectable so tests can substitute a fake in place of a real `BridgeClient`.
    init(client: (any BridgeClientProtocol)? = nil, speaker: Speaker = Speaker()) {
        let defaults = UserDefaults.standard
        let stored = defaults.string(forKey: SessionStore.hostKey)
        let url = stored.flatMap(BridgeClient.parseBaseURL) ?? BridgeClient.defaultBaseURL
        hostText = stored ?? url.absoluteString
        lastSeenEventId = defaults.integer(forKey: SessionStore.cursorKey)
        self.client = client ?? BridgeClient(baseURL: url)
        self.speaker = speaker
    }

    // MARK: - Polling

    func start() {
        guard pollTask == nil else { return }
        pollGeneration += 1
        let generation = pollGeneration
        pollTask = Task { [weak self] in await self?.pollLoop(generation: generation) }
    }

    /// Applies a new host from Settings and restarts the poll loop against it.
    func reconnect() async {
        pollTask?.cancel()
        pollTask = nil
        pollGeneration += 1
        if let url = BridgeClient.parseBaseURL(hostText) {
            await client.setBaseURL(url)
        }
        resetCursor()
        // A new host means a different bridge and session space: drop the old binding and
        // its state, or every event from the new bridge's session would be silently
        // dropped by the cross-session guard in apply() until relaunch.
        sessionId = nil
        transcript.removeAll()
        pendingApproval = nil
        pendingQuestion = nil
        turnState = .idle
        start()
    }

    private func pollLoop(generation: Int) async {
        var backoff: Double = 1
        while !Task.isCancelled {
            do {
                let response = try await client.events(after: lastSeenEventId, wait: 20)
                // The old task's request can complete successfully after reconnect() moved on
                // to a new generation; drop it so it cannot re-bind sessionId to a stale bridge.
                if Task.isCancelled || generation != pollGeneration { return }
                connected = true
                backoff = 1
                // A restarted bridge numbers events from one again, so a cursor from the
                // previous run would silently skip the whole new log.
                if response.lastEventId < lastSeenEventId {
                    resetCursor()
                    continue
                }
                for event in response.events {
                    apply(event)
                }
                // Advances past skipped (undecodable) events too, not just the decoded ones.
                lastSeenEventId = max(lastSeenEventId, response.lastEventId)
                UserDefaults.standard.set(lastSeenEventId, forKey: SessionStore.cursorKey)
                if response.skipped > 0 {
                    statusLine = "Skipped \(response.skipped) unreadable events"
                    statusKind = .skippedEvents
                } else {
                    statusLine = "Connected"
                    statusKind = .connected
                }
            } catch {
                if Task.isCancelled { return }
                connected = false
                statusLine = "Reconnecting: \(error)"
                statusKind = .reconnecting
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 15)
            }
        }
    }

    private func resetCursor() {
        lastSeenEventId = 0
        UserDefaults.standard.set(0, forKey: SessionStore.cursorKey)
    }

    // MARK: - Event application

    // Not private: the unit test target compiles this file directly and drives the store
    // through decoded events instead of a running bridge.
    func apply(_ event: AgentEvent) {
        if case .sessionStarted = event.payload {
            // Already tracking a session: a session.started for a different id belongs to
            // someone else's session and must not reset this one's card, status, or transcript.
            if let current = sessionId, current != event.sessionId { return }
            sessionId = event.sessionId
            transcript.removeAll()
            pendingApproval = nil
            pendingQuestion = nil
            turnState = .idle
            append(.system, "Session \(event.sessionId) started", id: event.eventId)
            return
        }
        // Binds to the first event seen when no session.started has been observed yet, for
        // example right after relaunch with a cursor already past that event.
        if sessionId == nil { sessionId = event.sessionId }
        guard event.sessionId == sessionId else { return }

        switch event.payload {
        case .sessionStarted:
            break
        case .turnStarted(let payload):
            turnState = .thinking
            if let prompt = payload.prompt, !prompt.isEmpty {
                append(.user, prompt, id: event.eventId)
            }
        case .agentThinking(let payload):
            turnState = .thinking
            append(.system, payload.text, id: event.eventId)
        case .commandStarted(let payload):
            turnState = .running
            append(.system, "$ \(payload.command)", id: event.eventId)
        case .commandOutput(let payload):
            let chunk = payload.chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            if !chunk.isEmpty { append(.system, chunk, id: event.eventId) }
        case .commandCompleted(let payload):
            append(.system, "exit \(payload.exitCode)", id: event.eventId)
        case .agentMessage(let payload):
            append(.agent, payload.text, id: event.eventId)
            speaker.speak(payload.text)
        case .approvalRequested(let payload):
            pendingApproval = payload
            turnState = .waiting
            speaker.speak(payload.spokenSummary ?? payload.title)
        case .approvalResolved(let payload):
            pendingApproval = nil
            append(.system, "Approval \(payload.decision.rawValue)", id: event.eventId)
        case .questionRequested(let payload):
            pendingQuestion = payload
            lastQuestion = payload
            turnState = .waiting
            speaker.speak(payload.spokenSummary ?? payload.text)
        case .questionAnswered(let payload):
            pendingQuestion = nil
            let label = lastQuestion?.options.first { $0.id == payload.answer }?.label
            append(.user, label ?? payload.answer, id: event.eventId)
        case .turnCompleted:
            turnState = .completed
        case .sessionCompleted(let payload):
            turnState = payload.reason == .error ? .error : .completed
            append(.system, "Session \(payload.reason.rawValue)", id: event.eventId)
            // The session is over: release the binding so a later session.started (bridge- or
            // user-initiated) can rebind instead of being dropped by the guard above. A
            // terminal session has no bridge left to ack a pending card, so drop it here too
            // instead of leaving it stuck on screen with a no-op approve()/answer().
            sessionId = nil
            pendingApproval = nil
            pendingQuestion = nil
        case .error(let payload):
            turnState = .error
            append(.system, payload.message, id: event.eventId)
            // Only a fatal error ends the session; a recoverable one keeps the binding so
            // in-flight events for it are still applied.
            if payload.fatal {
                sessionId = nil
                pendingApproval = nil
                pendingQuestion = nil
            }
        case .fileRead(let payload):
            append(.system, "Read \(payload.path)", id: event.eventId)
        case .fileModified(let payload):
            append(.system, "\(payload.changeType.rawValue) \(payload.path)", id: event.eventId)
        case .usageUpdated:
            break
        }
    }

    private func append(_ role: TranscriptItem.Role, _ text: String, id: Int) {
        transcript.append(TranscriptItem(id: "e\(id)", role: role, text: text))
    }

    // MARK: - Commands

    @discardableResult
    func createSession() async -> String? {
        let placeholder = UUID().uuidString
        let payload = SessionCreatePayload(projectId: SessionStore.projectId, provider: SessionStore.provider)
        do {
            let response = try await client.send(.sessionCreate(payload), sessionId: placeholder)
            if let created = response.sessionId { sessionId = created }
            return response.sessionId
        } catch {
            report(error)
            return nil
        }
    }

    func sendPrompt(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var target = sessionId
        if target == nil { target = await createSession() }
        guard let target else { return }
        turnState = .thinking
        do {
            try await perform(.promptSend(PromptSendPayload(text: trimmed)), sessionId: target)
        } catch {
            report(error)
        }
    }

    func approve() async {
        guard !isSending, let request = pendingApproval else { return }
        isSending = true
        defer { isSending = false }
        do {
            try await perform(.approvalAccept(ApprovalAcceptPayload(binding: request.binding)), sessionId: request.binding.sessionId)
            // A newer approval could have arrived (via the poll loop) while this send was in
            // flight; only clear the card if it's still the one this call answered.
            if pendingApproval?.binding.approvalId == request.binding.approvalId { pendingApproval = nil }
        } catch BridgeError.http(let status, _) where status == 409 {
            if pendingApproval?.binding.approvalId == request.binding.approvalId { pendingApproval = nil }
            statusLine = "Request no longer valid"
            statusKind = .requestInvalid
        } catch {
            report(error)
        }
    }

    func reject() async {
        guard !isSending, let request = pendingApproval else { return }
        isSending = true
        defer { isSending = false }
        let payload = ApprovalRejectPayload(binding: request.binding, reason: "Denied from the Watch")
        do {
            try await perform(.approvalReject(payload), sessionId: request.binding.sessionId)
            if pendingApproval?.binding.approvalId == request.binding.approvalId { pendingApproval = nil }
        } catch BridgeError.http(let status, _) where status == 409 {
            if pendingApproval?.binding.approvalId == request.binding.approvalId { pendingApproval = nil }
            statusLine = "Request no longer valid"
            statusKind = .requestInvalid
        } catch {
            report(error)
        }
    }

    func answer(optionId: String) async {
        guard !isSending, let question = pendingQuestion, let target = sessionId else { return }
        isSending = true
        defer { isSending = false }
        let payload = QuestionAnswerPayload(questionId: question.questionId, optionId: optionId)
        do {
            try await perform(.questionAnswer(payload), sessionId: target)
            // A newer question could have arrived while this send was in flight; only clear
            // the card if it's still the one this call answered.
            if pendingQuestion?.questionId == question.questionId { pendingQuestion = nil }
        } catch BridgeError.http(let status, _) where status == 409 {
            if pendingQuestion?.questionId == question.questionId { pendingQuestion = nil }
            statusLine = "Request no longer valid"
            statusKind = .requestInvalid
        } catch {
            report(error)
        }
    }

    func answer(text: String) async {
        guard !isSending, let question = pendingQuestion, let target = sessionId else { return }
        isSending = true
        defer { isSending = false }
        let payload = QuestionAnswerPayload(questionId: question.questionId, text: text)
        do {
            try await perform(.questionAnswer(payload), sessionId: target)
            if pendingQuestion?.questionId == question.questionId { pendingQuestion = nil }
        } catch BridgeError.http(let status, _) where status == 409 {
            if pendingQuestion?.questionId == question.questionId { pendingQuestion = nil }
            statusLine = "Request no longer valid"
            statusKind = .requestInvalid
        } catch {
            report(error)
        }
    }

    func cancel() async {
        guard let target = sessionId else { return }
        do {
            try await perform(.sessionCancel(SessionCancelPayload(reason: "Cancelled from the Watch")), sessionId: target)
        } catch {
            report(error)
        }
    }

    /// Routes free text to the pending question when there is one, and to a new prompt otherwise.
    func submitDictation(_ text: String) async {
        if pendingQuestion != nil {
            await answer(text: text)
        } else {
            await sendPrompt(text)
        }
    }

    private func perform(_ payload: CommandPayload, sessionId: String) async throws {
        try await client.send(payload, sessionId: sessionId)
    }

    private func report(_ error: any Error) {
        turnState = .error
        statusLine = "\(error)"
        statusKind = .error
    }
}

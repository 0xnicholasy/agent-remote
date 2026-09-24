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
    case authFailed
}

/// Whether what the Watch shows matches the bridge (docs/durability-v0.md, "Client recovery").
/// `current` only after a page has been applied, so the Watch never claims to be up to date
/// on the strength of a cursor it has not checked against the bridge.
enum SyncState: Equatable {
    case current, syncing, disconnected

    var label: String {
        switch self {
        case .current: "Current"
        case .syncing: "Syncing"
        case .disconnected: "Disconnected"
        }
    }
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
    private static let bridgeIdKey = "dev.agentremote.watch.bridgeId"
    private static let projectId = "prj_demo"
    private static let provider = "mock"

    private(set) var transcript: [TranscriptItem] = []
    private(set) var pendingApproval: ApprovalRequest?
    private(set) var pendingQuestion: QuestionRequestedPayload?
    private(set) var turnState: TurnState = .idle
    private(set) var sessionId: String?
    private(set) var lastSeenEventId: Int
    private(set) var syncState: SyncState = .disconnected
    var connected: Bool { syncState != .disconnected }
    private(set) var statusLine = "Not connected"
    private(set) var statusKind: StatusKind = .notConnected
    private(set) var isSending = false
    private(set) var paired = false
    private(set) var pairingError: String?

    var hostText: String {
        didSet { defaults.set(hostText, forKey: SessionStore.hostKey) }
    }

    let speaker: Speaker
    /// Where the host, cursor and bridge id persist. Injectable so each test gets its own suite
    /// instead of sharing standard defaults with every other test's still-running poll loop.
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let client: any BridgeClientProtocol
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    /// Bumped on every start()/reconnect() so a poll task from a superseded generation can
    /// tell its own results are stale even when it was not cancelled in time to observe it.
    @ObservationIgnored private var pollGeneration = 0
    /// Kept so an answered question can be shown by its label rather than its option id.
    @ObservationIgnored private var lastQuestion: QuestionRequestedPayload?
    /// The `bridgeId` the cursor belongs to. Persisted with the cursor, since a cursor is only
    /// meaningful against the bridge that issued it.
    @ObservationIgnored private var knownBridgeId: String?

    /// `client` is injectable so tests can substitute a fake in place of a real `BridgeClient`.
    init(client: (any BridgeClientProtocol)? = nil, speaker: Speaker = Speaker(), defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: SessionStore.hostKey)
        let url = stored.flatMap(BridgeClient.parseBaseURL) ?? BridgeClient.defaultBaseURL
        hostText = stored ?? url.absoluteString
        lastSeenEventId = defaults.integer(forKey: SessionStore.cursorKey)
        knownBridgeId = defaults.string(forKey: SessionStore.bridgeIdKey)
        self.client = client ?? BridgeClient(baseURL: url)
        self.speaker = speaker
    }

    // MARK: - Polling

    func start() {
        Task { [weak self] in await self?.refreshPairedState() }
        guard pollTask == nil else { return }
        pollGeneration += 1
        let generation = pollGeneration
        pollTask = Task { [weak self] in await self?.pollLoop(generation: generation) }
    }

    func refreshPairedState() async {
        paired = await client.isPaired()
    }

    /// Enrolls this Watch with the bridge currently set in `hostText`. On success the client
    /// stores the device credential and subsequent requests are signed.
    func pair(code: String, deviceName: String) async {
        pairingError = nil
        do {
            try await client.pair(code: code, deviceName: deviceName)
            paired = true
            start()
        } catch {
            paired = await client.isPaired()
            pairingError = "\(error)"
        }
    }

    /// Applies a new host from Settings and restarts the poll loop against it.
    func reconnect() async {
        pollTask?.cancel()
        pollTask = nil
        pollGeneration += 1
        // Before the await below: the old host's "Current" must not stay on screen while the
        // cursor and session it described are being discarded.
        syncState = .syncing
        if let url = BridgeClient.parseBaseURL(hostText) {
            await client.setBaseURL(url)
        }
        resetCursor()
        setKnownBridgeId(nil)
        // A new host means a different bridge and session space: drop the old binding and
        // its state, or every event from the new bridge's session would be silently
        // dropped by the cross-session guard in apply() until relaunch.
        resetSessionState()
        transcript.removeAll()
        turnState = .idle
        start()
    }

    /// Clears the session binding and its pending UI state. Shared by reconnect(), the terminal
    /// event branches in apply(), and the bridge-restart path in pollLoop() so a session that no
    /// longer has a live bridge behind it never leaves a stuck card or a dangling binding.
    private func resetSessionState() {
        sessionId = nil
        pendingApproval = nil
        pendingQuestion = nil
    }

    private func pollLoop(generation: Int) async {
        var backoff: Double = 1
        if generation == pollGeneration { syncState = .syncing }
        while !Task.isCancelled {
            do {
                // Until a page has been applied the Watch is not known to be current, so ask
                // for whatever is there now instead of parking in a long poll that would keep
                // "Syncing" on screen for the full wait when nothing is new.
                let wait = syncState == .current ? 20 : 0
                let response = try await client.events(after: lastSeenEventId, wait: wait)
                // The old task's request can complete successfully after reconnect() moved on
                // to a new generation; drop it so it cannot re-bind sessionId to a stale bridge.
                if Task.isCancelled || generation != pollGeneration { return }
                backoff = 1
                // A different bridgeId means a different bridge, or the same one with its state
                // wiped: the cursor, session and transcript all belong to a log that no longer
                // exists. Event ids are never reused within one bridge's state, so the id
                // rollback check only matters for a bridge that does not report a bridgeId.
                let bridgeChanged = response.bridgeId != nil
                    && knownBridgeId != nil
                    && response.bridgeId != knownBridgeId
                if bridgeChanged || response.lastEventId < lastSeenEventId {
                    resetCursor()
                    setKnownBridgeId(response.bridgeId)
                    discardLocalView()
                    syncState = .syncing
                    continue
                }
                if let bridgeId = response.bridgeId, bridgeId != knownBridgeId {
                    setKnownBridgeId(bridgeId)
                }
                // Set before applying events, or this would unconditionally clobber a more
                // specific status (e.g. "Ignored session") that apply() sets while handling
                // one of the events below.
                if response.skipped > 0 {
                    statusLine = "Skipped \(response.skipped) unreadable events"
                    statusKind = .skippedEvents
                } else {
                    statusLine = "Connected"
                    statusKind = .connected
                }
                // The events between the cursor and this page were pruned by retention, so
                // anything built from them (a pending card, the session binding) may be stale
                // and can never be corrected by a later page. Rebuild from this page instead.
                // A fresh cursor has shown nothing yet, so there is nothing to discard or report.
                let gap = response.truncated && lastSeenEventId > 0
                if gap { discardLocalView() }
                for event in response.events {
                    apply(event)
                }
                // Inserted after applying, or a session.started in the page would clear it.
                if gap {
                    if let first = response.firstEventId {
                        transcript.insert(TranscriptItem(
                            id: "gap-\(first)",
                            role: .system,
                            text: "Earlier events expired on the bridge; showing from event \(first)"
                        ), at: 0)
                    } else {
                        transcript.insert(TranscriptItem(
                            id: "gap-\(response.lastEventId)",
                            role: .system,
                            text: "Earlier events expired on the bridge"
                        ), at: 0)
                    }
                }
                // Advances past skipped (undecodable) events too, not just the decoded ones.
                lastSeenEventId = max(lastSeenEventId, response.lastEventId)
                defaults.set(lastSeenEventId, forKey: SessionStore.cursorKey)
                // The bridge returns every event after the cursor in one page, so once it is
                // applied the Watch matches the bridge as of this response.
                syncState = .current
            } catch {
                if Task.isCancelled || generation != pollGeneration { return }
                syncState = .disconnected
                // A revoked/unpaired/rejected credential will never succeed on retry: hammering
                // the bridge forever would just hide the real problem from the user, so stop the
                // loop here instead of backing off and trying again.
                if let bridgeError = error as? BridgeError, Self.isTerminalAuthFailure(bridgeError) {
                    statusLine = "Not authorized: \(bridgeError)"
                    statusKind = .authFailed
                    pollTask = nil
                    return
                }
                statusLine = "Reconnecting: \(error)"
                statusKind = .reconnecting
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 15)
            }
        }
    }

    /// Drops everything the Watch built from events it can no longer trust: the session
    /// binding, any pending card, the transcript and the turn pill. Shared by the bridge-change
    /// and truncated-cursor paths in pollLoop().
    private func discardLocalView() {
        resetSessionState()
        transcript.removeAll()
        turnState = .idle
    }

    private func setKnownBridgeId(_ bridgeId: String?) {
        knownBridgeId = bridgeId
        defaults.set(bridgeId, forKey: SessionStore.bridgeIdKey)
    }

    /// Distinguishes a terminal authentication failure -- no retry will ever fix a revoked,
    /// unpaired, or rejected device credential -- from a transient network/timeout error that
    /// the existing backoff-and-retry loop should keep handling unchanged.
    private static func isTerminalAuthFailure(_ error: BridgeError) -> Bool {
        switch error {
        case .notPaired, .unauthenticated, .deviceRevoked:
            true
        default:
            false
        }
    }

    private func resetCursor() {
        lastSeenEventId = 0
        defaults.set(0, forKey: SessionStore.cursorKey)
    }

    // MARK: - Event application

    // Not private: the unit test target compiles this file directly and drives the store
    // through decoded events instead of a running bridge.
    func apply(_ event: AgentEvent) {
        if case .sessionStarted = event.payload {
            // Already tracking a session: a session.started for a different id belongs to
            // someone else's session and must not reset this one's card, status, or transcript.
            if let current = sessionId, current != event.sessionId {
                statusLine = "Ignored session \(event.sessionId) (still on \(current))"
                statusKind = .skippedEvents
                return
            }
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
            resetSessionState()
        case .error(let payload):
            turnState = .error
            append(.system, payload.message, id: event.eventId)
            // Only a fatal error ends the session; a recoverable one keeps the binding so
            // in-flight events for it are still applied.
            if payload.fatal {
                resetSessionState()
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
        let generation = pollGeneration
        let payload = SessionCreatePayload(projectId: SessionStore.projectId, provider: SessionStore.provider)
        do {
            let response = try await client.send(.sessionCreate(payload), sessionId: placeholder)
            // reconnect() or a session.started for another session can run during the await
            // above; only bind if nothing has claimed sessionId since, or a poll loop hasn't
            // moved on to a new generation, otherwise this would rebind to a stale session.
            guard let created = response.sessionId,
                  generation == pollGeneration,
                  sessionId == nil || sessionId == created else {
                // The rebind guard rejected this response: the id it carries is not (and must
                // not become) the store's session, so callers like sendPrompt() must not treat
                // it as a valid target either.
                statusLine = "Session changed; prompt not sent"
                statusKind = .skippedEvents
                return nil
            }
            sessionId = created
            return created
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
            // Only touch the card/status if a newer approval hasn't already replaced this one,
            // or a still-valid card's status line would be stomped with a stale-request message.
            if pendingApproval?.binding.approvalId == request.binding.approvalId {
                pendingApproval = nil
                statusLine = "Request no longer valid"
                statusKind = .requestInvalid
            }
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
            if pendingApproval?.binding.approvalId == request.binding.approvalId {
                pendingApproval = nil
                statusLine = "Request no longer valid"
                statusKind = .requestInvalid
            }
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
            if pendingQuestion?.questionId == question.questionId {
                pendingQuestion = nil
                statusLine = "Request no longer valid"
                statusKind = .requestInvalid
            }
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
            if pendingQuestion?.questionId == question.questionId {
                pendingQuestion = nil
                statusLine = "Request no longer valid"
                statusKind = .requestInvalid
            }
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

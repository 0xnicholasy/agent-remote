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

/// The outcome of one approve, deny or answer sent from this Watch. Every send ends in one of
/// these, so the Watch never leaves an action looking done when it is not.
enum ActionOutcome: Equatable {
    case sending
    /// The bridge accepted the command.
    case acknowledged
    /// Refused because the card was already decided, cancelled or superseded elsewhere.
    case noLongerValid
    case expired
    /// No verdict reached the Watch; the card stays and the same choice can be sent again.
    case offline
    /// The bridge cannot say whether the command took effect.
    case indeterminate
    /// The bridge accepted the send but its reply could not be read; the card stays and the
    /// same choice can be sent again, which replays the recorded outcome under the same id.
    case unconfirmed
    /// Any other failure; the card stays for a retry.
    case failed
    /// The bridge is rate limiting this device; the card stays and the same choice can be
    /// sent again, same as offline.
    case rateLimited
    /// This Watch's credential is missing, rejected or revoked; retrying will not help until
    /// it is paired again.
    case authRequired
    /// The bridge's device policy does not allow this Watch that action or project; retrying
    /// the same command will be refused again.
    case notAllowed
    /// The desk-only gate (M4) refused this approval: the exact action was never shown to this
    /// Watch, so it cannot be allowed here. Kept distinct from `.notAllowed` so the message
    /// stays actionable ("review at the Mac") whether the refusal was caught locally in
    /// `approve()` (a stale-card race) or returned by the bridge as `review_at_desk`.
    case reviewAtDesk

    var label: String {
        switch self {
        case .sending: "Sending..."
        case .acknowledged: "Sent"
        case .noLongerValid: "No longer valid"
        case .expired: "Expired"
        case .offline: "Not sent: offline. Tap again to retry."
        case .indeterminate: "Outcome unknown. Check at the desk."
        case .unconfirmed: "Reply unreadable. Tap again to confirm."
        case .failed: "Not sent. Tap again to retry."
        case .rateLimited: "Bridge is busy. Tap again in a moment."
        case .authRequired: "Not sent: this Watch needs to be paired again."
        case .notAllowed: "Not allowed from this Watch."
        case .reviewAtDesk: "Review at the Mac before allowing."
        }
    }

    /// Status line for outcomes that remove the card, since the card can no longer show them.
    var statusText: String? {
        switch self {
        case .noLongerValid: "Request no longer valid"
        case .expired: "Decision expired before it reached the bridge"
        case .indeterminate: "Outcome unknown; check at the desk"
        case .authRequired: "Not authorized: pair this Watch again"
        case .notAllowed: "This Watch is not allowed to do that"
        case .reviewAtDesk: "This approval must be reviewed at the Mac before it can be allowed"
        default: nil
        }
    }

    static func classify(_ error: any Error) -> ActionOutcome {
        switch error {
        case BridgeError.decisionExpired: return .expired
        case BridgeError.commandIndeterminate: return .indeterminate
        case BridgeError.commandResponseUnreadable: return .unconfirmed
        case BridgeError.interactionNotPending, BridgeError.commandIdConflict: return .noLongerValid
        // Pre-typed 409 bodies, such as a stale approval binding.
        case BridgeError.http(let status, _) where status == 409: return .noLongerValid
        case BridgeError.rateLimited: return .rateLimited
        case BridgeError.notPaired, BridgeError.unauthenticated, BridgeError.deviceRevoked: return .authRequired
        // Static device policy: the same command will be refused again until re-enrolled.
        case BridgeError.actionNotAllowed, BridgeError.projectNotAllowed: return .notAllowed
        // Desk-only gate (M4): retrying approve() for this approval is refused again every time.
        // Its own case (not .notAllowed) so the Watch keeps the actionable "review at the Mac"
        // message instead of the generic device-policy refusal text.
        case BridgeError.reviewAtDesk: return .reviewAtDesk
        case let urlError as URLError where offlineCodes.contains(urlError.code): return .offline
        default: return .failed
        }
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost,
        .cannotFindHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff,
    ]
}

private enum DecisionCard {
    case approval(String)
    case question(String)

    var id: String {
        switch self {
        case .approval(let id), .question(let id): id
        }
    }
}

private struct UnconfirmedSend {
    let payload: CommandPayload
    let sessionId: String
    let commandId: String
    /// Body timestamp sent with `commandId`; a retry must resend it unchanged so the bridge's
    /// body digest for that commandId matches (see `BridgeClientProtocol.send`).
    let timestamp: String
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
    /// The event id of the most recent turnStarted, so a caller that captured it before showing
    /// UI (e.g. a confirmation dialog) can tell whether the turn it was shown for is still the
    /// one running when the user acts, or a stop/start happened underneath it.
    private(set) var currentTurnId: Int?
    /// True between sendPrompt() and the turnStarted that answers it. Separates "this turn's id
    /// is not known yet because it was just sent from here" from "a turn is running whose
    /// turnStarted was never seen" (e.g. a gap replay that starts mid-turn): both leave
    /// currentTurnId nil, but only the first may later be bound to the next turnStarted's id.
    private(set) var awaitingLocalTurnStart = false
    /// The id turnStarted bound `awaitingLocalTurnStart` to, kept so `.pendingLocal` stays
    /// current through the very turnStarted that resolves it: applying a reconnect page can
    /// run turnStarted's write to `currentTurnId` and a later turn's own start in one
    /// synchronous loop, so a view's onChange never fires in between and must not be relied on
    /// to rebind. Cleared on session reset and on the next sendPrompt(), so it never outlives
    /// the turn it names.
    @ObservationIgnored private var localResolvedTurnId: Int?
    private(set) var sessionId: String?
    private(set) var lastSeenEventId: Int
    private(set) var syncState: SyncState = .disconnected
    var connected: Bool { syncState != .disconnected }
    private(set) var statusLine = "Not connected"
    private(set) var statusKind: StatusKind = .notConnected
    private(set) var isSending = false
    /// What happened to the last approve, deny or answer sent from this Watch, and which card
    /// it was for, so a newer card never shows an older card's outcome.
    private(set) var actionOutcome: ActionOutcome?
    @ObservationIgnored private var actionOutcomeCardId: String?
    @ObservationIgnored private var unconfirmedSend: UnconfirmedSend?
    /// A cancel whose outcome never reached the Watch; retrying reuses its command id.
    @ObservationIgnored private var unconfirmedCancel: UnconfirmedSend?
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
    /// Kept so a resolved approval can say what was decided, not only how.
    @ObservationIgnored private var lastApproval: ApprovalRequest?
    /// The `bridgeId` the cursor belongs to. Persisted with the cursor, since a cursor is only
    /// meaningful against the bridge that issued it.
    @ObservationIgnored private var knownBridgeId: String?
    /// The base URL the client is currently pointed at, tracked so reconnect() can tell whether
    /// it is reconnecting to the same bridge (retry an offline send) or a different one (a new
    /// bridge/pairing, where the old commandId must not be reused).
    @ObservationIgnored private var connectedHostURL: URL

    /// `client` is injectable so tests can substitute a fake in place of a real `BridgeClient`.
    init(client: (any BridgeClientProtocol)? = nil, speaker: Speaker = Speaker(), defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: SessionStore.hostKey)
        let url = stored.flatMap(BridgeClient.parseBaseURL) ?? BridgeClient.defaultBaseURL
        hostText = stored ?? url.absoluteString
        lastSeenEventId = defaults.integer(forKey: SessionStore.cursorKey)
        knownBridgeId = defaults.string(forKey: SessionStore.bridgeIdKey)
        connectedHostURL = url
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
        let newURL = BridgeClient.parseBaseURL(hostText)
        // Same host means the same bridge/pairing: an offline send's commandId is still safe to
        // reuse once the replayed card reappears, so keep it instead of minting a new one on
        // retry. A different (or unparseable) host is a different bridge/session space, so the
        // pending send is dropped along with everything else discardLocalView() clears below.
        let sameBridge = newURL != nil && newURL == connectedHostURL
        if let newURL {
            await client.setBaseURL(newURL)
            connectedHostURL = newURL
        }
        resetCursor()
        setKnownBridgeId(nil)
        // A new host means a different bridge and session space: drop the old binding and
        // its state, or every event from the new bridge's session would be silently
        // dropped by the cross-session guard in apply() until relaunch.
        discardLocalView(preservingUnconfirmedSend: sameBridge)
        start()
    }

    /// Clears the session binding and its pending UI state. Shared by reconnect(), the terminal
    /// event branches in apply(), and the bridge-restart path in pollLoop() so a session that no
    /// longer has a live bridge behind it never leaves a stuck card or a dangling binding.
    private func resetSessionState(preservingUnconfirmedSend: Bool = false) {
        sessionId = nil
        pendingApproval = nil
        pendingQuestion = nil
        currentTurnId = nil
        awaitingLocalTurnStart = false
        localResolvedTurnId = nil
        if !preservingUnconfirmedSend {
            unconfirmedSend = nil
            unconfirmedCancel = nil
        }
        actionOutcome = nil
        actionOutcomeCardId = nil
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
                if gap {
                    discardLocalView()
                }
                // Binding to the first event in the page (apply()'s fallback) is wrong when
                // the page also crosses into a later session: bind to the last session.started
                // in the page instead, so its events aren't dropped by the cross-session guard
                // below. This applies whenever the page is applied with no existing session
                // binding, not just after a gap: first launch, and the id-rollback and
                // bridgeId-change restart paths above all reset the cursor and discard the view
                // before falling through to a full replay here. No session.started in the page
                // leaves sessionId nil and falls back to apply()'s bind-on-first-event behavior
                // as before.
                if sessionId == nil {
                    if let lastStart = response.events.last(where: {
                        if case .sessionStarted = $0.payload { true } else { false }
                    }) {
                        sessionId = lastStart.sessionId
                    }
                }
                for event in response.events {
                    apply(event)
                }
                // Inserted after applying, or a session.started in the page would clear it.
                if gap {
                    if let first = response.firstEventId, first > 0 {
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
    private func discardLocalView(preservingUnconfirmedSend: Bool = false) {
        resetSessionState(preservingUnconfirmedSend: preservingUnconfirmedSend)
        transcript.removeAll()
        turnState = .idle
        lastQuestion = nil
        lastApproval = nil
    }

    /// "Denied: Run git push origin main". Falls back to the decision alone when the request is
    /// not known (it arrived before this page, or the view was discarded since).
    static func resolutionLine(_ decision: ApprovalDecision, title: String?) -> String {
        let outcome = switch decision {
        case .accepted: "Allowed"
        case .rejected: "Denied"
        case .expired: "Expired"
        case .cancelled: "Cancelled"
        case .superseded: "Superseded"
        }
        guard let title else { return "Approval \(outcome.lowercased())" }
        return "\(outcome): \(title)"
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
            currentTurnId = nil
            awaitingLocalTurnStart = false
            localResolvedTurnId = nil
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
            currentTurnId = event.eventId
            if awaitingLocalTurnStart {
                localResolvedTurnId = event.eventId
            }
            awaitingLocalTurnStart = false
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
            lastApproval = payload
            turnState = .waiting
            speaker.speak(payload.spokenSummary ?? payload.title)
        case .approvalResolved(let payload):
            pendingApproval = nil
            // The transcript line below now carries the outcome, so a "Sent" banner left from
            // this or an earlier send must not reappear under it. Only when this resolution is
            // for the card the outcome belongs to: an unrelated approval/question id resolving
            // must not wipe a still-current card's outcome.
            if actionOutcomeCardId == payload.approvalId { clearOutcome() }
            let title = lastApproval?.binding.approvalId == payload.approvalId ? lastApproval?.title : nil
            append(.system, Self.resolutionLine(payload.decision, title: title), id: event.eventId)
        case .questionRequested(let payload):
            pendingQuestion = payload
            lastQuestion = payload
            turnState = .waiting
            speaker.speak(payload.spokenSummary ?? payload.text)
        case .questionAnswered(let payload):
            pendingQuestion = nil
            if actionOutcomeCardId == payload.questionId { clearOutcome() }
            let label = lastQuestion?.options.first { $0.id == payload.answer }?.label
            append(.user, label ?? payload.answer, id: event.eventId)
        case .turnCompleted:
            turnState = .completed
            awaitingLocalTurnStart = false
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
            awaitingLocalTurnStart = false
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
        // The real turn id is not known until turnStarted arrives; clearing it here (rather
        // than leaving the previous turn's id) stops a Stop-turn dialog opened in this window
        // from being guarded against the wrong, stale id when that event lands.
        currentTurnId = nil
        awaitingLocalTurnStart = true
        localResolvedTurnId = nil
        do {
            try await perform(.promptSend(PromptSendPayload(text: trimmed)), sessionId: target)
        } catch {
            report(error)
        }
    }

    func approve() async {
        guard let request = pendingApproval else { return }
        // Desk-only gate (M4): the exact action was not shown, so nothing is sent. The bridge
        // would refuse this with `review_at_desk` anyway; refusing here as well means a Watch
        // that somehow rendered an Allow button for this card (it should not, per
        // `ChoiceCardView`) still cannot use it to authorize an action it never displayed.
        // Surface the refusal through the same outcome slot decide() uses, so a stale-card race
        // (pendingApproval flips to a desk-only card between the button being shown and this
        // call running) still leaves the user something to see instead of a silent no-op. The
        // card itself stays -- nothing was sent, so nothing was decided.
        guard !request.requiresDeskReview else {
            setOutcome(.reviewAtDesk, for: .approval(request.binding.approvalId))
            return
        }
        await decide(
            .approvalAccept(ApprovalAcceptPayload(binding: request.binding)),
            sessionId: request.binding.sessionId,
            card: .approval(request.binding.approvalId)
        )
    }

    func reject() async {
        guard let request = pendingApproval else { return }
        await decide(
            .approvalReject(ApprovalRejectPayload(binding: request.binding, reason: "Denied from the Watch")),
            sessionId: request.binding.sessionId,
            card: .approval(request.binding.approvalId)
        )
    }

    func answer(optionId: String) async {
        guard let question = pendingQuestion, let target = sessionId else { return }
        await decide(
            .questionAnswer(QuestionAnswerPayload(questionId: question.questionId, optionId: optionId)),
            sessionId: target,
            card: .question(question.questionId)
        )
    }

    func answer(text: String) async {
        guard let question = pendingQuestion, let target = sessionId else { return }
        await decide(
            .questionAnswer(QuestionAnswerPayload(questionId: question.questionId, text: text)),
            sessionId: target,
            card: .question(question.questionId)
        )
    }

    /// Sends a decision for a pending card and records its outcome.
    ///
    /// A send that fails without reaching a verdict (no connection, lost response, rate limit,
    /// or any other indeterminate failure) keeps the card and remembers the command id.
    /// Repeating the same choice reuses that id, so if the first send did land the bridge
    /// returns its recorded outcome instead of refusing the retry as no longer pending, or
    /// double-applying it. A different choice gets a fresh id.
    private func decide(_ payload: CommandPayload, sessionId: String, card: DecisionCard) async {
        guard !isSending else { return }
        isSending = true
        defer { isSending = false }
        // Bumped by reconnect(); if it moves while the send is in flight, this call's response
        // belongs to a bridge binding that has since been discarded, so it must not resurrect
        // a card or status line for it (mirrors the guard in createSession()).
        let generation = pollGeneration
        let commandId: String
        let timestamp: String
        if let unconfirmed = unconfirmedSend, unconfirmed.payload == payload, unconfirmed.sessionId == sessionId {
            commandId = unconfirmed.commandId
            timestamp = unconfirmed.timestamp
        } else {
            commandId = UUID().uuidString
            timestamp = BridgeClient.timestamp()
        }
        setOutcome(.sending, for: card)
        do {
            try await client.send(payload, sessionId: sessionId, commandId: commandId, timestamp: timestamp)
            guard generation == pollGeneration else { return }
            unconfirmedSend = nil
            // If the resolution event already removed the card, its transcript line shows the
            // outcome and a "Sent" banner would only linger under it.
            guard isCurrent(card) else {
                if actionOutcomeCardId == card.id { clearOutcome() }
                return
            }
            setOutcome(.acknowledged, for: card)
            clearCard(card)
        } catch {
            guard generation == pollGeneration else { return }
            unconfirmedSend = nil
            let outcome = ActionOutcome.classify(error)
            switch outcome {
            case .offline, .failed, .rateLimited, .unconfirmed:
                // Keep the card so the choice can be retried, and remember the command id: the
                // send may have reached the bridge even though its outcome did not reach the
                // Watch, so a retry must reuse it rather than mint a fresh one (which the bridge
                // would treat as a distinct command).
                guard isCurrent(card) else {
                    if actionOutcomeCardId == card.id { clearOutcome() }
                    return
                }
                unconfirmedSend = UnconfirmedSend(
                    payload: payload, sessionId: sessionId, commandId: commandId, timestamp: timestamp
                )
                setOutcome(outcome, for: card)
                if outcome == .failed { report(error) }
            case .reviewAtDesk:
                // The bridge refused this as desk-only, same as the local guard in approve()
                // (~line 620): the approval is still pending there, so the card -- and the Deny
                // button -- must stay. Only the outcome slot changes.
                guard isCurrent(card) else {
                    if actionOutcomeCardId == card.id { clearOutcome() }
                    return
                }
                setOutcome(.reviewAtDesk, for: card)
            case let terminal:
                // A newer card can have replaced this one while the send was in flight (same
                // guard the offline/failed/rateLimited branch above already applies). Bail out
                // before touching the outcome slot or the status line: this stale send's outcome
                // must not land on the new card's outcome slot (wrong id) or stomp whatever
                // status the new card has already set. Still clear the .sending placeholder this
                // call wrote at the top if it's still ours, or it would linger forever.
                guard isCurrent(card) else {
                    if actionOutcomeCardId == card.id { clearOutcome() }
                    return
                }
                setOutcome(terminal, for: card)
                clearCard(card)
                statusLine = terminal.statusText ?? statusLine
                statusKind = terminal == .authRequired ? .authFailed : .requestInvalid
            }
        }
    }

    /// The outcome to show on the card with this approval or question id, if the last send was
    /// for it.
    func outcome(forCard id: String) -> ActionOutcome? {
        actionOutcomeCardId == id ? actionOutcome : nil
    }

    private func clearOutcome() {
        actionOutcome = nil
        actionOutcomeCardId = nil
    }

    private func setOutcome(_ outcome: ActionOutcome, for card: DecisionCard) {
        actionOutcomeCardId = card.id
        actionOutcome = outcome
    }

    private func isCurrent(_ card: DecisionCard) -> Bool {
        switch card {
        case .approval(let id): pendingApproval?.binding.approvalId == id
        case .question(let id): pendingQuestion?.questionId == id
        }
    }

    /// A newer card could have arrived (via the poll loop) while the send was in flight; only
    /// clear the one this call answered.
    private func clearCard(_ card: DecisionCard) {
        guard isCurrent(card) else { return }
        switch card {
        case .approval: pendingApproval = nil
        case .question: pendingQuestion = nil
        }
    }

    /// Cancels the running turn. A cancel whose outcome did not reach the Watch keeps its
    /// command id, so tapping Cancel again replays the bridge's recorded outcome instead of
    /// sending a second, distinct cancel (same rule as `decide`).
    func cancel() async {
        guard let target = sessionId else { return }
        guard !isSending else { return }
        isSending = true
        defer { isSending = false }
        // Bumped by reconnect(); if it moves while the send is in flight, this call's response
        // belongs to a bridge binding that has since been discarded, so it must not resurrect
        // state for it (mirrors the guard in decide()/createSession()).
        let generation = pollGeneration
        let payload = CommandPayload.sessionCancel(SessionCancelPayload(reason: "Cancelled from the Watch"))
        let retry = unconfirmedCancel?.sessionId == target ? unconfirmedCancel : nil
        let commandId = retry?.commandId ?? UUID().uuidString
        let timestamp = retry?.timestamp ?? BridgeClient.timestamp()
        do {
            try await client.send(payload, sessionId: target, commandId: commandId, timestamp: timestamp)
            // Mirrors decide()'s isCurrent(card) guard: the session this cancel was sent for may
            // have completed (or been superseded) while the send was in flight, in which case its
            // resetSessionState() already cleared unconfirmedCancel/status correctly and this
            // stale reply must not resurrect or stomp any of it.
            guard generation == pollGeneration, target == sessionId else { return }
            unconfirmedCancel = nil
        } catch {
            guard generation == pollGeneration, target == sessionId else { return }
            switch ActionOutcome.classify(error) {
            case .offline, .failed, .rateLimited, .unconfirmed:
                unconfirmedCancel = UnconfirmedSend(
                    payload: payload, sessionId: target, commandId: commandId, timestamp: timestamp
                )
            default:
                unconfirmedCancel = nil
            }
            report(error)
        }
    }

    /// Which turn a Stop-turn confirmation was opened for. Captured when the dialog opens and
    /// checked when the user confirms, so a confirm never reaches a different turn.
    enum StopTurnTarget: Equatable {
        /// A turn whose turnStarted was seen.
        case turn(Int)
        /// The turn sendPrompt() just asked for; its id is not known yet.
        case pendingLocal
        /// A running turn whose turnStarted was never seen (e.g. joined mid-turn by a replay).
        case unknown
    }

    var stopTurnTarget: StopTurnTarget {
        if let currentTurnId { return .turn(currentTurnId) }
        return awaitingLocalTurnStart ? .pendingLocal : .unknown
    }

    /// Whether confirming a Stop opened for `target` would still cancel that same turn. Resolved
    /// entirely from store state rather than a view's onChange, so it gives the right answer
    /// even when a reconnect page applies several events (e.g. this turn's completed followed by
    /// a new turn's started) in one synchronous loop, with no render pass in between to observe.
    func isStopTargetCurrent(_ target: StopTurnTarget) -> Bool {
        guard canCancelTurn else { return false }
        switch target {
        case .turn(let id):
            return currentTurnId == id
        case .pendingLocal:
            // Still current either while the id is still unknown, or once it has resolved to
            // this turn's own turnStarted -- but not once a later, unrelated turn has started.
            return awaitingLocalTurnStart
                || (localResolvedTurnId != nil && currentTurnId == localResolvedTurnId)
        case .unknown:
            return currentTurnId == nil && !awaitingLocalTurnStart
        }
    }

    /// Whether a turn is in progress that Cancel would stop, so the conversation page can offer
    /// it where the user is already looking instead of only in Settings.
    var canCancelTurn: Bool {
        sessionId != nil && [.thinking, .running, .waiting].contains(turnState)
    }

    /// Where dictated text will go, shown on the review screen before it is sent: the pending
    /// question it answers, or a new prompt. Mirrors the routing in `submitDictation`.
    var dictationDestination: String {
        if let question = pendingQuestion { return "Answer to: \(question.text)" }
        return "New prompt"
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
        awaitingLocalTurnStart = false
        statusLine = "\(error)"
        statusKind = .error
    }
}

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
    /// Internal (not private) so OnboardingView can check whether `hostText` came from the
    /// launch-argument domain (the UI test path) without duplicating this string.
    static let hostKey = "dev.agentremote.watch.host"
    private static let cursorKey = "dev.agentremote.watch.lastSeenEventId"
    private static let bridgeIdKey = "dev.agentremote.watch.bridgeId"
    private static let projectIdKey = "dev.agentremote.watch.projectId"
    private static let advanceKey = "dev.agentremote.watch.advanceToNextRequest"

    /// Every session this device can see, keyed by session id. Events for any of them are
    /// applied to their own model; the properties below read the selected one.
    private(set) var sessions: [String: SessionModel] = [:]
    /// The session the conversation page shows and that prompts, decisions and cancel go to.
    /// Stays set after that session ends, so its transcript remains readable.
    private(set) var selectedSessionId: String?
    /// Bumped only when the user explicitly picks a session (selectSession), never when apply()
    /// auto-selects one. createSession() compares this to decide whether an automatic selection
    /// happened during its await, which must not block it from selecting the session it created.
    @ObservationIgnored private var userSelectionCount = 0
    private var selected: SessionModel? { selectedSessionId.flatMap { sessions[$0] } }

    /// The selected session while it can still take commands: nil when nothing is selected or
    /// the selected session has ended. A selected id whose model has not arrived yet (created
    /// here, `session.started` still in flight) counts as live.
    var sessionId: String? {
        guard let id = selectedSessionId, sessions[id]?.ended != true else { return nil }
        return id
    }
    var transcript: [TranscriptItem] { selected?.transcript ?? gapNotice.map { [$0] } ?? [] }
    /// A gap line from a page that left no session to hold it, shown until one exists.
    private var gapNotice: TranscriptItem?
    var pendingApproval: ApprovalRequest? { selected?.pendingApproval }
    var pendingQuestion: QuestionRequestedPayload? { selected?.pendingQuestion }
    var turnState: TurnState { selected?.turnState ?? .idle }
    /// The event id of the most recent turnStarted, so a caller that captured it before showing
    /// UI (e.g. a confirmation dialog) can tell whether the turn it was shown for is still the
    /// one running when the user acts, or a stop/start happened underneath it.
    var currentTurnId: Int? { selected?.currentTurnId }
    /// True between sendPrompt() and the turnStarted that answers it. Separates "this turn's id
    /// is not known yet because it was just sent from here" from "a turn is running whose
    /// turnStarted was never seen" (e.g. a gap replay that starts mid-turn): both leave
    /// currentTurnId nil, but only the first may later be bound to the next turnStarted's id.
    var awaitingLocalTurnStart: Bool { selected?.awaitingLocalTurnStart ?? false }
    /// The id turnStarted bound `awaitingLocalTurnStart` to, kept so `.pendingLocal` stays
    /// current through the very turnStarted that resolves it: applying a reconnect page can
    /// run turnStarted's write to `currentTurnId` and a later turn's own start in one
    /// synchronous loop, so a view's onChange never fires in between and must not be relied on
    /// to rebind. Cleared on session reset and on the next sendPrompt(), so it never outlives
    /// the turn it names.
    private var localResolvedTurnId: Int? { selected?.localResolvedTurnId }

    /// Waiting approvals and questions across every session, in inbox order.
    var pendingInteractions: [PendingInteraction] {
        sessions.values.flatMap(\.pendingInteractions).sorted(by: PendingInteraction.inboxOrder)
    }
    /// Requests waiting in sessions other than the selected one: the "N more waiting" badge.
    var otherWaitingCount: Int {
        pendingInteractions.filter { $0.sessionId != selectedSessionId }.count
    }
    /// Newest activity first.
    var sessionList: [SessionModel] {
        sessions.values.sorted { $0.lastEventId > $1.lastEventId }
    }
    /// After an approve, deny or answer lands, move to the next waiting request in another
    /// session. Persisted; on by default.
    var advanceToNextRequest: Bool {
        didSet { defaults.set(advanceToNextRequest, forKey: SessionStore.advanceKey) }
    }
    /// The projects this device may use (`GET /v1/projects`); empty until the first successful
    /// refreshBridgeConfiguration().
    var projects: [Project] { authorizedProjects }
    /// The provider id the bridge runs (`GET /v1/info`), which `session.create` must name.
    var bridgeProvider: String? { bridgeInfo?.provider }
    var selectedProject: Project? { projects.first { $0.id == selectedProjectId } }
    /// Several projects and none chosen: RootView asks once after pairing instead of letting
    /// the first Reply fail with "Pick a project".
    var needsProjectChoice: Bool { projects.count > 1 && selectedProject == nil }
    private(set) var lastSeenEventId: Int
    private(set) var syncState: SyncState = .disconnected
    var connected: Bool { syncState != .disconnected }
    private(set) var statusLine = "Not connected"
    private(set) var statusKind: StatusKind = .notConnected
    private(set) var bridgeInfo: BridgeInfo?
    private(set) var authorizedProjects: [Project] = []
    /// The project new sessions start in. Persisted; cleared when the bridge no longer lists it,
    /// and set automatically when the bridge lists exactly one project.
    private(set) var selectedProjectId: String? {
        didSet { defaults.set(selectedProjectId, forKey: SessionStore.projectIdKey) }
    }
    private(set) var configurationError: String?
    private(set) var isRefreshingConfiguration = false
    private(set) var isSending = false
    /// What happened to the last approve, deny or answer sent from this Watch, and which card
    /// it was for, so a newer card never shows an older card's outcome.
    private(set) var actionOutcome: ActionOutcome?
    @ObservationIgnored private var actionOutcomeCardId: String?
    @ObservationIgnored private var unconfirmedSends: [String: UnconfirmedSend] = [:]
    /// A cancel whose outcome never reached the Watch; retrying reuses its command id. Keyed by
    /// session id, same as `unconfirmedSends`.
    @ObservationIgnored private var unconfirmedCancels: [String: UnconfirmedSend] = [:]
    private(set) var paired = false
    private(set) var pairingError: String?
    /// Drives OnboardingView/PairingView through pairing v2's commit-then-reveal handshake.
    /// `.idle` until `beginPairing()` is called; `pick(_:)` and `cancelPairing()` are the only
    /// other entry points once a `.choosing` state is reached.
    enum PairingPhase: Equatable {
        case idle
        case starting
        /// `options` holds the correct code plus three distinct decoys, already shuffled;
        /// `correct` is the code shown on the Mac.
        case choosing(options: [Int], correct: Int)
        /// `code` is the option the user picked (== the correct code), kept so the view can
        /// keep showing it large while it waits for the Mac's confirmation.
        case waitingForMac(code: Int)
        case approved
        case denied
        case expired
        case cancelled
        case failed(String)
        /// The handshake never reached the bridge at all -- a network-level failure (host down,
        /// wrong port, no route), not a `pairing_closed`/`pairing_busy`/`pairing_rejected` answer
        /// from the bridge. Kept apart from `.failed` so the view can offer "Find my Mac" instead
        /// of just "Start again", and so a raw NSError/URLError description (which `.failed`
        /// would otherwise carry verbatim) never renders -- only `host` is shown here; the
        /// underlying error is logged instead (see `classifyPairingFailure`).
        case connectionFailure(host: String)

        /// True when the view may begin a fresh handshake from this phase.
        var canRestart: Bool {
            switch self {
            case .idle, .denied, .expired, .cancelled, .failed, .connectionFailure: true
            default: false
            }
        }
    }
    private(set) var pairingPhase: PairingPhase = .idle
    /// False until the first `refreshPairedState()` (or `pair()`) has resolved, so RootView can
    /// hold a plain ProgressView instead of flashing onboarding for an instant before the
    /// stored credential is known.
    private(set) var pairingChecked = false
    /// True once `paired` has been true at any point since launch, and never cleared again.
    /// RootView gates onboarding on this (rather than the live `paired`) so a paired->unpaired
    /// transition mid-session -- e.g. Settings "Connect" reconnecting to a host with no stored
    /// pairing -- keeps the user on the TabView (and Settings) instead of ejecting them into
    /// onboarding (E-001).
    private(set) var everPaired = false
    /// True when the last credential lookup failed to read rather than finding none (a
    /// Keychain error). Kept distinct from "not paired" so a transient read failure does not
    /// misroute a paired user to onboarding, or invite them to re-pair over a credential that
    /// may still be valid (E-002).
    private(set) var pairingCheckFailed = false

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
    /// Invalidates provider/project responses that were requested from a previous bridge.
    @ObservationIgnored private var configurationGeneration = 0
    /// Bumped on every refreshPairedState()/clearPairing() so a paired-state lookup from a
    /// superseded generation cannot overwrite a newer one: SessionStore is @MainActor but
    /// reentrant across awaits, so a concurrent reloadCredential()/clearPairing()/second
    /// refreshPairedState() can start and finish while an earlier one is still suspended on
    /// `await client...`.
    ///
    /// Kept separate from `pairingGeneration` below: `start()` (called by `reconnect()`, in turn
    /// called from onboarding's "Next" right before it navigates to `PairingView`) fires
    /// `refreshPairedState()` as an un-awaited `Task`. If the two flows shared one counter, that
    /// background refresh could bump it while `beginPairing()`'s handshake was still in flight,
    /// so `beginPairing()`'s own success guard would see a stale generation and silently drop a
    /// completed handshake -- leaving `pairingPhase` stuck on `.starting` forever even though the
    /// bridge had already completed `/v1/pair/start` and `/v1/pair/reveal`. Root cause of the
    /// "Starting pairing..." hang; regression test: SessionStoreDecisionTests.
    @ObservationIgnored private var pairedStateGeneration = 0
    /// Bumped on every beginPairing()/pick()/cancelPairing() so a stale handshake step cannot
    /// overwrite a newer one. See `pairedStateGeneration` above for why this is a separate
    /// counter rather than shared with the paired-state-refresh flow.
    @ObservationIgnored private var pairingGeneration = 0
    /// The pairing v2 request the Watch is currently waiting on the Mac for, set by
    /// `beginPairing()` and cleared once the handshake resolves or is cancelled.
    @ObservationIgnored private var pairingRequestId: String?
    @ObservationIgnored private(set) var pairingPollTask: Task<Void, Never>?
    /// True for the lifetime of a running `pollPairingLoop`, so `resumePairingPollingIfNeeded()`
    /// can tell a foreground-return apart from a loop that is still actually polling: a `Task`
    /// reference alone does not report whether the work it started has finished.
    @ObservationIgnored private var pairingPollActive = false
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
        selectedProjectId = defaults.string(forKey: SessionStore.projectIdKey)
        advanceToNextRequest = defaults.object(forKey: SessionStore.advanceKey) as? Bool ?? true
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
        pairedStateGeneration += 1
        let generation = pairedStateGeneration
        // A prior check found the Keychain read itself failed (E-002), so the cached
        // credential/error state is stale: reload before re-checking, or a Retry from
        // PairingCheckFailedView could never clear pairingCheckFailed. Either branch is a
        // single atomic actor call (PairingLookup), so there is no window between two reads
        // for a concurrent pair()/refreshPairedState() to interleave into.
        let lookup: PairingLookup
        if pairingCheckFailed {
            lookup = await client.reloadCredential()
        } else {
            lookup = await client.pairingLookup()
        }
        // A concurrent refreshPairedState()/pair() started after this one and may have already
        // applied a newer result; this stale lookup must not overwrite it.
        guard generation == pairedStateGeneration else { return }
        applyPairedLookup(lookup)
        pairingChecked = true
    }

    /// Starts pairing v2 (docs/pairing-v0.md, "Pairing"): the client runs the commit-then-reveal
    /// handshake and returns the locally derived 3-digit code. `pairingPhase` moves to
    /// `.choosing` with that code plus three distinct decoys, shuffled, so the view never
    /// reveals which option is correct by its position.
    func beginPairing() async {
        pairingGeneration += 1
        let generation = pairingGeneration
        pairingPhase = .starting
        do {
            let handshake = try await client.beginPairing(deviceName: "Apple Watch")
            guard generation == pairingGeneration else {
                // A concurrent cancelPairing() saw no requestId yet and sent nothing, so free
                // the bridge's slot here.
                // An unstructured Task does not inherit the caller's cancellation, so when Back
                // has already cancelled the view's .task the request is still sent (URLSession
                // fails immediately inside a cancelled task); awaiting .value keeps the
                // send-before-return ordering, and Task.value is not interrupted by the
                // awaiting task's cancellation.
                await Task { [client] in try? await client.cancelPairing(requestId: handshake.requestId) }.value
                return
            }
            pairingRequestId = handshake.requestId
            var decoys = Set<Int>()
            while decoys.count < 3 {
                let candidate = Int.random(in: 100 ... 999)
                if candidate != handshake.code { decoys.insert(candidate) }
            }
            var options = Array(decoys) + [handshake.code]
            options.shuffle()
            pairingPhase = .choosing(options: options, correct: handshake.code)
        } catch {
            guard generation == pairingGeneration else { return }
            pairingPhase = Self.classifyPairingFailure(error, host: hostText)
        }
    }

    /// `BridgeError` already carries a short, user-safe `description` (e.g. `.pairingClosed`,
    /// `.pairingBusy`, `.pairingRejected`) so those go straight into `.failed`. Anything else --
    /// a `URLError`/POSIX failure from `URLSession` because the bridge was unreachable -- is a
    /// connection failure: its raw description is logged (never shown), and the phase carries
    /// only the host so the view can show a short "can't reach" message with a way back to
    /// discovery.
    static func classifyPairingFailure(_ error: Error, host: String) -> PairingPhase {
        if let bridgeError = error as? BridgeError {
            return .failed(bridgeError.description)
        }
        if error is URLError {
            print("[SessionStore] pairing connection failure for \(host): \(error)")
            return .connectionFailure(host: host)
        }
        print("[SessionStore] pairing unexpected failure for \(host): \(error)")
        return .failed("Unexpected reply from the bridge")
    }

    /// The user tapped one of the four options shown. The correct pick moves to
    /// `.waitingForMac` and starts polling; any other pick (including "None match") cancels the
    /// handshake exactly as `cancelPairing()` does.
    func pick(_ option: Int) async {
        guard case .choosing(_, let correct) = pairingPhase, let requestId = pairingRequestId else { return }
        guard option == correct else {
            await cancelPairing()
            return
        }
        let generation = pairingGeneration
        pairingPhase = .waitingForMac(code: option)
        pairingPollTask = Task { [weak self] in await self?.pollPairingLoop(requestId: requestId, generation: generation) }
    }

    /// Called when the app returns to the foreground (`scenePhase == .active`). If the Watch is
    /// still waiting on the Mac's confirmation but the poll loop is not actually running --
    /// e.g. its `Task` was suspended/ended while the app was backgrounded -- restarts it, so a
    /// dimmed screen never leaves the Watch silently stuck on `.waitingForMac`.
    func resumePairingPollingIfNeeded() {
        guard case .waitingForMac = pairingPhase, let requestId = pairingRequestId, !pairingPollActive else { return }
        let generation = pairingGeneration
        pairingPollTask = Task { [weak self] in await self?.pollPairingLoop(requestId: requestId, generation: generation) }
    }

    /// Wrong pick, "None match", or the user backing out: tells the bridge to free the slot and
    /// moves to `.cancelled`. Best-effort -- the UI has already moved on by the time the network
    /// call resolves, since the Watch's own decision is final regardless of whether `/cancel`
    /// itself succeeds.
    func cancelPairing() async {
        pairingGeneration += 1
        pairingPollTask?.cancel()
        pairingPollTask = nil
        let requestId = pairingRequestId
        pairingRequestId = nil
        pairingPhase = .cancelled
        if let requestId {
            do {
                try await client.cancelPairing(requestId: requestId)
            } catch {
                print("[SessionStore] pairing cancel failed for \(hostText): \(error)")
            }
        }
    }

    /// Leaves the pairing flow for good: cancels a non-terminal handshake and returns the phase
    /// to `.idle` so the next PairingView can start a fresh one. Called when PairingView is
    /// dismissed from Settings, and (from `reconnect()`) when the bridge host
    /// changes. The success screen right after approval is unaffected because it is only reset
    /// once the view goes away.
    func dismissPairing() async {
        switch pairingPhase {
        case .starting, .choosing, .waitingForMac:
            await cancelPairing()
            // A new beginPairing() during the cancel's network await owns the phase now.
            guard pairingPhase == .cancelled else { return }
        default:
            break
        }
        pairingPhase = .idle
    }

    /// Same state transition as `dismissPairing()`, but the bridge's `/cancel` is sent from an
    /// unstructured Task that is not awaited, so an unreachable host cannot delay the caller
    /// (`reconnect()` switching hosts, E-116). The Task does not inherit the caller's
    /// cancellation, matching the E-91 cancel in `beginPairing()`.
    private func dismissPairingWithoutAwaitingCancel() {
        switch pairingPhase {
        case .starting, .choosing, .waitingForMac:
            pairingGeneration += 1
            pairingPollTask?.cancel()
            pairingPollTask = nil
            if let requestId = pairingRequestId {
                pairingRequestId = nil
                Task { [client] in try? await client.cancelPairing(requestId: requestId) }
            }
        default:
            break
        }
        pairingPhase = .idle
    }

    /// A network error during pairing status polling retries (1 s between attempts) for up to
    /// this long before finally giving up and showing a connection failure -- a dimmed screen or
    /// a momentary Wi-Fi blip must not strand the user on a silent "waiting" state. Instance-level
    /// and internal so `SessionStoreDecisionTests` can shorten it, the same way `client` is
    /// injectable; production code never writes it.
    @ObservationIgnored var pairingPollRetryCap: Duration = .seconds(60)

    /// Polls `GET /v1/pair/status` about once a second until the handshake resolves. Guarded by
    /// `generation` throughout so a `cancelPairing()`/new `beginPairing()` started while this
    /// loop is suspended on the network or the sleep stops it from ever writing a stale phase.
    ///
    /// A transient network error (the bridge briefly unreachable, Wi-Fi drop) is retried in
    /// place rather than immediately failing the handshake: `BridgeError` values are semantic
    /// answers from the bridge (e.g. the request expired or was denied) and still end the loop
    /// right away, but anything else keeps retrying, 1 s apart, until
    /// `pairingPollRetryCap` of retrying has elapsed.
    private func pollPairingLoop(requestId: String, generation: Int) async {
        pairingPollActive = true
        defer { pairingPollActive = false }
        var retryDeadline: ContinuousClock.Instant?
        while !Task.isCancelled {
            guard generation == pairingGeneration else { return }
            do {
                let result = try await client.pollPairing(requestId: requestId)
                guard generation == pairingGeneration else { return }
                retryDeadline = nil
                switch result {
                case .pending:
                    try? await Task.sleep(for: .seconds(1))
                    continue
                case .approved:
                    pairingRequestId = nil
                    pairingPhase = .approved
                    paired = true
                    everPaired = true
                    pairingCheckFailed = false
                    pairingChecked = true
                    start()
                    return
                case .denied:
                    pairingRequestId = nil
                    pairingPhase = .denied
                    return
                case .expired:
                    pairingRequestId = nil
                    pairingPhase = .expired
                    return
                }
            } catch {
                guard generation == pairingGeneration else { return }
                if let bridgeError = error as? BridgeError {
                    pairingRequestId = nil
                    pairingPhase = .failed(bridgeError.description)
                    return
                }
                guard error is URLError else {
                    pairingRequestId = nil
                    print("[SessionStore] pairing poll unexpected failure for \(hostText): \(error)")
                    pairingPhase = .failed("Unexpected reply from the bridge")
                    return
                }
                let deadline = retryDeadline ?? ContinuousClock.now + pairingPollRetryCap
                retryDeadline = deadline
                if ContinuousClock.now < deadline {
                    try? await Task.sleep(for: .seconds(1))
                    continue
                }
                pairingRequestId = nil
                print("[SessionStore] pairing poll connection failure for \(hostText): \(error)")
                pairingPhase = .connectionFailure(host: hostText)
                return
            }
        }
    }

    /// Clears the stored device credential and routes back to onboarding (R2-001): a
    /// permanently undecodable credential (corrupt keychain data, not a transient read error)
    /// would otherwise leave `PairingCheckFailedView`'s Retry failing forever with no way out
    /// short of deleting the app. Only ever called from the user's explicit "Pair again" tap --
    /// never automatically -- since this discards a credential that may still be valid.
    func clearPairing() async {
        pairedStateGeneration += 1
        let generation = pairedStateGeneration
        do {
            try await client.clearCredential()
        } catch {
            // The keychain delete itself failed: the old (possibly undecodable) credential is
            // still stored, so routing to onboarding here would just repeat the same failure on
            // next launch (V2-001). Stay on PairingCheckFailedView -- pairingCheckFailed stays
            // true, paired/everPaired untouched -- and surface the error so Retry/Pair again
            // remain reachable.
            guard generation == pairedStateGeneration else { return }
            pairingError = "Couldn't clear pairing: \(error)"
            return
        }
        guard generation == pairedStateGeneration else { return }
        paired = false
        everPaired = false
        pairingCheckFailed = false
        pairingError = nil
    }

    /// Applies a `PairingLookup`, distinguishing "no credential" from "the lookup failed to
    /// read" (E-002). Shared by `refreshPairedState()` and `pair()`'s failure path so both apply
    /// the same rule: a read failure must not be folded into "not paired" and leaves
    /// `paired`/`everPaired` untouched.
    private func applyPairedLookup(_ lookup: PairingLookup) {
        switch lookup {
        case .paired:
            paired = true
            everPaired = true
            pairingCheckFailed = false
            pairingError = nil
        case .checkFailed(let message):
            pairingCheckFailed = true
            pairingError = message
        case .notPaired:
            paired = false
            pairingCheckFailed = false
            pairingError = nil
        }
    }

    /// Applies a new host from Settings and restarts the poll loop against it.
    func reconnect() async {
        pollTask?.cancel()
        pollTask = nil
        pollGeneration += 1
        clearBridgeConfiguration()
        // Before the await below: the old host's "Current" must not stay on screen while the
        // cursor and session it described are being discarded.
        syncState = .syncing
        let newURL = BridgeClient.parseBaseURL(hostText)
        // Same host means the same bridge/pairing: an offline send's commandId is still safe to
        // reuse once the replayed card reappears, so keep it instead of minting a new one on
        // retry. A different (or unparseable) host is a different bridge/session space, so the
        // pending send is dropped along with everything else discardLocalView() clears below.
        let sameBridge = newURL != nil && newURL == connectedHostURL
        // The pairing phase (and any in-flight handshake) belongs to the old bridge: leaving
        // `.approved`/`.choosing` in place would make PairingView refuse to start a fresh
        // pairing against the new one (E-102). The old-host cancel is fired without awaiting
        // (E-116): the old Mac may be offline, and its request timeout must not stall the switch.
        if !sameBridge { dismissPairingWithoutAwaitingCancel() }
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

    /// Ends one session: its pending card and turn tracking go, its transcript stays. Called
    /// from apply() on `session.completed` and on a fatal error. A terminal session has no
    /// bridge left to ack a pending card, so leaving one would be a stuck card with a no-op
    /// approve()/answer().
    private func endSession(_ id: String) {
        guard var model = sessions[id] else { return }
        let cardIds = [model.pendingApproval?.binding.approvalId, model.pendingQuestion?.questionId]
        model.ended = true
        model.pendingApproval = nil
        model.pendingQuestion = nil
        model.currentTurnId = nil
        model.awaitingLocalTurnStart = false
        model.localResolvedTurnId = nil
        sessions[id] = model
        unconfirmedSends[id] = nil
        unconfirmedCancels[id] = nil
        if selectedSessionId == id || cardIds.contains(actionOutcomeCardId) { clearOutcome() }
    }

    /// Applies `body` to one session's model, creating the model on first sight.
    private func update(_ id: String, _ body: (inout SessionModel) -> Void) {
        var model = sessions[id] ?? SessionModel(id: id)
        body(&model)
        sessions[id] = model
    }

    /// The project's display name, or its id when the project list does not carry it.
    func projectName(_ projectId: String?) -> String {
        guard let projectId else { return "Session" }
        return projects.first { $0.id == projectId }?.name ?? projectId
    }

    /// Shows another session on the conversation page (inbox and session list taps).
    func selectSession(_ id: String) {
        guard sessions[id] != nil else { return }
        selectedSessionId = id
        userSelectionCount += 1
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
                    clearBridgeConfiguration()
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
                // the page also crosses into a later session: select the last session.started
                // in the page instead, so the page ends on the newest session rather than the
                // first one it mentions. This applies whenever the page is applied with no existing session
                // binding, not just after a gap: first launch, and the id-rollback and
                // bridgeId-change restart paths above all reset the cursor and discard the view
                // before falling through to a full replay here. No session.started in the page
                // leaves sessionId nil and falls back to apply()'s bind-on-first-event behavior
                // as before.
                if sessionId == nil {
                    if let lastStart = response.events.last(where: {
                        if case .sessionStarted = $0.payload { true } else { false }
                    }) {
                        selectedSessionId = lastStart.sessionId
                    }
                }
                for event in response.events {
                    apply(event)
                }
                // Inserted after applying, or a session.started in the page would clear it.
                if gap {
                    let line: TranscriptItem
                    if let first = response.firstEventId, first > 0 {
                        line = TranscriptItem(
                            id: "gap-\(first)",
                            role: .system,
                            text: "Earlier events expired on the bridge; showing from event \(first)"
                        )
                    } else {
                        line = TranscriptItem(
                            id: "gap-\(response.lastEventId)",
                            role: .system,
                            text: "Earlier events expired on the bridge"
                        )
                    }
                    // Every session rebuilt from this page lost its earlier events.
                    if let selectedSessionId, sessions[selectedSessionId] == nil {
                        sessions[selectedSessionId] = SessionModel(id: selectedSessionId)
                    }
                    for id in sessions.keys {
                        sessions[id]?.transcript.insert(line, at: 0)
                    }
                    if sessions.isEmpty { gapNotice = line }
                }
                // Advances past skipped (undecodable) events too, not just the decoded ones.
                lastSeenEventId = max(lastSeenEventId, response.lastEventId)
                defaults.set(lastSeenEventId, forKey: SessionStore.cursorKey)
                // The bridge returns every event after the cursor in one page, so once it is
                // applied the Watch matches the bridge as of this response.
                syncState = .current
                if bridgeInfo == nil && !isRefreshingConfiguration {
                    await refreshBridgeConfiguration(expectedPollGeneration: generation)
                }
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
        sessions.removeAll()
        gapNotice = nil
        selectedSessionId = nil
        if !preservingUnconfirmedSend {
            unconfirmedSends.removeAll()
            unconfirmedCancels.removeAll()
        }
        clearOutcome()
    }

    private func clearBridgeConfiguration() {
        configurationGeneration += 1
        bridgeInfo = nil
        authorizedProjects = []
        selectedProjectId = nil
        configurationError = nil
        isRefreshingConfiguration = false
    }

    func refreshBridgeConfiguration() async {
        await refreshBridgeConfiguration(expectedPollGeneration: pollGeneration)
    }

    /// Reloads the provider and projects; true when both loaded.
    @discardableResult
    func loadProjects() async -> Bool {
        await refreshBridgeConfiguration()
        return bridgeInfo != nil
    }

    private func refreshBridgeConfiguration(expectedPollGeneration: Int) async {
        configurationGeneration += 1
        let generation = configurationGeneration
        isRefreshingConfiguration = true
        configurationError = nil
        do {
            async let fetchedInfo = client.info()
            async let fetchedProjects = client.projects()
            let (info, projects) = try await (fetchedInfo, fetchedProjects)
            guard generation == configurationGeneration,
                  expectedPollGeneration == pollGeneration else { return }
            bridgeInfo = info
            authorizedProjects = projects
            if projects.count == 1 {
                selectedProjectId = projects[0].id
            } else if let selectedProjectId,
                      !projects.contains(where: { $0.id == selectedProjectId }) {
                self.selectedProjectId = nil
            }
            isRefreshingConfiguration = false
        } catch {
            guard generation == configurationGeneration,
                  expectedPollGeneration == pollGeneration else { return }
            bridgeInfo = nil
            authorizedProjects = []
            selectedProjectId = nil
            configurationError = "Could not load provider and projects"
            isRefreshingConfiguration = false
            report(error)
        }
    }

    func selectProject(_ projectId: String?) {
        guard let projectId else {
            selectedProjectId = nil
            return
        }
        guard authorizedProjects.contains(where: { $0.id == projectId }) else { return }
        selectedProjectId = projectId
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
        let id = event.sessionId
        if case .sessionStarted(let payload) = event.payload {
            // A (re)started id starts clean; every other session is left alone.
            var model = SessionModel(id: id, projectId: payload.projectId)
            model.lastEventId = event.eventId
            model.append(.system, "Session \(id) started", id: event.eventId)
            sessions[id] = model
            // Follow a new session only when nothing live is selected: a second session
            // starting elsewhere must not pull the page away from one still running.
            if sessionId == nil { selectedSessionId = id }
            return
        }
        // Selects the first session seen when nothing is selected yet, for example right
        // after relaunch with a cursor already past that session's session.started.
        if selectedSessionId == nil { selectedSessionId = id }
        let isSelected = id == selectedSessionId
        var model = sessions[id] ?? SessionModel(id: id)
        model.lastEventId = max(model.lastEventId, event.eventId)
        var endsSession = false

        switch event.payload {
        case .sessionStarted:
            break
        case .turnStarted(let payload):
            model.turnState = .thinking
            model.currentTurnId = event.eventId
            if model.awaitingLocalTurnStart {
                model.localResolvedTurnId = event.eventId
            }
            model.awaitingLocalTurnStart = false
            if let prompt = payload.prompt, !prompt.isEmpty {
                model.append(.user, prompt, id: event.eventId)
            }
        case .agentThinking(let payload):
            model.turnState = .thinking
            model.append(.system, payload.text, id: event.eventId)
        case .commandStarted(let payload):
            model.turnState = .running
            model.append(.system, "$ \(payload.command)", id: event.eventId)
        case .commandOutput(let payload):
            let chunk = payload.chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            if !chunk.isEmpty { model.append(.system, chunk, id: event.eventId) }
        case .commandCompleted(let payload):
            model.append(.system, "exit \(payload.exitCode)", id: event.eventId)
        case .agentMessage(let payload):
            model.append(.agent, payload.text, id: event.eventId)
            if isSelected { speaker.speak(payload.text) }
        case .approvalRequested(let payload):
            model.pendingApproval = payload
            model.lastApproval = payload
            model.pendingSinceEventId = event.eventId
            model.turnState = .waiting
            // Only the session on screen speaks, so two sessions asking at once do not talk
            // over each other; the others wait in the inbox.
            if isSelected { speaker.speak(payload.spokenSummary ?? payload.title) }
        case .approvalResolved(let payload):
            // Resolve by id only: a resolution for some other approval must not hide this one.
            if model.pendingApproval?.binding.approvalId == payload.approvalId {
                model.pendingApproval = nil
            }
            // The transcript line below now carries the outcome, so a "Sent" banner left from
            // this or an earlier send must not reappear under it. Only when this resolution is
            // for the card the outcome belongs to: an unrelated approval/question id resolving
            // must not wipe a still-current card's outcome.
            if actionOutcomeCardId == payload.approvalId { clearOutcome() }
            let title = model.lastApproval?.binding.approvalId == payload.approvalId ? model.lastApproval?.title : nil
            model.append(.system, Self.resolutionLine(payload.decision, title: title), id: event.eventId)
        case .questionRequested(let payload):
            model.pendingQuestion = payload
            model.lastQuestion = payload
            model.pendingSinceEventId = event.eventId
            model.turnState = .waiting
            if isSelected { speaker.speak(payload.spokenSummary ?? payload.text) }
        case .questionAnswered(let payload):
            if model.pendingQuestion?.questionId == payload.questionId {
                model.pendingQuestion = nil
            }
            if actionOutcomeCardId == payload.questionId { clearOutcome() }
            let label = model.lastQuestion?.options.first { $0.id == payload.answer }?.label
            model.append(.user, label ?? payload.answer, id: event.eventId)
        case .turnCompleted:
            model.turnState = .completed
            model.currentTurnId = nil
            model.awaitingLocalTurnStart = false
            model.localResolvedTurnId = nil
        case .sessionCompleted(let payload):
            model.turnState = payload.reason == .error ? .error : .completed
            model.append(.system, "Session \(payload.reason.rawValue)", id: event.eventId)
            endsSession = true
        case .error(let payload):
            model.append(.system, payload.message, id: event.eventId)
            // Only a fatal error ends the session; a recoverable one keeps it live so in-flight
            // events for it are still applied. turnState is only overwritten here when no turn
            // is tracked as cancelable -- otherwise a recoverable error arriving while a turn
            // is still running would hide the Stop-turn button.
            if payload.fatal {
                model.turnState = .error
                endsSession = true
            } else if !model.canCancelTurn {
                model.turnState = .error
            }
        case .fileRead(let payload):
            model.append(.system, "Read \(payload.path)", id: event.eventId)
        case .fileModified(let payload):
            model.append(.system, "\(payload.changeType.rawValue) \(payload.path)", id: event.eventId)
        case .usageUpdated:
            break
        }
        sessions[id] = model
        if endsSession { endSession(id) }
    }

    // MARK: - Commands

    @discardableResult
    func createSession() async -> String? {
        await refreshBridgeConfiguration()
        guard let bridgeInfo, let selectedProjectId else {
            statusLine = configurationError
                ?? (authorizedProjects.isEmpty
                    ? "No authorized project is available"
                    : "Choose a project before creating a session")
            statusKind = .error
            return nil
        }
        let placeholder = UUID().uuidString
        let generation = pollGeneration
        let configuration = configurationGeneration
        let payload = SessionCreatePayload(projectId: selectedProjectId, provider: bridgeInfo.provider)
        // Captured before the await: if the user explicitly picks a different session while this
        // call is in flight, that choice must win over this call selecting its newly created
        // session. An automatic selection made by apply() (e.g. selecting the first session seen
        // when nothing live is selected) does not count and must not block this from selecting.
        let userSelectionsAtStart = userSelectionCount
        do {
            let response = try await client.send(.sessionCreate(payload), sessionId: placeholder)
            // reconnect() can run during the await above; only select the new session if the
            // poll loop hasn't moved on to a new generation, otherwise this would select a
            // session on a bridge binding that has since been discarded.
            guard let created = response.sessionId,
                  generation == pollGeneration,
                  configuration == configurationGeneration else {
                // The rebind guard rejected this response: the id it carries is not (and must
                // not become) the store's session, so callers like sendPrompt() must not treat
                // it as a valid target either.
                statusLine = "Session changed; prompt not sent"
                statusKind = .skippedEvents
                return nil
            }
            if sessions[created] == nil {
                sessions[created] = SessionModel(id: created, projectId: payload.projectId)
            }
            if userSelectionCount == userSelectionsAtStart {
                selectedSessionId = created
            }
            return created
        } catch {
            report(error)
            return nil
        }
    }

    /// Returns whether the prompt was sent (a refused, empty or failed send returns false).
    @discardableResult
    func sendPrompt(_ text: String) async -> Bool {
        // The bridge rejects any prompt.send while a turn is already running (409). Refusing
        // here, before turnState/currentTurnId/awaitingLocalTurnStart are touched, keeps those
        // untouched too -- a rejected send must not hide the Stop button while the turn it
        // guards is still running.
        guard !canCancelTurn else {
            statusLine = "Turn in progress. Stop it or wait."
            statusKind = .error
            return false
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        var target = sessionId
        if target == nil { target = await createSession() }
        guard let target else { return false }
        update(target) { model in
            model.turnState = .thinking
            // The real turn id is not known until turnStarted arrives; clearing it here (rather
            // than leaving the previous turn's id) stops a Stop-turn dialog opened in this
            // window from being guarded against the wrong, stale id when that event lands.
            model.currentTurnId = nil
            model.awaitingLocalTurnStart = true
            model.localResolvedTurnId = nil
        }
        do {
            try await perform(.promptSend(PromptSendPayload(text: trimmed)), sessionId: target)
            return true
        } catch {
            // Only this send's own failure ends the wait for its turn; rollBackLocalTurn() is
            // scoped to sendPrompt's own optimistic state, unlike report() which is shared with
            // decide() and cancel() and must not touch turnState.
            rollBackLocalTurn(target)
            report(error)
            return false
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

    @discardableResult
    func answer(text: String) async -> Bool {
        guard let question = pendingQuestion, let target = sessionId else { return false }
        return await decide(
            .questionAnswer(QuestionAnswerPayload(questionId: question.questionId, text: text)),
            sessionId: target,
            card: .question(question.questionId)
        )
    }

    /// Sends a decision for a pending card and records its outcome. Returns whether the
    /// decision actually reached the bridge (the send did not throw) -- callers that clear
    /// UI state such as dictated text on success must gate that on this result, not on the
    /// call merely returning.
    ///
    /// A send that fails without reaching a verdict (no connection, lost response, rate limit,
    /// or any other indeterminate failure) keeps the card and remembers the command id.
    /// Repeating the same choice reuses that id, so if the first send did land the bridge
    /// returns its recorded outcome instead of refusing the retry as no longer pending, or
    /// double-applying it. A different choice gets a fresh id.
    @discardableResult
    private func decide(_ payload: CommandPayload, sessionId: String, card: DecisionCard) async -> Bool {
        guard !isSending else { return false }
        isSending = true
        defer { isSending = false }
        // Bumped by reconnect(); if it moves while the send is in flight, this call's response
        // belongs to a bridge binding that has since been discarded, so it must not resurrect
        // a card or status line for it (mirrors the guard in createSession()).
        let generation = pollGeneration
        let commandId: String
        let timestamp: String
        if let unconfirmed = unconfirmedSends[sessionId], unconfirmed.payload == payload {
            commandId = unconfirmed.commandId
            timestamp = unconfirmed.timestamp
        } else {
            commandId = UUID().uuidString
            timestamp = BridgeClient.timestamp()
        }
        setOutcome(.sending, for: card)
        do {
            try await client.send(payload, sessionId: sessionId, commandId: commandId, timestamp: timestamp)
            // The send itself succeeded (accepted by the bridge) regardless of what the guards
            // below do with local UI state, so every path out of this do block reports success.
            guard generation == pollGeneration else { return true }
            unconfirmedSends[sessionId] = nil
            // If the resolution event already removed the card, its transcript line shows the
            // outcome and a "Sent" banner would only linger under it.
            guard isCurrent(card) else {
                if actionOutcomeCardId == card.id { clearOutcome() }
                return true
            }
            setOutcome(.acknowledged, for: card)
            clearCard(card)
            advanceToNextWaiting(after: sessionId)
            return true
        } catch {
            // Every path below reports failure: the send did not land a confirmed decision, so
            // callers must not treat this as delivered (e.g. clearing dictated text).
            guard generation == pollGeneration else { return false }
            unconfirmedSends[sessionId] = nil
            let outcome = ActionOutcome.classify(error)
            switch outcome {
            case .offline, .failed, .rateLimited, .unconfirmed:
                // Keep the card so the choice can be retried, and remember the command id: the
                // send may have reached the bridge even though its outcome did not reach the
                // Watch, so a retry must reuse it rather than mint a fresh one (which the bridge
                // would treat as a distinct command).
                guard isCurrent(card) else {
                    if actionOutcomeCardId == card.id { clearOutcome() }
                    return false
                }
                unconfirmedSends[sessionId] = UnconfirmedSend(
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
                    return false
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
                    return false
                }
                setOutcome(terminal, for: card)
                clearCard(card)
                statusLine = terminal.statusText ?? statusLine
                statusKind = terminal == .authRequired ? .authFailed : .requestInvalid
            }
            return false
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

    /// The session still holding this card, if any. Cards are looked up across every session,
    /// so switching the page to another session while a send is in flight does not strand it.
    private func owner(of card: DecisionCard) -> String? {
        sessions.values.first { model in
            switch card {
            case .approval(let id): model.pendingApproval?.binding.approvalId == id
            case .question(let id): model.pendingQuestion?.questionId == id
            }
        }?.id
    }

    private func isCurrent(_ card: DecisionCard) -> Bool { owner(of: card) != nil }

    /// A newer card could have arrived (via the poll loop) while the send was in flight; only
    /// clear the one this call answered.
    private func clearCard(_ card: DecisionCard) {
        guard let owner = owner(of: card) else { return }
        update(owner) { model in
            switch card {
            case .approval: model.pendingApproval = nil
            case .question: model.pendingQuestion = nil
            }
        }
    }

    /// After a decision lands on the page's last waiting card, moves to the next waiting
    /// request in another session (inbox order), when the setting is on. Only acts if the page
    /// is still on the session the decision was for -- if the user switched away while the send
    /// was in flight, that choice must not be overridden.
    private func advanceToNextWaiting(after decidedSessionId: String) {
        guard selectedSessionId == decidedSessionId,
              advanceToNextRequest, (selected?.waitingCount ?? 0) == 0,
              let next = pendingInteractions.first(where: { $0.sessionId != selectedSessionId }) else { return }
        selectedSessionId = next.sessionId
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
        let retry = unconfirmedCancels[target]
        let commandId = retry?.commandId ?? UUID().uuidString
        let timestamp = retry?.timestamp ?? BridgeClient.timestamp()
        do {
            try await client.send(payload, sessionId: target, commandId: commandId, timestamp: timestamp)
            // Mirrors decide()'s isCurrent(card) guard: the session this cancel was sent for may
            // have completed (or been superseded) while the send was in flight, in which case its
            // resetSessionState() already cleared unconfirmedCancel/status correctly and this
            // stale reply must not resurrect or stomp any of it.
            guard generation == pollGeneration, target == sessionId else { return }
            unconfirmedCancels[target] = nil
        } catch {
            guard generation == pollGeneration, target == sessionId else { return }
            switch ActionOutcome.classify(error) {
            case .offline, .failed, .rateLimited, .unconfirmed:
                unconfirmedCancels[target] = UnconfirmedSend(
                    payload: payload, sessionId: target, commandId: commandId, timestamp: timestamp
                )
            default:
                unconfirmedCancels[target] = nil
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

    /// Where dictated text will go: the pending question it answers, or a new prompt.
    enum DictationDestination: Equatable {
        case newPrompt
        case answer(questionId: String, text: String)

        /// The label shown on the review screen. Mirrors what `dictationDestination` produced
        /// as a `String` before this type existed.
        var label: String {
            switch self {
            case .newPrompt: "New prompt"
            case .answer(_, let text): "Answer to: \(text)"
            }
        }
    }

    /// Where dictated text will go, shown on the review screen before it is sent: the pending
    /// question it answers, or a new prompt. Mirrors the routing in `submitDictation`.
    var dictationDestination: DictationDestination {
        if let question = pendingQuestion { return .answer(questionId: question.questionId, text: question.text) }
        return .newPrompt
    }

    /// Routes free text to the pending question when there is one, and to a new prompt otherwise.
    /// `expecting` is the destination the user reviewed and confirmed; it is compared against the
    /// live `dictationDestination` synchronously, before any await, so a destination that changed
    /// underneath the review screen (a new question, or the pending one being superseded) cannot
    /// silently redirect this send. Returns whether the text was sent anywhere.
    @discardableResult
    func submitDictation(_ text: String, expecting: DictationDestination) async -> Bool {
        guard expecting == dictationDestination else {
            statusLine = "Not sent: the question changed. Review again."
            statusKind = .error
            return false
        }
        switch expecting {
        case .answer:
            return await answer(text: text)
        case .newPrompt:
            // sendPrompt() applies the R-010 guard itself and reports whether the text was
            // actually sent, including when session creation fails first.
            return await sendPrompt(text)
        }
    }

    private func perform(_ payload: CommandPayload, sessionId: String) async throws {
        try await client.send(payload, sessionId: sessionId)
    }

    private func report(_ error: any Error) {
        // report() is status-only; the turn-state consequence of a failure belongs to the
        // caller that made the optimistic write (sendPrompt via rollBackLocalTurn) or to the
        // event stream.
        statusLine = "\(error)"
        statusKind = .error
    }

    /// Sole owner of the undo for sendPrompt()'s optimistic turn state. A turnStarted that landed
    /// during the send already cleared `awaitingLocalTurnStart` and is authoritative, so it wins.
    private func rollBackLocalTurn(_ id: String) {
        guard sessions[id]?.awaitingLocalTurnStart == true else { return }
        update(id) { model in
            model.awaitingLocalTurnStart = false
            model.localResolvedTurnId = nil
            model.currentTurnId = nil
            model.turnState = .error
        }
    }
}

import Foundation
import AgentRemoteProtocol

/// Everything the Watch knows about one bridge session. `SessionStore` keeps one per session the
/// device can see and exposes the selected one through its own properties, so each session keeps
/// its own transcript, turn state and pending request while the user looks at another.
struct SessionModel: Identifiable, Equatable {
    let id: String
    /// From `session.started`, or the event's project stamp when that event was never seen.
    var projectId: String?
    var transcript: [TranscriptItem] = []
    /// A provider holds at most one pending approval or question per session at a time
    /// (providers/claude `interactionLock`), so one slot of each is enough.
    var pendingApproval: ApprovalRequest?
    var pendingQuestion: QuestionRequestedPayload?
    /// Event id the pending request arrived with, so the inbox can order ties by arrival.
    var pendingSinceEventId = 0
    var turnState: TurnState = .idle
    /// See `SessionStore.currentTurnId`.
    var currentTurnId: Int?
    /// See `SessionStore.awaitingLocalTurnStart`.
    var awaitingLocalTurnStart = false
    var localResolvedTurnId: Int?
    /// Kept so an answered question can be shown by its label rather than its option id.
    var lastQuestion: QuestionRequestedPayload?
    /// Kept so a resolved approval can say what was decided, not only how.
    var lastApproval: ApprovalRequest?
    /// Set by `session.completed` or a fatal error. The transcript stays readable, but the
    /// session no longer accepts prompts, decisions or cancel.
    var ended = false
    /// The newest event applied to this session, for ordering the session list.
    var lastEventId = 0

    init(id: String, projectId: String? = nil) {
        self.id = id
        self.projectId = projectId
    }

    /// Whether a turn is in progress that a cancel would stop.
    var canCancelTurn: Bool {
        !ended && [.thinking, .running, .waiting].contains(turnState)
    }

    var waitingCount: Int {
        (pendingApproval == nil ? 0 : 1) + (pendingQuestion == nil ? 0 : 1)
    }

    mutating func append(_ role: TranscriptItem.Role, _ text: String, id eventId: Int) {
        transcript.append(TranscriptItem(id: "e\(eventId)", role: role, text: text))
    }
}

/// One approval or question waiting for an answer, in any session. The inbox lists these.
struct PendingInteraction: Identifiable, Equatable {
    enum Kind: Equatable { case approval, question }

    /// The approval id or question id.
    let id: String
    let sessionId: String
    let projectId: String?
    let kind: Kind
    let title: String
    let expiresAt: Date?
    let sinceEventId: Int

    /// Soonest expiry first; requests without an expiry after those with one; then arrival order.
    static func inboxOrder(_ lhs: PendingInteraction, _ rhs: PendingInteraction) -> Bool {
        switch (lhs.expiresAt, rhs.expiresAt) {
        case let (left?, right?) where left != right: return left < right
        case (.some, nil): return true
        case (nil, .some): return false
        default: return lhs.sinceEventId < rhs.sinceEventId
        }
    }

    /// Parses the bridge's ISO 8601 timestamps, with or without fractional seconds.
    static func parseDate(_ value: String?) -> Date? {
        guard let value else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }

    /// "4:59" until `expiresAt`, "Expired" once it has passed, nil without an expiry.
    static func countdown(to expiresAt: Date?, now: Date) -> String? {
        guard let expiresAt else { return nil }
        let seconds = Int(expiresAt.timeIntervalSince(now).rounded(.down))
        guard seconds > 0 else { return "Expired" }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

extension SessionModel {
    /// This session's waiting requests as inbox entries.
    var pendingInteractions: [PendingInteraction] {
        var entries: [PendingInteraction] = []
        if let approval = pendingApproval {
            entries.append(PendingInteraction(
                id: approval.binding.approvalId, sessionId: id, projectId: projectId, kind: .approval,
                title: approval.title, expiresAt: PendingInteraction.parseDate(approval.binding.expiresAt),
                sinceEventId: pendingSinceEventId
            ))
        }
        if let question = pendingQuestion {
            entries.append(PendingInteraction(
                id: question.questionId, sessionId: id, projectId: projectId, kind: .question,
                title: question.text, expiresAt: PendingInteraction.parseDate(question.expiresAt),
                sinceEventId: pendingSinceEventId
            ))
        }
        return entries
    }
}

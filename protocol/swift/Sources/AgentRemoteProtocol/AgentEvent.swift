import Foundation

/// Agent Remote protocol types, version 0.
///
/// These declarations are hand written to match the JSON Schemas in `protocol/schema`.
/// The schemas are the source of truth: if the two disagree, the schema wins and this file
/// is the thing that needs fixing.

// MARK: - Capabilities, projects and sessions

public struct AgentCapabilities: Codable, Hashable, Sendable {
    public var approvals: Bool
    public var questions: Bool
    public var resumeSession: Bool
    public var streaming: Bool
    public var usage: Bool

    public init(approvals: Bool, questions: Bool, resumeSession: Bool, streaming: Bool, usage: Bool) {
        self.approvals = approvals
        self.questions = questions
        self.resumeSession = resumeSession
        self.streaming = streaming
        self.usage = usage
    }
}

public struct Project: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var path: String

    public init(id: String, name: String, path: String) {
        self.id = id
        self.name = name
        self.path = path
    }
}

public enum SessionState: String, Codable, Sendable {
    case idle, running, waiting, completed, failed
}

public struct Session: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var projectId: String
    public var provider: String
    public var state: SessionState
    public var createdAt: String
    public var updatedAt: String
    public var title: String?

    public init(
        id: String, projectId: String, provider: String, state: SessionState,
        createdAt: String, updatedAt: String, title: String? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.provider = provider
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.title = title
    }
}

// MARK: - Approvals

/// Identifies exactly which pending approval a decision refers to. The bridge refuses a
/// decision whose binding no longer matches the pending request, or whose deadline passed.
public struct ApprovalBinding: Codable, Hashable, Sendable {
    public var approvalId: String
    public var sessionId: String
    public var turnId: String
    public var toolCallId: String
    public var actionDigest: String
    public var expiresAt: String

    public init(
        approvalId: String, sessionId: String, turnId: String, toolCallId: String,
        actionDigest: String, expiresAt: String
    ) {
        self.approvalId = approvalId
        self.sessionId = sessionId
        self.turnId = turnId
        self.toolCallId = toolCallId
        self.actionDigest = actionDigest
        self.expiresAt = expiresAt
    }
}

public enum ApprovalKind: String, Codable, Sendable {
    case command
    case fileWrite = "file.write"
    case network
    case other
}

public enum ApprovalDecision: String, Codable, Sendable {
    case accepted, rejected, expired
}

// MARK: - Event payloads

public struct SessionStartedPayload: Codable, Hashable, Sendable {
    public var projectId: String
    public var resumed: Bool
    public var model: String?
}

public struct SessionCompletedPayload: Codable, Hashable, Sendable {
    public enum Reason: String, Codable, Sendable { case completed, cancelled, error }
    public var reason: Reason
    public var message: String?
}

public struct TurnStartedPayload: Codable, Hashable, Sendable {
    public var turnId: String
    public var prompt: String?
}

public struct TurnCompletedPayload: Codable, Hashable, Sendable {
    public var turnId: String
    public var durationMs: Int?
    public var summary: String?
}

public struct AgentThinkingPayload: Codable, Hashable, Sendable {
    public var turnId: String
    public var text: String
}

/// The assistant's visible reply text, distinct from `AgentThinkingPayload`'s transient status text.
public struct AgentMessagePayload: Codable, Hashable, Sendable {
    public var messageId: String
    public var role: String
    public var text: String
    public var final: Bool
}

public struct FileReadPayload: Codable, Hashable, Sendable {
    public var path: String
    public var bytes: Int?
}

public struct FileModifiedPayload: Codable, Hashable, Sendable {
    public enum ChangeType: String, Codable, Sendable { case created, modified, deleted }
    public var path: String
    public var changeType: ChangeType
    public var linesAdded: Int?
    public var linesRemoved: Int?
}

public struct CommandStartedPayload: Codable, Hashable, Sendable {
    public var executionId: String
    public var command: String
    public var cwd: String?
}

public struct CommandOutputPayload: Codable, Hashable, Sendable {
    public enum Stream: String, Codable, Sendable { case stdout, stderr }
    public var executionId: String
    public var stream: Stream
    public var chunk: String
}

public struct CommandCompletedPayload: Codable, Hashable, Sendable {
    public var executionId: String
    public var exitCode: Int
    public var durationMs: Int?
}

public struct ApprovalRequest: Codable, Hashable, Sendable {
    public var binding: ApprovalBinding
    public var kind: ApprovalKind
    public var title: String
    public var detail: String?
    /// Short plain sentence the bridge composes for text-to-speech.
    public var spokenSummary: String?
}

public struct ApprovalResolvedPayload: Codable, Hashable, Sendable {
    public var approvalId: String
    public var decision: ApprovalDecision
    public var reason: String?
}

public struct QuestionOption: Codable, Hashable, Sendable {
    public var id: String
    public var label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

public struct QuestionRequestedPayload: Codable, Hashable, Sendable {
    public var questionId: String
    public var turnId: String
    public var text: String
    public var options: [QuestionOption]
    public var allowFreeText: Bool
    /// Short plain sentence the bridge composes for text-to-speech.
    public var spokenSummary: String?
}

public struct QuestionAnsweredPayload: Codable, Hashable, Sendable {
    public var questionId: String
    public var answer: String
}

public struct ErrorPayload: Codable, Hashable, Sendable {
    public var code: String
    public var message: String
    public var fatal: Bool
}

public struct UsageUpdatedPayload: Codable, Hashable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var costUsd: Double?
}

// MARK: - Event

public enum AgentEventType: String, Codable, Sendable, CaseIterable {
    case sessionStarted = "session.started"
    case sessionCompleted = "session.completed"
    case turnStarted = "turn.started"
    case turnCompleted = "turn.completed"
    case agentThinking = "agent.thinking"
    case agentMessage = "agent.message"
    case fileRead = "file.read"
    case fileModified = "file.modified"
    case commandStarted = "command.started"
    case commandOutput = "command.output"
    case commandCompleted = "command.completed"
    case approvalRequested = "approval.requested"
    case approvalResolved = "approval.resolved"
    case questionRequested = "question.requested"
    case questionAnswered = "question.answered"
    case error
    case usageUpdated = "usage.updated"
}

/// The payload of an event, paired with the discriminator that selects it.
public enum AgentEventPayload: Hashable, Sendable {
    case sessionStarted(SessionStartedPayload)
    case sessionCompleted(SessionCompletedPayload)
    case turnStarted(TurnStartedPayload)
    case turnCompleted(TurnCompletedPayload)
    case agentThinking(AgentThinkingPayload)
    case agentMessage(AgentMessagePayload)
    case fileRead(FileReadPayload)
    case fileModified(FileModifiedPayload)
    case commandStarted(CommandStartedPayload)
    case commandOutput(CommandOutputPayload)
    case commandCompleted(CommandCompletedPayload)
    case approvalRequested(ApprovalRequest)
    case approvalResolved(ApprovalResolvedPayload)
    case questionRequested(QuestionRequestedPayload)
    case questionAnswered(QuestionAnsweredPayload)
    case error(ErrorPayload)
    case usageUpdated(UsageUpdatedPayload)

    public var type: AgentEventType {
        switch self {
        case .sessionStarted: .sessionStarted
        case .sessionCompleted: .sessionCompleted
        case .turnStarted: .turnStarted
        case .turnCompleted: .turnCompleted
        case .agentThinking: .agentThinking
        case .agentMessage: .agentMessage
        case .fileRead: .fileRead
        case .fileModified: .fileModified
        case .commandStarted: .commandStarted
        case .commandOutput: .commandOutput
        case .commandCompleted: .commandCompleted
        case .approvalRequested: .approvalRequested
        case .approvalResolved: .approvalResolved
        case .questionRequested: .questionRequested
        case .questionAnswered: .questionAnswered
        case .error: .error
        case .usageUpdated: .usageUpdated
        }
    }
}

/// One event published by the Mac Agent Bridge.
public struct AgentEvent: Codable, Hashable, Sendable {
    public var eventId: Int
    public var sessionId: String
    /// Project the event belongs to, stamped by the bridge at emit time. Nil on events the
    /// bridge persisted before it carried the field.
    public var projectId: String?
    public var provider: String
    public var timestamp: String
    public var payload: AgentEventPayload

    public var type: AgentEventType { payload.type }

    public init(
        eventId: Int, sessionId: String, projectId: String? = nil, provider: String,
        timestamp: String, payload: AgentEventPayload
    ) {
        self.eventId = eventId
        self.sessionId = sessionId
        self.projectId = projectId
        self.provider = provider
        self.timestamp = timestamp
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case eventId, sessionId, projectId, provider, type, timestamp, payload
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try container.decode(Int.self, forKey: .eventId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        provider = try container.decode(String.self, forKey: .provider)
        timestamp = try container.decode(String.self, forKey: .timestamp)

        let type = try container.decode(AgentEventType.self, forKey: .type)
        switch type {
        case .sessionStarted:
            payload = .sessionStarted(try container.decode(SessionStartedPayload.self, forKey: .payload))
        case .sessionCompleted:
            payload = .sessionCompleted(try container.decode(SessionCompletedPayload.self, forKey: .payload))
        case .turnStarted:
            payload = .turnStarted(try container.decode(TurnStartedPayload.self, forKey: .payload))
        case .turnCompleted:
            payload = .turnCompleted(try container.decode(TurnCompletedPayload.self, forKey: .payload))
        case .agentThinking:
            payload = .agentThinking(try container.decode(AgentThinkingPayload.self, forKey: .payload))
        case .agentMessage:
            payload = .agentMessage(try container.decode(AgentMessagePayload.self, forKey: .payload))
        case .fileRead:
            payload = .fileRead(try container.decode(FileReadPayload.self, forKey: .payload))
        case .fileModified:
            payload = .fileModified(try container.decode(FileModifiedPayload.self, forKey: .payload))
        case .commandStarted:
            payload = .commandStarted(try container.decode(CommandStartedPayload.self, forKey: .payload))
        case .commandOutput:
            payload = .commandOutput(try container.decode(CommandOutputPayload.self, forKey: .payload))
        case .commandCompleted:
            payload = .commandCompleted(try container.decode(CommandCompletedPayload.self, forKey: .payload))
        case .approvalRequested:
            payload = .approvalRequested(try container.decode(ApprovalRequest.self, forKey: .payload))
        case .approvalResolved:
            payload = .approvalResolved(try container.decode(ApprovalResolvedPayload.self, forKey: .payload))
        case .questionRequested:
            payload = .questionRequested(try container.decode(QuestionRequestedPayload.self, forKey: .payload))
        case .questionAnswered:
            payload = .questionAnswered(try container.decode(QuestionAnsweredPayload.self, forKey: .payload))
        case .error:
            payload = .error(try container.decode(ErrorPayload.self, forKey: .payload))
        case .usageUpdated:
            payload = .usageUpdated(try container.decode(UsageUpdatedPayload.self, forKey: .payload))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(eventId, forKey: .eventId)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encodeIfPresent(projectId, forKey: .projectId)
        try container.encode(provider, forKey: .provider)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(type, forKey: .type)
        switch payload {
        case .sessionStarted(let value): try container.encode(value, forKey: .payload)
        case .sessionCompleted(let value): try container.encode(value, forKey: .payload)
        case .turnStarted(let value): try container.encode(value, forKey: .payload)
        case .turnCompleted(let value): try container.encode(value, forKey: .payload)
        case .agentThinking(let value): try container.encode(value, forKey: .payload)
        case .agentMessage(let value): try container.encode(value, forKey: .payload)
        case .fileRead(let value): try container.encode(value, forKey: .payload)
        case .fileModified(let value): try container.encode(value, forKey: .payload)
        case .commandStarted(let value): try container.encode(value, forKey: .payload)
        case .commandOutput(let value): try container.encode(value, forKey: .payload)
        case .commandCompleted(let value): try container.encode(value, forKey: .payload)
        case .approvalRequested(let value): try container.encode(value, forKey: .payload)
        case .approvalResolved(let value): try container.encode(value, forKey: .payload)
        case .questionRequested(let value): try container.encode(value, forKey: .payload)
        case .questionAnswered(let value): try container.encode(value, forKey: .payload)
        case .error(let value): try container.encode(value, forKey: .payload)
        case .usageUpdated(let value): try container.encode(value, forKey: .payload)
        }
    }
}

// MARK: - Command

public struct PromptSendPayload: Codable, Hashable, Sendable {
    public var text: String
    public init(text: String) { self.text = text }
}

public struct ApprovalAcceptPayload: Codable, Hashable, Sendable {
    public var binding: ApprovalBinding
    public init(binding: ApprovalBinding) { self.binding = binding }
}

public struct ApprovalRejectPayload: Codable, Hashable, Sendable {
    public var binding: ApprovalBinding
    public var reason: String?
    public init(binding: ApprovalBinding, reason: String? = nil) {
        self.binding = binding
        self.reason = reason
    }
}

public struct SessionCancelPayload: Codable, Hashable, Sendable {
    public var reason: String?
    public init(reason: String? = nil) { self.reason = reason }
}

/// Answers a question either by tapping one of the offered options or by sending dictated
/// free text. Exactly one of `optionId` or `text` should be set.
public struct QuestionAnswerPayload: Codable, Hashable, Sendable {
    public var questionId: String
    public var optionId: String?
    public var text: String?

    public init(questionId: String, optionId: String? = nil, text: String? = nil) {
        self.questionId = questionId
        self.optionId = optionId
        self.text = text
    }
}

/// Asks the bridge to start a new session. No session exists when this is sent, so the
/// envelope's `sessionId` is a client generated placeholder the bridge does not route on.
public struct SessionCreatePayload: Codable, Hashable, Sendable {
    public var projectId: String
    public var provider: String
    public init(projectId: String, provider: String) {
        self.projectId = projectId
        self.provider = provider
    }
}

public enum CommandType: String, Codable, Sendable, CaseIterable {
    case promptSend = "prompt.send"
    case approvalAccept = "approval.accept"
    case approvalReject = "approval.reject"
    case sessionCancel = "session.cancel"
    case questionAnswer = "question.answer"
    case sessionCreate = "session.create"
}

public enum CommandPayload: Hashable, Sendable {
    case promptSend(PromptSendPayload)
    case approvalAccept(ApprovalAcceptPayload)
    case approvalReject(ApprovalRejectPayload)
    case sessionCancel(SessionCancelPayload)
    case questionAnswer(QuestionAnswerPayload)
    case sessionCreate(SessionCreatePayload)

    public var type: CommandType {
        switch self {
        case .promptSend: .promptSend
        case .approvalAccept: .approvalAccept
        case .approvalReject: .approvalReject
        case .sessionCancel: .sessionCancel
        case .questionAnswer: .questionAnswer
        case .sessionCreate: .sessionCreate
        }
    }
}

/// One command sent by an Apple client to the Mac Agent Bridge.
public struct Command: Codable, Hashable, Sendable {
    /// Client generated UUID. The bridge uses it as an idempotency key.
    public var commandId: String
    public var sessionId: String
    public var timestamp: String
    public var payload: CommandPayload

    public var type: CommandType { payload.type }

    public init(commandId: String, sessionId: String, timestamp: String, payload: CommandPayload) {
        self.commandId = commandId
        self.sessionId = sessionId
        self.timestamp = timestamp
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case commandId, sessionId, type, timestamp, payload
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        commandId = try container.decode(String.self, forKey: .commandId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        timestamp = try container.decode(String.self, forKey: .timestamp)

        let type = try container.decode(CommandType.self, forKey: .type)
        switch type {
        case .promptSend:
            payload = .promptSend(try container.decode(PromptSendPayload.self, forKey: .payload))
        case .approvalAccept:
            payload = .approvalAccept(try container.decode(ApprovalAcceptPayload.self, forKey: .payload))
        case .approvalReject:
            payload = .approvalReject(try container.decode(ApprovalRejectPayload.self, forKey: .payload))
        case .sessionCancel:
            payload = .sessionCancel(try container.decode(SessionCancelPayload.self, forKey: .payload))
        case .questionAnswer:
            payload = .questionAnswer(try container.decode(QuestionAnswerPayload.self, forKey: .payload))
        case .sessionCreate:
            payload = .sessionCreate(try container.decode(SessionCreatePayload.self, forKey: .payload))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(commandId, forKey: .commandId)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(type, forKey: .type)
        switch payload {
        case .promptSend(let value): try container.encode(value, forKey: .payload)
        case .approvalAccept(let value): try container.encode(value, forKey: .payload)
        case .approvalReject(let value): try container.encode(value, forKey: .payload)
        case .sessionCancel(let value): try container.encode(value, forKey: .payload)
        case .questionAnswer(let value): try container.encode(value, forKey: .payload)
        case .sessionCreate(let value): try container.encode(value, forKey: .payload)
        }
    }
}

/**
 * Agent Remote protocol types, version 0.
 *
 * These declarations are hand written to match the JSON Schemas in `protocol/schema`.
 * The schemas are the source of truth: if the two disagree, the schema wins and this
 * file is the thing that needs fixing.
 */

import { createHash } from "node:crypto";

/** ISO 8601 timestamp in UTC, for example "2026-09-14T10:15:00.000Z". */
export type IsoTimestamp = string;

// ---------------------------------------------------------------------------
// Capabilities, projects and sessions
// ---------------------------------------------------------------------------

export interface AgentCapabilities {
  /** The agent can pause and ask for permission before a sensitive action. */
  approvals: boolean;
  /** The agent can ask the user a free-form question in the middle of a turn. */
  questions: boolean;
  /** A previous session can be resumed by identifier. */
  resumeSession: boolean;
  /** Partial output is delivered before a turn completes. */
  streaming: boolean;
  /** Token or cost usage is reported. */
  usage: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute path of the project root on the Mac. */
  path: string;
}

export type SessionState = "idle" | "running" | "waiting" | "completed" | "failed";

export interface Session {
  id: string;
  projectId: string;
  provider: string;
  state: SessionState;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  title?: string;
}

export interface CreateSessionOptions {
  title?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * Identifies exactly which pending approval a decision refers to. The bridge refuses a
 * decision whose binding no longer matches the pending request, or whose deadline passed.
 */
export interface ApprovalBinding {
  approvalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /** Digest of the exact action text that was shown to the user. */
  actionDigest: string;
  expiresAt: IsoTimestamp;
}

export type ApprovalKind = "command" | "file.write" | "network" | "other";

export interface ApprovalRequest {
  binding: ApprovalBinding;
  kind: ApprovalKind;
  /** One short line, sized for a watch screen. */
  title: string;
  detail?: string;
  /** Short plain sentence the bridge composes for text-to-speech. */
  spokenSummary?: string;
}

export type ApprovalDecision = "accepted" | "rejected" | "expired";

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface SessionStartedPayload {
  projectId: string;
  resumed: boolean;
  model?: string;
}

export interface SessionCompletedPayload {
  reason: "completed" | "cancelled" | "error";
  message?: string;
}

export interface TurnStartedPayload {
  turnId: string;
  prompt?: string;
}

export interface TurnCompletedPayload {
  turnId: string;
  durationMs?: number;
  summary?: string;
}

export interface AgentThinkingPayload {
  turnId: string;
  text: string;
}

/** The assistant's visible reply text, distinct from `agent.thinking`'s transient status text. */
export interface AgentMessagePayload {
  messageId: string;
  role: "assistant";
  text: string;
  /** False for a streamed partial chunk, true for the last chunk of the message. */
  final: boolean;
}

export interface FileReadPayload {
  path: string;
  bytes?: number;
}

export interface FileModifiedPayload {
  path: string;
  changeType: "created" | "modified" | "deleted";
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CommandStartedPayload {
  executionId: string;
  command: string;
  cwd?: string;
}

export interface CommandOutputPayload {
  executionId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface CommandCompletedPayload {
  executionId: string;
  exitCode: number;
  durationMs?: number;
}

export type ApprovalRequestedPayload = ApprovalRequest;

export interface ApprovalResolvedPayload {
  approvalId: string;
  decision: ApprovalDecision;
  reason?: string;
}

/** One tappable choice offered for a question. */
export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionRequestedPayload {
  questionId: string;
  turnId: string;
  /** The question text, sized for a watch screen. */
  text: string;
  /** 2-4 tappable choices. */
  options: QuestionOption[];
  /** Whether the client may answer with dictated free text instead of an option. */
  allowFreeText: boolean;
  /** Short plain sentence the bridge composes for text-to-speech. */
  spokenSummary?: string;
}

export interface QuestionAnsweredPayload {
  questionId: string;
  answer: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  fatal: boolean;
}

export interface UsageUpdatedPayload {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** Maps every event type to the payload shape that accompanies it. */
export interface AgentEventPayloadMap {
  "session.started": SessionStartedPayload;
  "session.completed": SessionCompletedPayload;
  "turn.started": TurnStartedPayload;
  "turn.completed": TurnCompletedPayload;
  "agent.thinking": AgentThinkingPayload;
  "agent.message": AgentMessagePayload;
  "file.read": FileReadPayload;
  "file.modified": FileModifiedPayload;
  "command.started": CommandStartedPayload;
  "command.output": CommandOutputPayload;
  "command.completed": CommandCompletedPayload;
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "question.requested": QuestionRequestedPayload;
  "question.answered": QuestionAnsweredPayload;
  error: ErrorPayload;
  "usage.updated": UsageUpdatedPayload;
}

export type AgentEventType = keyof AgentEventPayloadMap;

export interface AgentEventEnvelope<T extends AgentEventType> {
  /** Monotonically increasing integer assigned by the bridge, unique across sessions. */
  eventId: number;
  sessionId: string;
  provider: string;
  type: T;
  timestamp: IsoTimestamp;
  payload: AgentEventPayloadMap[T];
}

export type AgentEvent = {
  [T in AgentEventType]: AgentEventEnvelope<T>;
}[AgentEventType];

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

export interface PromptSendPayload {
  text: string;
}

export interface ApprovalAcceptPayload {
  binding: ApprovalBinding;
}

export interface ApprovalRejectPayload {
  binding: ApprovalBinding;
  reason?: string;
}

export interface SessionCancelPayload {
  reason?: string;
}

/**
 * Answers a question either by tapping one of the offered options or by sending dictated
 * free text. Exactly one of `optionId` or `text` is present.
 */
export type QuestionAnswerPayload =
  | { questionId: string; optionId: string; text?: never }
  | { questionId: string; text: string; optionId?: never };

/**
 * Asks the bridge to start a new session. No session exists when this is sent, so the
 * envelope's `sessionId` is a client generated placeholder the bridge does not route on. The
 * real identifier comes back on `CommandResponse.sessionId`.
 */
export interface SessionCreatePayload {
  projectId: string;
  provider: string;
}

/** Maps every command type to the payload shape that accompanies it. */
export interface CommandPayloadMap {
  "prompt.send": PromptSendPayload;
  "approval.accept": ApprovalAcceptPayload;
  "approval.reject": ApprovalRejectPayload;
  "session.cancel": SessionCancelPayload;
  "question.answer": QuestionAnswerPayload;
  "session.create": SessionCreatePayload;
}

export type CommandType = keyof CommandPayloadMap;

export interface CommandEnvelope<T extends CommandType> {
  /** Client generated UUID. The bridge uses it as an idempotency key. */
  commandId: string;
  sessionId: string;
  type: T;
  timestamp: IsoTimestamp;
  payload: CommandPayloadMap[T];
}

export type Command = {
  [T in CommandType]: CommandEnvelope<T>;
}[CommandType];

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * One coding agent, adapted to a single interface. The bridge owns sessions and talks only
 * through this interface, which is what keeps agent semantics independent from transport.
 */
export interface AgentProvider {
  readonly id: string;
  readonly capabilities: AgentCapabilities;

  listProjects(): Promise<Project[]>;
  listSessions(projectId?: string): Promise<Session[]>;
  createSession(projectId: string, options?: CreateSessionOptions): Promise<Session>;

  sendPrompt(sessionId: string, text: string): Promise<void>;
  approve(sessionId: string, binding: ApprovalBinding): Promise<void>;
  reject(sessionId: string, binding: ApprovalBinding, reason?: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  answerQuestion(sessionId: string, answer: QuestionAnswerPayload): Promise<void>;

  /** Replays events newer than `afterEvent`, then yields new ones as they happen. */
  subscribe(sessionId: string, afterEvent?: number): AsyncIterable<AgentEvent>;
}

// ---------------------------------------------------------------------------
// HTTP payload shapes
// ---------------------------------------------------------------------------

export interface EventsResponse {
  events: AgentEvent[];
  /** Highest event id held by the bridge at the time of the response. */
  lastEventId: number;
}

export interface CommandResponse {
  accepted: boolean;
  commandId: string;
  /** True when this command id had already been processed and was ignored. */
  duplicate: boolean;
  /** Set only when the command created a session, carrying the identifier the bridge assigned. */
  sessionId?: string;
}

export interface SessionsResponse {
  sessions: Session[];
}

export interface ProjectsResponse {
  projects: Project[];
}

/**
 * Everything a provider needs from the bridge. The bridge owns the event log and the event id
 * sequence, so a provider is handed an emitter rather than numbering its own events. Shared
 * here, rather than owned by one provider package, so both the bridge and every
 * `AgentProvider` implementation depend only on the protocol, never on each other.
 */
export interface ProviderHost {
  emit<T extends AgentEventType>(
    sessionId: string,
    type: T,
    payload: AgentEventPayloadMap[T],
  ): AgentEvent;
  eventsAfter(after: number): AgentEvent[];
  waitForChange(timeoutMs: number): Promise<void>;
}

/** Thrown when an approval or question decision's binding no longer matches the pending one. */
export class ApprovalBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalBindingMismatchError";
  }
}

/** Thrown when `sendPrompt` is called while an approval or question is still pending. */
export class InteractionPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionPendingError";
  }
}

/** Shared TTL for a pending approval before it expires. */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Hashes the exact action text shown to the user, so a binding can be checked against it. */
export function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

import { randomUUID } from "node:crypto";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import {
  APPROVAL_TTL_MS,
  ApprovalBindingMismatchError,
  digest,
  InteractionPendingError,
  SessionLimitError,
  TurnInProgressError,
  UnknownSessionError,
  type AgentCapabilities,
  type AgentProvider,
  type ApprovalBinding,
  type ApprovalDecision,
  type ApprovalKind,
  type CreateSessionOptions,
  type Project,
  type ProviderHost,
  type QuestionAnswerPayload,
  type QuestionOutcome,
  type TitleFidelity,
  type Session,
  type SessionCompletedPayload,
  type SessionState,
} from "@agentremote/protocol";

export {
  ApprovalBindingMismatchError,
  InteractionPendingError,
  SessionLimitError,
  TurnInProgressError,
  UnknownSessionError,
  type ProviderHost,
} from "@agentremote/protocol";

/**
 * The SDK's `query` function type, injected so tests can pass a scripted fake instead of
 * launching a real Claude Code process. Defaults to the real SDK export.
 */
export type QueryFn = typeof realQuery;

export interface ClaudeProviderOptions {
  projects: Project[];
  query?: QueryFn;
  permissionMode?: PermissionMode;
  /** Overrides the shared approval TTL. Exists for tests that need to exercise expiry
   * deterministically instead of waiting out `APPROVAL_TTL_MS`. */
  approvalTtlMs?: number;
  /** Overrides `TERMINATE_TIMEOUT_MS`. Exists for tests that need to exercise the
   * cancel/teardown timeout deterministically instead of waiting out the production default. */
  terminateTimeoutMs?: number;
  /** Overrides `DEFAULT_MAX_SESSIONS`, the ceiling on live sessions (each one owns a Claude Code
   * subprocess). Injectable the same way as the two timeouts above so tests can exercise the
   * limit without opening eight conversations. */
  maxSessions?: number;
}

interface PendingApproval {
  binding: ApprovalBinding;
  resolve: (result: PermissionResult) => void;
  /** Fires `APPROVAL_TTL_MS` after the approval was created and auto-resolves it as expired if
   * nobody has approved/rejected/cancelled it by then (C1-001). Cleared by every path that takes
   * this approval off `pendingApproval` for any other reason, so it never double-resolves. */
  expiryTimer: ReturnType<typeof setTimeout>;
}

/** A single question from `AskUserQuestion`, kept so an answer can be translated back into the
 * `updatedInput` shape the SDK expects. */
interface PendingQuestion {
  questionId: string;
  turnId: string;
  resolve: (result: PermissionResult) => void;
  question: AskUserQuestionInput["questions"][number];
  /** Mirrors `PendingApproval.expiryTimer`: fires `approvalTtlMs` after the question was asked
   * and auto-resolves it as expired if nobody answered by then. Cleared by every path that takes
   * this question off `pendingQuestion` for any other reason, so it never double-resolves. */
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface Conversation {
  projectId: string;
  cwd: string;
  queryHandle: Query;
  push: (message: SDKUserMessage) => void;
  turnId?: string;
  pendingApproval?: PendingApproval | undefined;
  pendingQuestion?: PendingQuestion | undefined;
  /** The most recently emitted assistant text block, held back until the next block or the
   * turn's `result` message tells us whether it was the last one. Flushed with `final: true`
   * only then, since "last" cannot be known at the moment a block is first seen. */
  pendingAssistantMessage?: { messageId: string; text: string } | undefined;
  /** True from `sendPrompt` until the matching `result` message arrives. Guards against a
   * second prompt silently overwriting `turnId` while the SDK is still streaming a reply and
   * no approval/question is pending yet. */
  turnInProgress: boolean;
  /** True once the conversation has crashed, been cancelled, or hit an unrecoverable error.
   * Checked by anything still in flight (a queued `canUseTool` call waiting on the interaction
   * lock) so it can bail out instead of opening a new interaction on a dead conversation. The
   * conversation is also removed from `this.conversations` at the same time, so any later call
   * that looks it up by session id sees it as unknown rather than merely "terminal". */
  terminal: boolean;
  /** Serializes `canUseTool`/`AskUserQuestion` requests so the SDK's parallel tool calls occupy
   * `pendingApproval`/`pendingQuestion` one at a time instead of overwriting each other. Each
   * interaction chains onto this promise and only resolves it once the interaction itself has
   * been resolved (approved, rejected, answered, cancelled, or terminated). */
  interactionLock: Promise<void>;
}

/** A minimal never-ending async iterable a provider can push messages into, so one `query()`
 * call backs a whole Agent Remote session instead of one call per prompt. */
function createPushableIterable<T>(): { iterable: AsyncIterable<T>; push: (item: T) => void } {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];

  const push = (item: T): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    queue.push(item);
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          const item = queue.shift();
          if (item !== undefined) {
            return Promise.resolve({ value: item, done: false });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return { iterable, push };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ACTION_TEXT_MAX_LENGTH = 200;

/** The truncated text shown on an approval card (and fed to `digest`), plus whether it was cut
 * short. `fullLength` lets a caller say how much was hidden, since the full, untruncated input is
 * what actually executes on approval. */
interface ActionText {
  text: string;
  truncated: boolean;
  fullLength: number;
}

function truncateActionText(text: string): ActionText {
  return text.length > ACTION_TEXT_MAX_LENGTH
    ? { text: `${text.slice(0, ACTION_TEXT_MAX_LENGTH - 1)}…`, truncated: true, fullLength: text.length }
    : { text, truncated: false, fullLength: text.length };
}

/** Bounds how long `cancel`/`terminateConversation` wait on the SDK's `interrupt()`/`return()`
 * before giving up on the underlying subprocess and proceeding with cleanup anyway. A wedged
 * subprocess must not be able to hang the `cancel` HTTP request (or teardown) forever. */
const TERMINATE_TIMEOUT_MS = 5000;

/** Ceiling on live sessions, each of which owns a Claude Code subprocess. Keeps a client (or a
 * retry loop) from spawning processes until the Mac is out of resources. */
const DEFAULT_MAX_SESSIONS = 8;

/** Marks a rejection that came from `withTimeout`'s deadline rather than from the awaited call
 * failing on its own, so teardown can report "the subprocess never answered" distinctly from
 * "the subprocess answered with an error". */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Races `promise` against a `timeoutMs` deadline. Resolves/rejects with whichever settles
 * first; on timeout, rejects with a `TimeoutError` so callers can tell a timeout apart from the
 * promise's own rejection. The timer is always cleared so it never keeps the process alive. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      // `unknown`: a rejected promise can reject with any thrown value, not just an `Error`; this
      // just forwards it to `reject` untouched.
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Derives the text shown to the user for an approval card from the same `toolName`+`input`
 * that `actionDigest` is computed over, so the binding the user approves always matches what
 * they were shown. Bash surfaces the command itself; Edit/Write surface the file path; anything
 * else falls back to the tool name plus its input, never a generic placeholder. */
/** Maps an SDK tool name to the protocol's `ApprovalKind` discriminant (C1-003), so the watch
 * client can render tool-specific icons/copy instead of every approval showing as "other". */
function deriveApprovalKind(toolName: string): ApprovalKind {
  if (toolName === "Bash") {
    return "command";
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    return "file.write";
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    return "network";
  }
  return "other";
}

function deriveActionText(toolName: string, input: Record<string, unknown>): ActionText {
  if (toolName === "Bash" && typeof input.command === "string") {
    return truncateActionText(input.command);
  }
  if ((toolName === "Edit" || toolName === "Write") && typeof input.file_path === "string") {
    return truncateActionText(input.file_path);
  }
  return truncateActionText(`${toolName} ${JSON.stringify(input)}`);
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

/**
 * Adapts the Claude Agent SDK to `AgentProvider`. One SDK conversation (a single streaming-input
 * `query()` call) backs one Agent Remote session for its whole life, so `sendPrompt` calls
 * append to the same long-lived conversation rather than starting a fresh process per turn.
 *
 * Unsupported, per docs/protocol-v0.md's mapping table: `canUseTool` allow with `updatedInput`
 * on an *approval* (the modified action cannot satisfy a binding to the original action), and
 * turn-cancellation as a substitute for rejecting one tool call. `updatedInput` is used for
 * `AskUserQuestion` answers only, which is a distinct SDK mechanism from tool approvals.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = "claude";

  readonly capabilities: AgentCapabilities = {
    approvals: true,
    questions: true,
    resumeSession: false,
    streaming: true,
    usage: true,
  };

  private readonly host: ProviderHost;
  private readonly projects: Project[];
  private readonly queryFn: QueryFn;
  private readonly permissionMode: PermissionMode | undefined;
  private readonly approvalTtlMs: number;
  private readonly terminateTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, Session>();
  private readonly conversations = new Map<string, Conversation>();
  /** Session ids whose events stopped being persistable (see `safeEmit`). Read by the message
   * pump, which stops iterating for these sessions instead of streaming events nobody records. */
  private readonly abandoned = new Set<string>();
  private counter = 0;

  constructor(host: ProviderHost, options: ClaudeProviderOptions) {
    this.host = host;
    this.projects = options.projects;
    this.queryFn = options.query ?? realQuery;
    this.permissionMode = options.permissionMode;
    this.approvalTtlMs = options.approvalTtlMs ?? APPROVAL_TTL_MS;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? TERMINATE_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** Throws `SessionLimitError` if registering another session would exceed `maxSessions`.
   * Shared by `createSession` and `seedSession` (R2-001) so every path that adds to
   * `this.sessions` is covered by the same subprocess ceiling. */
  private checkSessionLimit(): void {
    if (this.sessions.size >= this.maxSessions) {
      throw new SessionLimitError(
        `session limit reached: ${this.sessions.size} of ${this.maxSessions} sessions are live; cancel one first`,
      );
    }
  }

  /** Registers a session the bridge already knows about and starts its conversation, without
   * emitting `session.started`. Mirrors `MockProvider.seedSession`. */
  seedSession(session: Session): void {
    const project = this.projects.find((candidate) => candidate.id === session.projectId);
    if (project === undefined) {
      throw new Error(`unknown projectId: ${session.projectId}`);
    }
    // Same ceiling as `createSession` enforces, so any future caller of `seedSession` (e.g. a
    // resume-on-restart path) cannot bypass the subprocess limit (R2-001).
    this.checkSessionLimit();
    // `startConversation` runs synchronously up to the `queryFn(...)` call; if that throws, this
    // registers nothing in either map, so the session is only added to `this.sessions` once the
    // conversation has actually been created (see R1-001).
    this.startConversation(session.id, project);
    this.sessions.set(session.id, session);
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects];
  }

  async listSessions(projectId?: string): Promise<Session[]> {
    const all = [...this.sessions.values()];
    return projectId === undefined ? all : all.filter((session) => session.projectId === projectId);
  }

  async createSession(projectId: string, options?: CreateSessionOptions): Promise<Session> {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      throw new Error(`unknown projectId: ${projectId}`);
    }
    // Every live session owns a Claude Code subprocess, so an unbounded create path lets a
    // client spawn processes until the Mac runs out of resources. Refused here rather than in the
    // bridge so any transport hitting the provider is covered by the same ceiling.
    this.checkSessionLimit();
    const now = new Date().toISOString();
    const session: Session = {
      id: `ses_${randomUUID()}`,
      projectId,
      provider: this.id,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      ...(options?.title === undefined ? {} : { title: options.title }),
    };
    // Same ordering as `seedSession` above: only register the session once `startConversation`
    // has succeeded, so a synchronous `queryFn` throw (e.g. SDK validation error) leaves no
    // phantom entry in `this.sessions` counting against `maxSessions` (R1-001).
    this.startConversation(session.id, project);
    this.sessions.set(session.id, session);
    this.host.emit(session.id, "session.started", { projectId, resumed: false });
    return session;
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const conversation = this.requireConversation(sessionId);
    if (conversation.pendingApproval !== undefined) {
      throw new InteractionPendingError(
        `session ${sessionId} has a pending approval ${conversation.pendingApproval.binding.approvalId}; resolve or cancel it first`,
      );
    }
    if (conversation.pendingQuestion !== undefined) {
      throw new InteractionPendingError(
        `session ${sessionId} has a pending question ${conversation.pendingQuestion.questionId}; resolve or cancel it first`,
      );
    }
    if (conversation.turnInProgress) {
      throw new TurnInProgressError(`session ${sessionId} has a turn in progress; wait for it to complete first`);
    }

    const turnId = `trn_${++this.counter}`;
    conversation.turnId = turnId;
    conversation.turnInProgress = true;
    this.setSessionState(sessionId, "running");
    this.host.emit(sessionId, "turn.started", { turnId, prompt: text });
    conversation.push(userMessage(text));
  }

  async approve(sessionId: string, binding: ApprovalBinding): Promise<void> {
    const conversation = this.requireConversation(sessionId);
    const pending = this.takeApproval(sessionId, conversation, binding);
    this.host.emit(sessionId, "approval.resolved", { approvalId: binding.approvalId, decision: "accepted" });
    this.restoreRunningState(sessionId, conversation);
    // Never returns `updatedInput` here: the protocol marks a modified action as unsupported
    // for approvals, since the modified action can no longer satisfy the binding shown to the user.
    pending.resolve({ behavior: "allow" });
  }

  async reject(sessionId: string, binding: ApprovalBinding, reason?: string): Promise<void> {
    const conversation = this.requireConversation(sessionId);
    const pending = this.takeApproval(sessionId, conversation, binding);
    this.host.emit(sessionId, "approval.resolved", {
      approvalId: binding.approvalId,
      decision: "rejected",
      ...(reason === undefined ? {} : { reason }),
    });
    this.restoreRunningState(sessionId, conversation);
    pending.resolve({ behavior: "deny", message: reason ?? "Rejected by user" });
  }

  async cancel(sessionId: string): Promise<void> {
    // Mirrors approve/reject: an unknown session id throws rather than emitting a phantom
    // session.completed for a session that never existed.
    const conversation = this.requireConversation(sessionId);
    // A failed or timed-out interrupt means the subprocess may still be running whatever the user
    // asked to stop, so the terminal event must not read as a clean cancel: the failure is carried
    // into `session.completed.message` as well as the non-fatal error event below.
    let cancelMessage: string | undefined;
    try {
      await withTimeout(conversation.queryHandle.interrupt(), this.terminateTimeoutMs, "interrupt");
    } catch (error) {
      cancelMessage = error instanceof TimeoutError ? "interrupt_timeout" : "interrupt_failed";
      this.host.emit(sessionId, "error", {
        code: "provider_error",
        message: `interrupt failed: ${errorMessage(error)}`,
        fatal: false,
      });
    }
    await this.terminateConversation(sessionId, conversation, "cancelled", cancelMessage);
  }

  async answerQuestion(sessionId: string, answer: QuestionAnswerPayload): Promise<void> {
    const conversation = this.requireConversation(sessionId);
    const pending = conversation.pendingQuestion;
    if (pending === undefined || pending.questionId !== answer.questionId) {
      throw new ApprovalBindingMismatchError(`no pending question ${answer.questionId}`);
    }
    let optionLabel: string | undefined;
    if (answer.optionId !== undefined) {
      const match = /^opt_(\d+)$/.exec(answer.optionId);
      const optionIndex = match === undefined || match === null ? undefined : Number.parseInt(match[1] as string, 10);
      optionLabel = optionIndex === undefined ? undefined : pending.question.options[optionIndex]?.label;
      if (optionLabel === undefined) {
        // Invalid optionId: leave pendingQuestion intact so the caller can retry with a valid
        // one instead of silently losing the interaction to a typo or stale option list.
        throw new ApprovalBindingMismatchError(
          `option ${answer.optionId} is not a valid option for question ${answer.questionId}`,
        );
      }
    }
    clearTimeout(pending.expiryTimer);
    conversation.pendingQuestion = undefined;

    const answerText = optionLabel ?? answer.text ?? "";

    this.host.emit(sessionId, "question.answered", {
      questionId: answer.questionId,
      answer: answerText,
      outcome: "answered",
    });
    this.restoreRunningState(sessionId, conversation);

    pending.resolve({
      behavior: "allow",
      updatedInput: {
        questions: [pending.question],
        answers: { [pending.question.question]: answerText },
        ...(answer.text === undefined ? {} : { response: answer.text }),
      },
    });
  }

  async *subscribe(sessionId: string, afterEvent = 0): AsyncIterable<import("@agentremote/protocol").AgentEvent> {
    let cursor = afterEvent;
    for (;;) {
      const batch = this.host.eventsAfter(cursor).filter((event) => event.sessionId === sessionId);
      for (const event of batch) {
        cursor = Math.max(cursor, event.eventId);
        yield event;
      }
      await this.host.waitForChange(1000);
    }
  }

  /** Puts the session back into `running` once the interaction that made it `waiting` has been
   * resolved and the turn it belongs to is still going. `waiting` means "a decision is pending":
   * leaving it set after approve/reject/answerQuestion would report a session as blocked on the
   * user while the agent is in fact working. A conversation with no turn in progress keeps
   * whatever state it already has (idle/completed/failed). */
  private restoreRunningState(sessionId: string, conversation: Conversation): void {
    if (conversation.terminal || !conversation.turnInProgress) {
      return;
    }
    this.setSessionState(sessionId, "running");
  }

  /** Updates the session's reported `state` in place, or does nothing if the session was already
   * removed (e.g. this races a concurrent termination). */
  private setSessionState(sessionId: string, state: SessionState): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.state = state;
    session.updatedAt = new Date().toISOString();
  }

  /** Awaits one `canUseTool`/`AskUserQuestion` decision, racing it against `signal` (the SDK's
   * per-call `AbortSignal`, from `callOptions`). `register` occupies the pending slot and emits
   * the request event; `clearPending` releases that slot. On abort — before or after `register`
   * runs — the pending slot is cleared and this resolves with a deny, so the interaction lock is
   * released instead of waiting forever on a decision the SDK has already given up on. */
  private awaitInteraction(
    signal: AbortSignal,
    clearPending: () => void,
    register: (settle: (result: PermissionResult) => void) => void,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const settle = (result: PermissionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        clearPending();
        settle({ behavior: "deny", message: "aborted", interrupt: true });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
      register(settle);
    });
  }

  /** Looks up the conversation for `sessionId`, failing closed on a conversation that is
   * mid-teardown. `terminateConversation` flips `terminal` synchronously before its first
   * `await`, so a `sendPrompt`/`approve`/`reject`/`answerQuestion` racing that teardown sees the
   * same `UnknownSessionError` it would get once the conversation is actually removed from the
   * map, instead of passing this guard and opening an interaction that will never resolve. */
  private requireConversation(sessionId: string): Conversation {
    const conversation = this.conversations.get(sessionId);
    if (conversation === undefined || conversation.terminal) {
      throw new UnknownSessionError(`no conversation for session ${sessionId}`);
    }
    return conversation;
  }

  private startConversation(sessionId: string, project: Project): void {
    const { iterable, push } = createPushableIterable<SDKUserMessage>();
    const options: Options = {
      cwd: project.path,
      // SDK isolation mode. With `settingSources` omitted the SDK loads ~/.claude/settings.json
      // and the project's own settings, whose permission allow-lists and hooks resolve a tool
      // call before `canUseTool` ever runs: a user who has allowed Bash locally would see the
      // agent run commands with no approval reaching the watch. Every tool must route through
      // `canUseTool`, so no filesystem settings are loaded. Cost: CLAUDE.md files are not read
      // either, which needs `'project'` here once project settings are trusted.
      settingSources: [],
      // `sandbox.autoAllowBashIfSandboxed` defaults to true: a Bash command the SDK can run
      // sandboxed is auto-allowed and never reaches `canUseTool`, so the watch would never see
      // an approval for it. Measured 2026-09-19 in the loopback harness: `sleep 60` ran with no
      // approval.requested emitted. Every tool must go to the watch, so the auto-allow is off.
      sandbox: { autoAllowBashIfSandboxed: false },
      // The CLI also auto-approves a command its own safety classifier judges harmless, again
      // without calling `canUseTool`. A policy-tier ask rule for Bash forces every shell command
      // back through the permission path, so it reaches the watch as an approval.
      managedSettings: { permissions: { ask: ["Bash"] } },
      canUseTool: ((toolName, input, callOptions) =>
        this.handleCanUseTool(sessionId, toolName, input, callOptions)) satisfies CanUseTool,
      ...(this.permissionMode === undefined ? {} : { permissionMode: this.permissionMode }),
    };
    const queryHandle = this.queryFn({ prompt: iterable, options });
    const conversation: Conversation = {
      projectId: project.id,
      cwd: project.path,
      queryHandle,
      push,
      turnInProgress: false,
      terminal: false,
      interactionLock: Promise.resolve(),
    };
    this.conversations.set(sessionId, conversation);
    // Fire-and-forget by design (the pump runs for the life of the conversation), so its promise
    // must never be able to reject: every emit inside it goes through `safeEmit`, and this catch
    // is the backstop that keeps any other unexpected throw from becoming an unhandled rejection
    // that crashes the bridge process.
    void this.pumpMessages(sessionId, queryHandle).catch((error: unknown) => {
      console.error(`[claude] message pump for session ${sessionId} failed unexpectedly:`, error);
      this.abandonConversation(sessionId, "pumpMessages");
      // The pump's own `finally` has already run by the time this handler does, so clear the
      // marker here too rather than leaving the entry behind with no reader.
      this.abandoned.delete(sessionId);
    });
  }

  /**
   * Ends a conversation for good: resolves any pending approval/question with a deny so the SDK
   * does not hang, disposes the query handle, and removes the conversation so later
   * `sendPrompt`/`approve`/`reject`/`cancel`/`answerQuestion` calls see an unknown session
   * instead of silently succeeding or hanging. Also removes the session from `this.sessions` (the
   * map backing `listSessions()`), since the bridge's `sessionExists` gate only checks id
   * presence there, not `state` — leaving the entry behind would let a terminated session keep
   * passing that gate forever. Idempotent, so it is safe to call from `cancel`, from the
   * `pumpMessages` crash path, and from a `handleMessage` failure without risking a double
   * `session.completed`.
   */
  private async terminateConversation(
    sessionId: string,
    conversation: Conversation,
    reason: SessionCompletedPayload["reason"],
    message?: string,
  ): Promise<void> {
    if (conversation.terminal) {
      return;
    }
    // Set before resolving the pendings below: a loop awaiting one of those resolves (the
    // multi-question AskUserQuestion loop) re-checks this flag as soon as it wakes up, so it
    // must already be true by then rather than racing the resolve.
    conversation.terminal = true;
    conversation.turnInProgress = false;
    this.setSessionState(sessionId, reason === "error" ? "failed" : "completed");
    this.flushPendingAssistantMessage(sessionId, conversation);
    if (conversation.pendingApproval !== undefined) {
      const pending = conversation.pendingApproval;
      clearTimeout(pending.expiryTimer);
      conversation.pendingApproval = undefined;
      this.resolvePendingApprovalEvent(sessionId, pending.binding.approvalId, "cancelled", "session terminated");
      pending.resolve({ behavior: "deny", message: "session terminated", interrupt: true });
    }
    if (conversation.pendingQuestion !== undefined) {
      const pending = conversation.pendingQuestion;
      clearTimeout(pending.expiryTimer);
      conversation.pendingQuestion = undefined;
      this.resolvePendingQuestionEvent(sessionId, pending.questionId, "cancelled");
      pending.resolve({ behavior: "deny", message: "session terminated", interrupt: true });
    }
    let terminalMessage = message;
    try {
      // `Query` extends `AsyncGenerator`; `.return()` is its close/dispose method (there is no
      // separate `close()` on the interface) and stops the underlying subprocess. Bounded by
      // `TERMINATE_TIMEOUT_MS` so a wedged subprocess cannot hang teardown (and the `cancel` HTTP
      // request that may be awaiting this) forever; cleanup below still runs on timeout.
      await withTimeout(conversation.queryHandle.return(undefined), this.terminateTimeoutMs, "queryHandle.return");
    } catch (error) {
      // Best effort: the generator/process may already be gone, or the timeout above fired.
      // Non-fatal: mirrors the `interrupt` catch path in `cancel` above. A timeout here means the
      // subprocess never acknowledged disposal, which the terminal event must say rather than
      // reporting an orderly shutdown.
      if (error instanceof TimeoutError) {
        terminalMessage = "interrupt_timeout";
      }
      this.safeEmit(sessionId, "error", () => {
        this.host.emit(sessionId, "error", {
          code: "provider_error",
          message: `queryHandle.return failed: ${errorMessage(error)}`,
          fatal: false,
        });
      });
    }
    this.conversations.delete(sessionId);
    this.sessions.delete(sessionId);
    this.safeEmit(sessionId, "session.completed", () => {
      this.host.emit(sessionId, "session.completed", {
        reason,
        ...(terminalMessage === undefined ? {} : { message: terminalMessage }),
      });
    });
  }

  /** Tells the client that a pending approval it is still showing a card for was resolved for it,
   * without a user decision: `cancelled` on session teardown, `superseded` when the SDK aborts or
   * withdraws the tool call, `expired` when the TTL timer fires (that path emits directly rather
   * than through here; see the timer in `runInteraction`). `reason` carries the free-text cause
   * the schema's `ApprovalResolvedPayload.reason` allows. */
  private resolvePendingApprovalEvent(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): void {
    this.safeEmit(sessionId, "approval.resolved", () => {
      this.host.emit(sessionId, "approval.resolved", { approvalId, decision, ...(reason === undefined ? {} : { reason }) });
    });
  }

  /** The question-side counterpart. `question.answered` is the only outcome event for a
   * question, so a forced resolve (no user answer) is reported through it with an empty
   * `answer` and `outcome` set to the real cause, which is what lets the watch clear the card. */
  private resolvePendingQuestionEvent(sessionId: string, questionId: string, outcome: QuestionOutcome): void {
    this.safeEmit(sessionId, "question.answered", () => {
      this.host.emit(sessionId, "question.answered", { questionId, answer: "", outcome });
    });
  }

  /** Chains `fn` onto the conversation's interaction lock so a second concurrent
   * `canUseTool`/`AskUserQuestion` request waits for the current one to be fully resolved
   * before it can occupy `pendingApproval`/`pendingQuestion`. Preserves the protocol's
   * one-pending-interaction-per-session contract instead of building a queue of visible
   * pendings. */
  private withInteractionLock<T>(conversation: Conversation, fn: () => Promise<T>): Promise<T> {
    const previous = conversation.interactionLock;
    const run = previous.then(fn, fn);
    conversation.interactionLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Emits through the host without ever letting the failure escape into a fire-and-forget
   * context. `ProviderHost.emit` now throws when the event cannot be durably persisted, and
   * several emit sites here run detached from any caller (the `pumpMessages` loop, an
   * `AbortSignal` listener, the approval expiry timer), where a throw would become an unhandled
   * rejection or an uncaught exception and take the bridge process down.
   *
   * The failure is never swallowed: it is logged with the session id and event type, and the
   * conversation is torn down (`abandonConversation`) instead of pumping on. Continuing would
   * leave the client's event stream with a gap it cannot detect — the exact failure mode the
   * watermark/cursor work exists to prevent — so a session whose events stopped being durable
   * ends as `failed` rather than as a session that looks healthy but is silently lying.
   *
   * Returns false when the event was not emitted, so a caller holding an SDK promise (a pending
   * approval/question) can settle it instead of waiting for a decision no client will ever make.
   */
  private safeEmit(sessionId: string, type: string, emit: () => void): boolean {
    try {
      emit();
      return true;
    } catch (error) {
      console.error(
        `[claude] failed to emit ${type} for session ${sessionId}; terminating the session rather than continuing with an undetectable gap in its event stream:`,
        error,
      );
      this.abandonConversation(sessionId, type);
      return false;
    }
  }

  /** Terminal teardown for a conversation whose events can no longer be persisted. Mirrors
   * `terminateConversation` minus every emit: the host has just proved it cannot take events, so
   * emitting `session.completed`/`approval.resolved` here would only throw again. The session is
   * left in a defined state (`failed`, removed from both maps, pendings denied, subprocess
   * disposed) rather than continuing to run against a client that is no longer being told
   * anything. Idempotent, and a no-op for a conversation already tearing down. */
  private abandonConversation(sessionId: string, type: string): void {
    const conversation = this.conversations.get(sessionId);
    if (conversation === undefined || conversation.terminal) {
      return;
    }
    // Marked only once the call has decided to tear this conversation down. Marking before the
    // guard above left an entry behind on every no-op call (a second emit failure, an abandon
    // from a conversation already terminating), and only `pumpMessages` ever clears it.
    this.abandoned.add(sessionId);
    conversation.terminal = true;
    conversation.turnInProgress = false;
    conversation.pendingAssistantMessage = undefined;
    this.setSessionState(sessionId, "failed");
    const denied: PermissionResult = {
      behavior: "deny",
      message: `event ${type} could not be persisted`,
      interrupt: true,
    };
    if (conversation.pendingApproval !== undefined) {
      const pending = conversation.pendingApproval;
      clearTimeout(pending.expiryTimer);
      conversation.pendingApproval = undefined;
      pending.resolve(denied);
    }
    if (conversation.pendingQuestion !== undefined) {
      const pending = conversation.pendingQuestion;
      conversation.pendingQuestion = undefined;
      pending.resolve(denied);
    }
    this.conversations.delete(sessionId);
    this.sessions.delete(sessionId);
    // Detached on purpose: this runs from contexts with nobody to await it. Disposal failures are
    // already non-fatal everywhere else in this file. The `try` covers a *synchronous* throw from
    // `.return()`, which `.catch` would not: this function runs from the expiry timer and the
    // abort listener, where an escaping throw is an uncaught exception, not a rejection.
    try {
      void Promise.resolve(conversation.queryHandle.return(undefined)).catch((error: unknown) => {
        console.error(`[claude] queryHandle.return failed while abandoning session ${sessionId}:`, error);
      });
    } catch (error) {
      console.error(`[claude] queryHandle.return threw while abandoning session ${sessionId}:`, error);
    }
  }

  private async pumpMessages(sessionId: string, queryHandle: Query): Promise<void> {
    try {
      for await (const message of queryHandle) {
        try {
          this.handleMessage(sessionId, message);
        } catch (error) {
          // Distinct from the SDK/transport failure below: this is a bug in our own mapping of
          // an otherwise healthy message, not the agent process failing.
          this.safeEmit(sessionId, "error", () => {
            this.host.emit(sessionId, "error", {
              code: "message_handling_error",
              message: errorMessage(error),
              fatal: true,
            });
          });
          const conversation = this.conversations.get(sessionId);
          if (conversation !== undefined) {
            await this.terminateConversation(sessionId, conversation, "error");
          }
          return;
        }
        // A `safeEmit` failure inside `handleMessage` abandoned this session: its event stream
        // already has a hole, so the pump stops here rather than emitting further events that
        // would make the client's view look continuous when it is not. (A plain teardown by
        // `cancel()` is deliberately not treated this way: that path owns its own disposal.)
        if (this.abandoned.has(sessionId)) {
          this.abandoned.delete(sessionId);
          return;
        }
      }
      // The SDK's async generator ended. Either way the subprocess behind it is gone, so the
      // conversation must be torn down: leaving it registered would let a later `sendPrompt` push
      // into an iterable nothing is reading any more and hang instead of failing fast.
      const conversation = this.conversations.get(sessionId);
      if (conversation !== undefined && !conversation.terminal) {
        if (conversation.turnInProgress) {
          // Ended mid-turn without ever yielding a `result`: an abnormal teardown, reported as a
          // fatal error and a failed session.
          this.safeEmit(sessionId, "error", () => {
            this.host.emit(sessionId, "error", {
              code: "provider_error",
              message: "conversation ended without a result",
              fatal: true,
            });
          });
          await this.terminateConversation(sessionId, conversation, "error");
        } else {
          // Ended while idle (e.g. right after a normal `result`): nothing failed, but the session
          // cannot serve another prompt, so it completes with the cause named rather than being
          // left behind as a session whose next prompt would hang.
          await this.terminateConversation(sessionId, conversation, "completed", "provider stream ended");
        }
      }
    } catch (error) {
      const conversation = this.conversations.get(sessionId);
      // Checked before emitting: a concurrent `cancel()`/teardown disposes the generator, which
      // surfaces here as a throw. That conversation has already emitted its own terminal event, so
      // a fatal error event now would report a crash the session never had.
      if (conversation === undefined || conversation.terminal) {
        return;
      }
      this.safeEmit(sessionId, "error", () => {
        this.host.emit(sessionId, "error", {
          code: "provider_error",
          message: errorMessage(error),
          fatal: true,
        });
      });
      await this.terminateConversation(sessionId, conversation, "error");
    } finally {
      // The pump is the only reader of this marker, so once it is gone the entry has no purpose.
      // Without this, an abandon that happens after the loop has exited (the pump's own catch
      // backstop, the expiry timer, the abort listener) leaves one entry per failed session for
      // the life of the process.
      this.abandoned.delete(sessionId);
    }
  }

  /** Emits the conversation's held-back assistant text block, if any, with `final: true`. Called
   * once we know no further assistant text will follow it in the same turn: on the terminating
   * `result` message, or on conversation teardown when a `result` never arrives at all. */
  private flushPendingAssistantMessage(sessionId: string, conversation: Conversation | undefined): void {
    const pending = conversation?.pendingAssistantMessage;
    if (pending === undefined || conversation === undefined) {
      return;
    }
    conversation.pendingAssistantMessage = undefined;
    this.safeEmit(sessionId, "agent.message", () => {
      this.host.emit(sessionId, "agent.message", {
        messageId: pending.messageId,
        role: "assistant",
        text: pending.text,
        final: true,
      });
    });
  }

  private handleMessage(sessionId: string, message: SDKMessage): void {
    const conversation = this.conversations.get(sessionId);

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          // Whether this block is the last assistant text of the turn is unknowable here: more
          // assistant messages may still follow before the terminating `result`. Flush whatever
          // was held back as non-final (it is now known not to be last) and hold this one back in
          // its place, so only the block actually followed by `result` is ever marked final.
          if (conversation !== undefined) {
            const previous = conversation.pendingAssistantMessage;
            if (previous !== undefined) {
              this.safeEmit(sessionId, "agent.message", () => {
                this.host.emit(sessionId, "agent.message", {
                  messageId: previous.messageId,
                  role: "assistant",
                  text: previous.text,
                  final: false,
                });
              });
            }
            conversation.pendingAssistantMessage = { messageId: message.uuid, text: block.text };
          } else {
            // No conversation to hold this back against (already torn down): emit immediately,
            // since there is nowhere to buffer it and nothing left that could still follow it.
            this.safeEmit(sessionId, "agent.message", () => {
              this.host.emit(sessionId, "agent.message", {
                messageId: message.uuid,
                role: "assistant",
                text: block.text,
                final: true,
              });
            });
          }
        }
      }
      return;
    }

    if (message.type === "result") {
      if (conversation === undefined || conversation.terminal) {
        // The conversation was already torn down (terminal, or removed outright) by a concurrent
        // `cancel()`/teardown before this trailing SDK message reached the pump loop. There is no
        // live turn left to complete, and no `turnId` was ever announced for one, so drop the
        // message instead of emitting `turn.completed`/`usage.updated` with a fabricated turnId
        // for an already-completed session.
        return;
      }
      const turnId = conversation.turnId ?? `trn_${++this.counter}`;
      this.flushPendingAssistantMessage(sessionId, conversation);
      if (conversation.terminal) {
        // The flush above could not be persisted and abandoned the conversation. Reporting
        // `turn.completed` now would tell the client the turn finished cleanly while the
        // assistant text it completed with never reached the log.
        return;
      }
      conversation.turnInProgress = false;
      this.setSessionState(sessionId, "idle");
      if (message.subtype === "success") {
        this.safeEmit(sessionId, "turn.completed", () => {
          this.host.emit(sessionId, "turn.completed", {
            turnId,
            durationMs: message.duration_ms,
            summary: message.result,
          });
        });
        this.safeEmit(sessionId, "usage.updated", () => {
          this.host.emit(sessionId, "usage.updated", {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }),
          });
        });
        return;
      }

      // An SDKResultError (error_max_turns, error_during_execution, ...) is a normal, non-thrown
      // turn outcome, not a pump crash: surface it as an `error` event rather than a
      // turn.completed, but usage is still meaningful and must still be reported.
      this.safeEmit(sessionId, "error", () => {
        this.host.emit(sessionId, "error", {
          code: message.subtype,
          message: message.errors.length > 0 ? message.errors.join("; ") : message.subtype,
          fatal: false,
        });
      });
      this.safeEmit(sessionId, "usage.updated", () => {
        this.host.emit(sessionId, "usage.updated", {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }),
        });
      });
    }
  }

  /**
   * `async` so a synchronous throw from `requireConversation` (e.g. the conversation was
   * terminated by a concurrent `cancel()`/pump-crash between the SDK deciding to call this and
   * actually calling it) becomes a rejected `Promise<PermissionResult>` rather than an uncaught
   * synchronous exception into the SDK's callback. Denies instead of rejecting outright, since a
   * missing conversation here just means "already terminal" from the caller's point of view.
   */
  private async handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    let conversation: Conversation;
    try {
      conversation = this.requireConversation(sessionId);
    } catch {
      return { behavior: "deny", message: "session terminated", interrupt: true };
    }
    return this.withInteractionLock(conversation, () =>
      this.runInteraction(sessionId, conversation, toolName, input, callOptions),
    );
  }

  /** Runs one `canUseTool`/`AskUserQuestion` interaction to completion, holding the
   * conversation's interaction lock for its whole duration (including the wait for the user's
   * decision). Only one of these runs at a time per conversation. */
  private async runInteraction(
    sessionId: string,
    conversation: Conversation,
    toolName: string,
    input: Record<string, unknown>,
    callOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (conversation.terminal) {
      return { behavior: "deny", message: "session terminated", interrupt: true };
    }
    const turnId = conversation.turnId ?? `trn_${++this.counter}`;

    if (toolName === "AskUserQuestion") {
      // Narrowed by toolName: the SDK only shapes `input` this way for this tool.
      const askInput = input as unknown as AskUserQuestionInput;
      const questions = askInput.questions;
      // The SDK's type guarantees 1-4 questions, but `input` arrives as an untyped
      // `Record<string, unknown>` cast past that guarantee, so still check defensively.
      if (questions[0] === undefined) {
        return { behavior: "deny", message: "no question supplied" };
      }
      // The SDK allows 1-4 questions per call. Each is asked in turn through the same pending
      // slot (never more than one visible pending at once), and every answer is folded into a
      // single AskUserQuestionOutput-shaped result.
      const answers: Record<string, string> = {};
      let freeTextResponse: string | undefined;
      for (const question of questions) {
        if (conversation.terminal) {
          return { behavior: "deny", message: "session terminated", interrupt: true };
        }
        const questionId = `qst_${randomUUID()}`;
        this.setSessionState(sessionId, "waiting");
        const result = await this.awaitInteraction(
          callOptions.signal,
          () => {
            // Only emits when this question is the one still occupying the slot: an abort that
            // beats registration has no outstanding card for the client to clear.
            if (conversation.pendingQuestion?.questionId === questionId) {
              clearTimeout(conversation.pendingQuestion.expiryTimer);
              conversation.pendingQuestion = undefined;
              this.resolvePendingQuestionEvent(sessionId, questionId, "superseded");
            }
            // The SDK can abort this specific call (e.g. the agent gives up on its own question)
            // without the conversation as a whole ending, so `Session.state` must come back from
            // `waiting` to `running` here too, mirroring answerQuestion's resolved path.
            this.restoreRunningState(sessionId, conversation);
          },
          (settle) => {
            const questionExpiresAt = new Date(Date.now() + this.approvalTtlMs).toISOString();
            // Mirrors the approval expiry timer below (C1-001): without an active timer, a
            // question nobody ever answers would hold the interaction lock and subprocess open
            // forever. Fires unless the question is taken off `pendingQuestion` for some other
            // reason first.
            const expiryTimer = setTimeout(() => {
              if (conversation.pendingQuestion?.questionId !== questionId) {
                return;
              }
              conversation.pendingQuestion = undefined;
              this.resolvePendingQuestionEvent(sessionId, questionId, "expired");
              this.restoreRunningState(sessionId, conversation);
              settle({ behavior: "deny", message: "question expired" });
            }, this.approvalTtlMs);
            if (typeof expiryTimer.unref === "function") {
              expiryTimer.unref();
            }
            conversation.pendingQuestion = { questionId, turnId, resolve: settle, question, expiryTimer };
            const emitted = this.safeEmit(sessionId, "question.requested", () => {
              this.host.emit(sessionId, "question.requested", {
                questionId,
                turnId,
                text: question.question,
                options: question.options.map((option, index) => ({ id: `opt_${index}`, label: option.label })),
                allowFreeText: true,
                expiresAt: questionExpiresAt,
              });
            });
            if (!emitted) {
              // The client never learned this question exists, so nobody will ever answer it:
              // deny now instead of holding the SDK call (and the interaction lock) open forever.
              // `safeEmit` has already abandoned the conversation and denied this pending, so the
              // settle below is normally a no-op; it stays as the guard for the case where the
              // conversation was already terminal.
              if (conversation.pendingQuestion?.questionId === questionId) {
                clearTimeout(conversation.pendingQuestion.expiryTimer);
                conversation.pendingQuestion = undefined;
              }
              settle({ behavior: "deny", message: "question.requested could not be persisted", interrupt: true });
            }
          },
        );
        if (result.behavior === "deny") {
          return result;
        }
        const updated = result.updatedInput as { answers?: Record<string, string>; response?: string } | undefined;
        Object.assign(answers, updated?.answers);
        if (updated?.response !== undefined) {
          freeTextResponse = updated.response;
        }
      }
      // `updatedInput` on an 'allow' result is typed `Record<string, unknown>` in
      // `PermissionResult` (sdk.d.ts), but for AskUserQuestion specifically there is no separate
      // "execution" step to feed an input to: the value returned here becomes the tool's result
      // as seen by the model, so it must match `AskUserQuestionOutput` (sdk-tools.d.ts) —
      // `{ questions, answers: Record<string, string>, response? }` — not `AskUserQuestionInput`.
      // The shape below matches `AskUserQuestionOutput` (its `annotations`/`afkTimeoutMs` are
      // both optional and omitted here).
      return {
        behavior: "allow",
        updatedInput: {
          questions,
          answers,
          ...(freeTextResponse === undefined ? {} : { response: freeTextResponse }),
        },
      };
    }

    // `title` is always the exact action text (never the SDK's own summary), so the digest and
    // the card both bind the user's decision to what actually executes. The SDK's own
    // `callOptions.title`, when supplied, is spoken context only and never appears in `title` or
    // the digest.
    const derived = deriveActionText(toolName, input);
    const actionText = derived.text;
    const titleFidelity: TitleFidelity = derived.truncated ? "truncated" : "exact";
    // Truncation marker: the digest/title above are computed over the truncated text, but the
    // full, untruncated input is what actually executes on approval. Surfacing the cut in
    // `detail` (never in `title`/the digest) lets an approver see the card is not the whole
    // action.
    const truncationNote = derived.truncated ? ` … (+${derived.fullLength - derived.text.length} more chars)` : "";
    const approvalId = `apr_${randomUUID()}`;
    const binding: ApprovalBinding = {
      approvalId,
      sessionId,
      turnId,
      toolCallId: callOptions.toolUseID,
      actionDigest: digest(actionText),
      expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(),
    };
    this.setSessionState(sessionId, "waiting");
    return this.awaitInteraction(
      callOptions.signal,
      () => {
        // Same guard as the question path: nothing to report if the abort beat registration.
        if (conversation.pendingApproval?.binding.approvalId === approvalId) {
          clearTimeout(conversation.pendingApproval.expiryTimer);
          conversation.pendingApproval = undefined;
          this.resolvePendingApprovalEvent(sessionId, approvalId, "superseded", "cancelled by agent");
        }
        // Same reasoning as the question path's abort branch: an SDK-initiated abort of this one
        // call does not end the conversation, so `waiting` must be restored to `running` here too.
        this.restoreRunningState(sessionId, conversation);
      },
      (settle) => {
        // C1-001: nobody may ever call approve()/reject() for this approval (dropped watch
        // connection, forgotten card). Without an active timer the lazy expiry check in
        // `takeApproval` never runs on its own, so the `canUseTool` promise — and the interaction
        // lock and subprocess behind it — would stay blocked past `expiresAt` forever. Arm a timer
        // that resolves this exact approval as expired the same way a reject does, unless it has
        // already been taken off `pendingApproval` for some other reason by then.
        const expiryTimer = setTimeout(() => {
          if (conversation.pendingApproval?.binding.approvalId !== approvalId) {
            return;
          }
          conversation.pendingApproval = undefined;
          // Runs on a timer with no caller to catch a throw, so the emit must not be able to
          // throw out of this callback; the deny below still happens either way, so the SDK call
          // is released whether or not the event reached the log.
          this.safeEmit(sessionId, "approval.resolved", () => {
            this.host.emit(sessionId, "approval.resolved", {
              approvalId,
              decision: "expired",
              reason: "expired",
            });
          });
          this.restoreRunningState(sessionId, conversation);
          settle({ behavior: "deny", message: "approval expired" });
        }, this.approvalTtlMs);
        // Never keep the process alive just for this timer (Bun/Node timers only; guarded since
        // `unref` is not part of every timer handle contract).
        if (typeof expiryTimer.unref === "function") {
          expiryTimer.unref();
        }
        conversation.pendingApproval = { binding, resolve: settle, expiryTimer };
        const detail = `${callOptions.description ?? ""}${truncationNote}`.trim();
        const emitted = this.safeEmit(sessionId, "approval.requested", () => {
          this.host.emit(sessionId, "approval.requested", {
            binding,
            kind: deriveApprovalKind(toolName),
            // Always the same text the digest was computed over, so the card the user sees is
            // exactly what they are binding their decision to.
            title: actionText,
            ...(detail === "" ? {} : { detail }),
            // The SDK's own title, when supplied, is spoken context only: it is never the exact
            // action text and must never be shown in place of `title` or fed to the digest.
            ...(callOptions.title === undefined ? {} : { spokenSummary: callOptions.title }),
            titleFidelity,
            ...(derived.truncated ? { fullLength: derived.fullLength } : {}),
          });
        });
        if (!emitted) {
          // No card ever reached the client, so no approve/reject can arrive: deny rather than
          // let the tool call sit on the interaction lock until the TTL. Same no-op-settle
          // reasoning as the question path above.
          if (conversation.pendingApproval?.binding.approvalId === approvalId) {
            clearTimeout(conversation.pendingApproval.expiryTimer);
            conversation.pendingApproval = undefined;
          }
          settle({ behavior: "deny", message: "approval.requested could not be persisted", interrupt: true });
        }
      },
    );
  }

  /** Looks up the pending approval and refuses the decision unless every field of the binding
   * still matches, and the deadline has not passed. Mirrors `MockProvider`'s `take`. */
  private takeApproval(sessionId: string, conversation: Conversation, binding: ApprovalBinding): PendingApproval {
    const pending = conversation.pendingApproval;
    if (pending === undefined) {
      throw new ApprovalBindingMismatchError(`no pending approval ${binding.approvalId}`);
    }
    const expected = pending.binding;
    const matches =
      expected.approvalId === binding.approvalId &&
      expected.sessionId === sessionId &&
      expected.sessionId === binding.sessionId &&
      expected.turnId === binding.turnId &&
      expected.toolCallId === binding.toolCallId &&
      expected.actionDigest === binding.actionDigest;
    if (!matches) {
      throw new ApprovalBindingMismatchError(`binding does not match approval ${binding.approvalId}`);
    }
    if (Date.parse(expected.expiresAt) < Date.now()) {
      // Belt-and-braces: the timer armed in `handleCanUseTool` should already have auto-resolved
      // this approval by the time `expiresAt` passes, but clear it regardless so a race between
      // the timer firing and this call can never double-resolve `pending`.
      clearTimeout(pending.expiryTimer);
      conversation.pendingApproval = undefined;
      // Through `safeEmit`, and resolved either way: the timer is already cleared and the pending
      // detached, so an emit that throws here would otherwise leave the SDK's `canUseTool`
      // promise unsettled forever, hanging the subprocess behind the interaction lock.
      this.safeEmit(sessionId, "approval.resolved", () => {
        this.host.emit(sessionId, "approval.resolved", { approvalId: binding.approvalId, decision: "expired" });
      });
      pending.resolve({ behavior: "deny", message: "approval expired" });
      throw new ApprovalBindingMismatchError(`approval ${binding.approvalId} expired`);
    }
    clearTimeout(pending.expiryTimer);
    conversation.pendingApproval = undefined;
    return pending;
  }
}

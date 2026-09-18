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
  TurnInProgressError,
  UnknownSessionError,
  type AgentCapabilities,
  type AgentProvider,
  type ApprovalBinding,
  type CreateSessionOptions,
  type Project,
  type ProviderHost,
  type QuestionAnswerPayload,
  type Session,
  type SessionCompletedPayload,
  type SessionState,
} from "@agentremote/protocol";

export {
  ApprovalBindingMismatchError,
  InteractionPendingError,
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
}

interface PendingApproval {
  binding: ApprovalBinding;
  resolve: (result: PermissionResult) => void;
}

/** A single question from `AskUserQuestion`, kept so an answer can be translated back into the
 * `updatedInput` shape the SDK expects. */
interface PendingQuestion {
  questionId: string;
  turnId: string;
  resolve: (result: PermissionResult) => void;
  question: AskUserQuestionInput["questions"][number];
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

function truncateActionText(text: string): string {
  return text.length > ACTION_TEXT_MAX_LENGTH ? `${text.slice(0, ACTION_TEXT_MAX_LENGTH - 1)}…` : text;
}

/** Derives the text shown to the user for an approval card from the same `toolName`+`input`
 * that `actionDigest` is computed over, so the binding the user approves always matches what
 * they were shown. Bash surfaces the command itself; Edit/Write surface the file path; anything
 * else falls back to the tool name plus its input, never a generic placeholder. */
function deriveActionText(toolName: string, input: Record<string, unknown>): string {
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
  private readonly sessions = new Map<string, Session>();
  private readonly conversations = new Map<string, Conversation>();
  private counter = 0;

  constructor(host: ProviderHost, options: ClaudeProviderOptions) {
    this.host = host;
    this.projects = options.projects;
    this.queryFn = options.query ?? realQuery;
    this.permissionMode = options.permissionMode;
    this.approvalTtlMs = options.approvalTtlMs ?? APPROVAL_TTL_MS;
  }

  /** Registers a session the bridge already knows about and starts its conversation, without
   * emitting `session.started`. Mirrors `MockProvider.seedSession`. */
  seedSession(session: Session): void {
    const project = this.projects.find((candidate) => candidate.id === session.projectId);
    if (project === undefined) {
      throw new Error(`unknown projectId: ${session.projectId}`);
    }
    this.sessions.set(session.id, session);
    this.startConversation(session.id, project);
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
    const now = new Date().toISOString();
    const session: Session = {
      id: `ses_${++this.counter}`,
      projectId,
      provider: this.id,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      ...(options?.title === undefined ? {} : { title: options.title }),
    };
    this.sessions.set(session.id, session);
    this.startConversation(session.id, project);
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
    pending.resolve({ behavior: "deny", message: reason ?? "Rejected by user" });
  }

  async cancel(sessionId: string): Promise<void> {
    // Mirrors approve/reject: an unknown session id throws rather than emitting a phantom
    // session.completed for a session that never existed.
    const conversation = this.requireConversation(sessionId);
    try {
      await conversation.queryHandle.interrupt();
    } catch (error) {
      this.host.emit(sessionId, "error", {
        code: "provider_error",
        message: `interrupt failed: ${errorMessage(error)}`,
        fatal: false,
      });
    }
    await this.terminateConversation(sessionId, conversation, "cancelled");
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
    conversation.pendingQuestion = undefined;

    const answerText = optionLabel ?? answer.text ?? "";

    this.host.emit(sessionId, "question.answered", { questionId: answer.questionId, answer: answerText });

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
    void this.pumpMessages(sessionId, queryHandle);
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
      conversation.pendingApproval.resolve({ behavior: "deny", message: "session terminated", interrupt: true });
      conversation.pendingApproval = undefined;
    }
    if (conversation.pendingQuestion !== undefined) {
      conversation.pendingQuestion.resolve({ behavior: "deny", message: "session terminated", interrupt: true });
      conversation.pendingQuestion = undefined;
    }
    try {
      // `Query` extends `AsyncGenerator`; `.return()` is its close/dispose method (there is no
      // separate `close()` on the interface) and stops the underlying subprocess.
      await conversation.queryHandle.return(undefined);
    } catch {
      // Best effort: the generator/process may already be gone.
    }
    this.conversations.delete(sessionId);
    this.sessions.delete(sessionId);
    this.host.emit(sessionId, "session.completed", { reason });
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

  private async pumpMessages(sessionId: string, queryHandle: Query): Promise<void> {
    try {
      for await (const message of queryHandle) {
        try {
          this.handleMessage(sessionId, message);
        } catch (error) {
          // Distinct from the SDK/transport failure below: this is a bug in our own mapping of
          // an otherwise healthy message, not the agent process failing.
          this.host.emit(sessionId, "error", {
            code: "message_handling_error",
            message: errorMessage(error),
            fatal: true,
          });
          const conversation = this.conversations.get(sessionId);
          if (conversation !== undefined) {
            await this.terminateConversation(sessionId, conversation, "error");
          }
          return;
        }
      }
      // The SDK's async generator ended without ever yielding a `result` message while a turn was
      // still in progress. Gated on `turnInProgress` rather than merely `!terminal`: a generator
      // that ends right after a normal successful `result` already has `turnInProgress` false and
      // must not be treated as an abnormal teardown. Not a thrown error, but the conversation is
      // over all the same: without this, the session and its subprocess would be left registered
      // as alive forever.
      const conversation = this.conversations.get(sessionId);
      if (conversation !== undefined && !conversation.terminal && conversation.turnInProgress) {
        this.host.emit(sessionId, "error", {
          code: "provider_error",
          message: "conversation ended without a result",
          fatal: true,
        });
        await this.terminateConversation(sessionId, conversation, "error");
      }
    } catch (error) {
      this.host.emit(sessionId, "error", {
        code: "provider_error",
        message: errorMessage(error),
        fatal: true,
      });
      const conversation = this.conversations.get(sessionId);
      if (conversation !== undefined) {
        await this.terminateConversation(sessionId, conversation, "error");
      }
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
    this.host.emit(sessionId, "agent.message", {
      messageId: pending.messageId,
      role: "assistant",
      text: pending.text,
      final: true,
    });
  }

  private handleMessage(sessionId: string, message: SDKMessage): void {
    const conversation = this.conversations.get(sessionId);
    const turnId = conversation?.turnId ?? `trn_${this.counter}`;

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
              this.host.emit(sessionId, "agent.message", {
                messageId: previous.messageId,
                role: "assistant",
                text: previous.text,
                final: false,
              });
            }
            conversation.pendingAssistantMessage = { messageId: message.uuid, text: block.text };
          } else {
            // No conversation to hold this back against (already torn down): emit immediately,
            // since there is nowhere to buffer it and nothing left that could still follow it.
            this.host.emit(sessionId, "agent.message", {
              messageId: message.uuid,
              role: "assistant",
              text: block.text,
              final: true,
            });
          }
        }
      }
      return;
    }

    if (message.type === "result") {
      this.flushPendingAssistantMessage(sessionId, conversation);
      if (conversation !== undefined) {
        conversation.turnInProgress = false;
        this.setSessionState(sessionId, "idle");
      }
      if (message.subtype === "success") {
        this.host.emit(sessionId, "turn.completed", {
          turnId,
          durationMs: message.duration_ms,
          summary: message.result,
        });
        this.host.emit(sessionId, "usage.updated", {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }),
        });
        return;
      }

      // An SDKResultError (error_max_turns, error_during_execution, ...) is a normal, non-thrown
      // turn outcome, not a pump crash: surface it as an `error` event rather than a
      // turn.completed, but usage is still meaningful and must still be reported.
      this.host.emit(sessionId, "error", {
        code: message.subtype,
        message: message.errors.length > 0 ? message.errors.join("; ") : message.subtype,
        fatal: false,
      });
      this.host.emit(sessionId, "usage.updated", {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }),
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
        const questionId = `qst_${++this.counter}`;
        this.setSessionState(sessionId, "waiting");
        const result = await this.awaitInteraction(
          callOptions.signal,
          () => {
            conversation.pendingQuestion = undefined;
          },
          (settle) => {
            conversation.pendingQuestion = { questionId, turnId, resolve: settle, question };
            this.host.emit(sessionId, "question.requested", {
              questionId,
              turnId,
              text: question.question,
              options: question.options.map((option, index) => ({ id: `opt_${index}`, label: option.label })),
              allowFreeText: true,
            });
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

    const actionText = callOptions.title ?? deriveActionText(toolName, input);
    const approvalId = `apr_${++this.counter}`;
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
        conversation.pendingApproval = undefined;
      },
      (settle) => {
        conversation.pendingApproval = { binding, resolve: settle };
        this.host.emit(sessionId, "approval.requested", {
          binding,
          kind: "other",
          // Always the same text the digest was computed over, so the card the user sees is
          // exactly what they are binding their decision to.
          title: actionText,
          ...(callOptions.description === undefined ? {} : { detail: callOptions.description }),
          ...(callOptions.title === undefined ? {} : { spokenSummary: callOptions.title }),
        });
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
      conversation.pendingApproval = undefined;
      this.host.emit(sessionId, "approval.resolved", { approvalId: binding.approvalId, decision: "expired" });
      pending.resolve({ behavior: "deny", message: "approval expired" });
      throw new ApprovalBindingMismatchError(`approval ${binding.approvalId} expired`);
    }
    conversation.pendingApproval = undefined;
    return pending;
  }
}

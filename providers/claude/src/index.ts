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
  type AgentCapabilities,
  type AgentProvider,
  type ApprovalBinding,
  type CreateSessionOptions,
  type Project,
  type ProviderHost,
  type QuestionAnswerPayload,
  type Session,
} from "@agentremote/protocol";

export { ApprovalBindingMismatchError, InteractionPendingError, type ProviderHost } from "@agentremote/protocol";

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
    this.sessions.set(session.id, session);
    const project = this.projects.find((candidate) => candidate.id === session.projectId);
    if (project !== undefined) {
      this.startConversation(session.id, project);
    }
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

    const turnId = `trn_${++this.counter}`;
    conversation.turnId = turnId;
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
    const conversation = this.conversations.get(sessionId);
    if (conversation !== undefined) {
      if (conversation.pendingApproval !== undefined) {
        conversation.pendingApproval.resolve({ behavior: "deny", message: "cancelled", interrupt: true });
        conversation.pendingApproval = undefined;
      }
      if (conversation.pendingQuestion !== undefined) {
        conversation.pendingQuestion.resolve({ behavior: "deny", message: "cancelled", interrupt: true });
        conversation.pendingQuestion = undefined;
      }
      await conversation.queryHandle.interrupt();
    }
    this.host.emit(sessionId, "session.completed", { reason: "cancelled" });
  }

  async answerQuestion(sessionId: string, answer: QuestionAnswerPayload): Promise<void> {
    const conversation = this.requireConversation(sessionId);
    const pending = conversation.pendingQuestion;
    if (pending === undefined || pending.questionId !== answer.questionId) {
      throw new Error(`no pending question ${answer.questionId}`);
    }
    conversation.pendingQuestion = undefined;

    const optionIndex = answer.optionId === undefined ? undefined : Number.parseInt(answer.optionId.replace("opt_", ""), 10);
    const optionLabel = optionIndex === undefined ? undefined : pending.question.options[optionIndex]?.label;
    const answerText = optionLabel ?? answer.text ?? answer.optionId ?? "";

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

  private requireConversation(sessionId: string): Conversation {
    const conversation = this.conversations.get(sessionId);
    if (conversation === undefined) {
      throw new Error(`no conversation for session ${sessionId}`);
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
    const conversation: Conversation = { projectId: project.id, cwd: project.path, queryHandle, push };
    this.conversations.set(sessionId, conversation);
    void this.pumpMessages(sessionId, queryHandle);
  }

  private async pumpMessages(sessionId: string, queryHandle: Query): Promise<void> {
    try {
      for await (const message of queryHandle) {
        this.handleMessage(sessionId, message);
      }
    } catch (error) {
      this.host.emit(sessionId, "error", {
        code: "provider_error",
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
    }
  }

  private handleMessage(sessionId: string, message: SDKMessage): void {
    const conversation = this.conversations.get(sessionId);
    const turnId = conversation?.turnId ?? `trn_${this.counter}`;

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          this.host.emit(sessionId, "agent.message", {
            messageId: message.uuid,
            role: "assistant",
            text: block.text,
            final: true,
          });
        }
      }
      return;
    }

    if (message.type === "result") {
      this.host.emit(sessionId, "turn.completed", {
        turnId,
        durationMs: message.duration_ms,
        summary: message.subtype === "success" ? message.result : message.subtype,
      });
      if (message.subtype === "success") {
        this.host.emit(sessionId, "usage.updated", {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }),
        });
      }
    }
  }

  private async handleCanUseTool(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const conversation = this.requireConversation(sessionId);
    const turnId = conversation.turnId ?? `trn_${++this.counter}`;

    if (toolName === "AskUserQuestion") {
      // Narrowed by toolName: the SDK only shapes `input` this way for this tool.
      const askInput = input as unknown as AskUserQuestionInput;
      const first = askInput.questions[0];
      if (first === undefined) {
        return { behavior: "deny", message: "no question supplied" };
      }
      const questionId = `qst_${++this.counter}`;
      return new Promise<PermissionResult>((resolve) => {
        conversation.pendingQuestion = { questionId, turnId, resolve, question: first };
        this.host.emit(sessionId, "question.requested", {
          questionId,
          turnId,
          text: first.question,
          options: first.options.map((option, index) => ({ id: `opt_${index}`, label: option.label })),
          allowFreeText: true,
        });
      });
    }

    const actionText = callOptions.title ?? `${toolName} ${JSON.stringify(input)}`;
    const approvalId = `apr_${++this.counter}`;
    const binding: ApprovalBinding = {
      approvalId,
      sessionId,
      turnId,
      toolCallId: callOptions.toolUseID,
      actionDigest: digest(actionText),
      expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(),
    };
    return new Promise<PermissionResult>((resolve) => {
      conversation.pendingApproval = { binding, resolve };
      this.host.emit(sessionId, "approval.requested", {
        binding,
        kind: "other",
        title: callOptions.title ?? `Run ${toolName}`,
        ...(callOptions.description === undefined ? {} : { detail: callOptions.description }),
        ...(callOptions.title === undefined ? {} : { spokenSummary: callOptions.title }),
      });
    });
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

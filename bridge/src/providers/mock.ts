import { randomUUID } from "node:crypto";
import {
  APPROVAL_TTL_MS,
  ApprovalBindingMismatchError,
  digest,
  InteractionPendingError,
  type AgentCapabilities,
  type AgentEvent,
  type AgentProvider,
  type ApprovalBinding,
  type CreateSessionOptions,
  type Project,
  type ProviderHost,
  type QuestionAnswerPayload,
  type Session,
} from "@agentremote/protocol";

export { ApprovalBindingMismatchError, InteractionPendingError, type ProviderHost } from "@agentremote/protocol";

/** Mirrors `ClaudeProvider`'s `ACTION_TEXT_MAX_LENGTH`. Not exported from the protocol package
 * (it is a provider display choice, not a wire contract), so kept in sync here by hand. */
const ACTION_TEXT_MAX_LENGTH = 200;

interface PendingApproval {
  binding: ApprovalBinding;
  turnId: string;
  /** Fires `ttlMs` after the approval was created and auto-resolves it as expired if nobody has
   * approved/rejected/cancelled it by then, mirroring `ClaudeProvider`'s C1-001 timer. Cleared by
   * every path that takes this approval out of `pending` for any other reason. */
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  sessionId: string;
  turnId: string;
  /** The question-side counterpart of `PendingApproval.expiryTimer`. */
  expiryTimer: ReturnType<typeof setTimeout>;
}

export interface MockProviderOptions {
  /** Overrides `APPROVAL_TTL_MS` for both approvals and questions. Exists for tests that need to
   * exercise expiry deterministically instead of waiting out the production default. */
  ttlMs?: number;
  /** Clock used to compute `expiresAt` on approvals and questions. Production uses the real
   * clock; tests pass a fixed one for determinism. */
  now?: () => Date;
}

/**
 * A provider that scripts a plausible agent turn without launching anything. It exists so the
 * transport, the event log and the approval flow can be exercised before a real agent adapter
 * is written. Emission is synchronous, which keeps tests deterministic.
 */
export class MockProvider implements AgentProvider {
  readonly id = "mock";

  readonly capabilities: AgentCapabilities = {
    approvals: true,
    questions: true,
    resumeSession: false,
    streaming: true,
    usage: true,
  };

  private readonly host: ProviderHost;
  private readonly projects: Project[];
  private readonly sessions: Map<string, Session> = new Map();
  private readonly pending: Map<string, PendingApproval> = new Map();
  private readonly pendingQuestions: Map<string, PendingQuestion> = new Map();
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private counter = 0;

  constructor(host: ProviderHost, options: MockProviderOptions = {}) {
    this.host = host;
    this.projects = [{ id: "prj_demo", name: "demo", path: "/Users/you/code/demo" }];
    this.ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Registers a session the bridge already knows about, without emitting anything. */
  seedSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects];
  }

  async listSessions(projectId?: string): Promise<Session[]> {
    const all = [...this.sessions.values()];
    return projectId === undefined ? all : all.filter((s) => s.projectId === projectId);
  }

  async createSession(projectId: string, options?: CreateSessionOptions): Promise<Session> {
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
    this.host.emit(session.id, "session.started", { projectId, resumed: false });
    return session;
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.binding.sessionId === sessionId) {
        throw new InteractionPendingError(
          `session ${sessionId} has a pending approval ${pending.binding.approvalId}; resolve or cancel it first`,
        );
      }
    }
    for (const [questionId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        throw new InteractionPendingError(
          `session ${sessionId} has a pending question ${questionId}; resolve or cancel it first`,
        );
      }
    }

    const turnId = `trn_${++this.counter}`;
    const executionId = `exe_${++this.counter}`;
    const command = "bun test";

    this.host.emit(sessionId, "turn.started", { turnId, prompt: text });
    this.host.emit(sessionId, "agent.thinking", { turnId, text: "Reading the test suite" });
    this.host.emit(sessionId, "command.started", { executionId, command, cwd: "/Users/you/code/demo" });
    this.host.emit(sessionId, "command.output", { executionId, stream: "stdout", chunk: "4 pass, 0 fail\n" });
    this.host.emit(sessionId, "command.completed", { executionId, exitCode: 0, durationMs: 120 });

    // Scripted trigger for a desk-only card: a prompt containing "desk" (case-insensitive)
    // scripts a long action whose exact text does not fit the display limit, so the simulator
    // can exercise the Watch's desk-only path without a real long-running agent action.
    const wantsDeskOnlyCard = /desk/i.test(text);
    const action = wantsDeskOnlyCard
      ? `git push origin main --force-with-lease --push-option=ci.skip --push-option=deploy.notify=${"a".repeat(240)}`
      : "git push origin main";
    const truncated = action.length > ACTION_TEXT_MAX_LENGTH;
    const title = wantsDeskOnlyCard ? action.slice(0, ACTION_TEXT_MAX_LENGTH - 1) + "…" : `Run ${action}`;
    const binding: ApprovalBinding = {
      approvalId: `apr_${randomUUID()}`,
      sessionId,
      turnId,
      toolCallId: `tc_${++this.counter}`,
      actionDigest: digest(action),
      expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
    };
    const expiryTimer = this.armApprovalExpiry(sessionId, binding.approvalId);
    this.pending.set(binding.approvalId, { binding, turnId, expiryTimer });
    this.host.emit(sessionId, "approval.requested", {
      binding,
      kind: "command",
      title,
      detail: wantsDeskOnlyCard
        ? "Long scripted action for the desk-only card (mock provider)."
        : "Pushes the committed work to the shared branch.",
      spokenSummary: wantsDeskOnlyCard
        ? "Claude wants to run a long command. Review at the Mac."
        : "Claude wants to push to origin main. Allow or deny?",
      titleFidelity: wantsDeskOnlyCard ? "truncated" : "exact",
      ...(truncated ? { fullLength: action.length } : {}),
    });
  }

  async approve(sessionId: string, binding: ApprovalBinding): Promise<void> {
    const pending = this.take(sessionId, binding);
    this.host.emit(sessionId, "approval.resolved", {
      approvalId: binding.approvalId,
      decision: "accepted",
    });

    const questionId = `qst_${randomUUID()}`;
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    const expiryTimer = this.armQuestionExpiry(sessionId, questionId);
    this.pendingQuestions.set(questionId, { sessionId, turnId: pending.turnId, expiryTimer });
    this.host.emit(sessionId, "question.requested", {
      questionId,
      turnId: pending.turnId,
      text: "Open a pull request for this change?",
      options: [
        { id: "opt_yes", label: "Yes, open a PR" },
        { id: "opt_no", label: "No, just push" },
      ],
      allowFreeText: true,
      spokenSummary: "Should I open a pull request for this change, or just push?",
      expiresAt,
    });
  }

  async reject(sessionId: string, binding: ApprovalBinding, reason?: string): Promise<void> {
    const pending = this.take(sessionId, binding);
    this.host.emit(sessionId, "approval.resolved", {
      approvalId: binding.approvalId,
      decision: "rejected",
      ...(reason === undefined ? {} : { reason }),
    });
    this.finishTurn(sessionId, pending.turnId, "Stopped without pushing.");
  }

  async cancel(sessionId: string): Promise<void> {
    // Reported to the client before `session.completed` below, so a card still on screen for
    // one of this session's pending interactions is told why it is going away rather than just
    // vanishing when the session ends.
    for (const [approvalId, pending] of this.pending) {
      if (pending.binding.sessionId === sessionId) {
        clearTimeout(pending.expiryTimer);
        this.pending.delete(approvalId);
        this.host.emit(sessionId, "approval.resolved", { approvalId, decision: "cancelled" });
      }
    }
    for (const [questionId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expiryTimer);
        this.pendingQuestions.delete(questionId);
        this.host.emit(sessionId, "question.answered", { questionId, answer: "", outcome: "cancelled" });
      }
    }
    this.host.emit(sessionId, "session.completed", { reason: "cancelled" });
  }

  async answerQuestion(sessionId: string, answer: QuestionAnswerPayload): Promise<void> {
    const pending = this.pendingQuestions.get(answer.questionId);
    if (pending === undefined) {
      throw new Error(`no pending question ${answer.questionId}`);
    }
    if (pending.sessionId !== sessionId) {
      // Mirrors `take`'s binding check for approvals: a question answered under a different
      // session's id must not resolve another session's pending question, and must not leak
      // whether that question exists.
      throw new ApprovalBindingMismatchError(`no pending question ${answer.questionId}`);
    }
    clearTimeout(pending.expiryTimer);
    this.pendingQuestions.delete(answer.questionId);
    const answerText = answer.optionId ?? answer.text ?? "";
    this.host.emit(sessionId, "question.answered", {
      questionId: answer.questionId,
      answer: answerText,
      outcome: "answered",
    });
    const summary =
      answer.optionId === "opt_yes"
        ? "Pushed to origin/main and opened a pull request."
        : "Pushed to origin/main.";
    this.finishTurn(sessionId, pending.turnId, summary);
  }

  async *subscribe(sessionId: string, afterEvent = 0): AsyncIterable<AgentEvent> {
    let cursor = afterEvent;
    for (;;) {
      const batch = this.host.eventsAfter(cursor).filter((e) => e.sessionId === sessionId);
      for (const event of batch) {
        cursor = Math.max(cursor, event.eventId);
        yield event;
      }
      await this.host.waitForChange(1000);
    }
  }

  private finishTurn(sessionId: string, turnId: string, summary: string): void {
    this.host.emit(sessionId, "agent.message", {
      messageId: `msg_${++this.counter}`,
      role: "assistant",
      text: summary,
      final: true,
    });
    this.host.emit(sessionId, "turn.completed", { turnId, durationMs: 250, summary });
    this.host.emit(sessionId, "usage.updated", { inputTokens: 1200, outputTokens: 340 });
  }

  /**
   * Looks up the pending approval and refuses the decision unless every field of the binding
   * still matches, and the deadline has not passed.
   */
  private take(sessionId: string, binding: ApprovalBinding): PendingApproval {
    const pending = this.pending.get(binding.approvalId);
    if (pending === undefined) {
      throw new ApprovalBindingMismatchError(`no pending approval ${binding.approvalId}`);
    }
    const expected = pending.binding;
    const matches =
      expected.sessionId === sessionId &&
      expected.sessionId === binding.sessionId &&
      expected.turnId === binding.turnId &&
      expected.toolCallId === binding.toolCallId &&
      expected.actionDigest === binding.actionDigest;
    if (!matches) {
      throw new ApprovalBindingMismatchError(`binding does not match approval ${binding.approvalId}`);
    }
    if (Date.parse(expected.expiresAt) < this.now().getTime()) {
      // Belt-and-braces, mirroring `ClaudeProvider.takeApproval`: the armed expiry timer should
      // already have resolved this approval by the time `expiresAt` passes, but clear it
      // regardless so a race between the timer firing and this call can never double-resolve.
      clearTimeout(pending.expiryTimer);
      this.pending.delete(binding.approvalId);
      this.host.emit(sessionId, "approval.resolved", {
        approvalId: binding.approvalId,
        decision: "expired",
      });
      throw new ApprovalBindingMismatchError(`approval ${binding.approvalId} expired`);
    }
    clearTimeout(pending.expiryTimer);
    this.pending.delete(binding.approvalId);
    return pending;
  }

  /** Arms an unref'd timer that auto-resolves `approvalId` as expired if nobody has taken it off
   * `pending` by the time `ttlMs` elapses. Mirrors `ClaudeProvider`'s C1-001 timer so an approval
   * nobody ever decides cannot hold the interaction open forever. */
  private armApprovalExpiry(sessionId: string, approvalId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.pending.has(approvalId)) {
        return;
      }
      this.pending.delete(approvalId);
      this.host.emit(sessionId, "approval.resolved", { approvalId, decision: "expired" });
    }, this.ttlMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return timer;
  }

  /** The question-side counterpart of `armApprovalExpiry`. */
  private armQuestionExpiry(sessionId: string, questionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.pendingQuestions.has(questionId)) {
        return;
      }
      this.pendingQuestions.delete(questionId);
      this.host.emit(sessionId, "question.answered", { questionId, answer: "", outcome: "expired" });
    }, this.ttlMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return timer;
  }
}

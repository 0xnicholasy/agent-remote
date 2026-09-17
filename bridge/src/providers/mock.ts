import { createHash } from "node:crypto";

import type {
  AgentCapabilities,
  AgentEvent,
  AgentEventPayloadMap,
  AgentEventType,
  AgentProvider,
  ApprovalBinding,
  CreateSessionOptions,
  Project,
  QuestionAnswerPayload,
  Session,
} from "@agentremote/protocol";

/**
 * Everything the provider needs from the bridge. The bridge owns the event log and the
 * event id sequence, so the provider is handed an emitter rather than numbering its own
 * events.
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

export class ApprovalBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalBindingMismatchError";
  }
}

interface PendingApproval {
  binding: ApprovalBinding;
  turnId: string;
}

interface PendingQuestion {
  turnId: string;
}

const APPROVAL_TTL_MS = 5 * 60 * 1000;

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
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
  private counter = 0;

  constructor(host: ProviderHost) {
    this.host = host;
    this.projects = [{ id: "prj_demo", name: "demo", path: "/Users/you/code/demo" }];
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
    const turnId = `trn_${++this.counter}`;
    const executionId = `exe_${++this.counter}`;
    const command = "bun test";

    this.host.emit(sessionId, "turn.started", { turnId, prompt: text });
    this.host.emit(sessionId, "agent.thinking", { turnId, text: "Reading the test suite" });
    this.host.emit(sessionId, "command.started", { executionId, command, cwd: "/Users/you/code/demo" });
    this.host.emit(sessionId, "command.output", { executionId, stream: "stdout", chunk: "4 pass, 0 fail\n" });
    this.host.emit(sessionId, "command.completed", { executionId, exitCode: 0, durationMs: 120 });

    const action = "git push origin main";
    const binding: ApprovalBinding = {
      approvalId: `apr_${++this.counter}`,
      sessionId,
      turnId,
      toolCallId: `tc_${++this.counter}`,
      actionDigest: digest(action),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    };
    this.pending.set(binding.approvalId, { binding, turnId });
    this.host.emit(sessionId, "approval.requested", {
      binding,
      kind: "command",
      title: `Run ${action}`,
      detail: "Pushes the committed work to the shared branch.",
      spokenSummary: "Claude wants to push to origin main. Allow or deny?",
    });
  }

  async approve(sessionId: string, binding: ApprovalBinding): Promise<void> {
    const pending = this.take(sessionId, binding);
    this.host.emit(sessionId, "approval.resolved", {
      approvalId: binding.approvalId,
      decision: "accepted",
    });

    const questionId = `qst_${++this.counter}`;
    this.pendingQuestions.set(questionId, { turnId: pending.turnId });
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
    this.pending.clear();
    this.host.emit(sessionId, "session.completed", { reason: "cancelled" });
  }

  async answerQuestion(sessionId: string, answer: QuestionAnswerPayload): Promise<void> {
    const pending = this.pendingQuestions.get(answer.questionId);
    if (pending === undefined) {
      throw new Error(`no pending question ${answer.questionId}`);
    }
    this.pendingQuestions.delete(answer.questionId);
    const answerText = answer.optionId ?? answer.text ?? "";
    this.host.emit(sessionId, "question.answered", {
      questionId: answer.questionId,
      answer: answerText,
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
    if (Date.parse(expected.expiresAt) < Date.now()) {
      this.pending.delete(binding.approvalId);
      this.host.emit(sessionId, "approval.resolved", {
        approvalId: binding.approvalId,
        decision: "expired",
      });
      throw new ApprovalBindingMismatchError(`approval ${binding.approvalId} expired`);
    }
    this.pending.delete(binding.approvalId);
    return pending;
  }
}

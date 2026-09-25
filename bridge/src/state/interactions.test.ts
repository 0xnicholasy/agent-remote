import { describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  ApprovalBinding,
  ApprovalDecision,
  QuestionOutcome,
  TitleFidelity,
} from "@agentremote/protocol";

import { InteractionRegistry } from "./interactions";

const NOW = new Date("2026-09-20T12:00:00.000Z");

let eventId = 0;

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    approvalId: "apr_1",
    sessionId: "ses_a",
    turnId: "trn_1",
    toolCallId: "tc_1",
    actionDigest: "sha256:whatever",
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

function approvalRequested(
  sessionId: string,
  overrides: Partial<ApprovalBinding> = {},
  titleFidelity?: TitleFidelity,
): AgentEvent {
  return {
    eventId: ++eventId,
    sessionId,
    provider: "mock",
    type: "approval.requested",
    timestamp: NOW.toISOString(),
    payload: {
      binding: binding({ sessionId, ...overrides }),
      kind: "command",
      title: "Run it",
      ...(titleFidelity === undefined ? {} : { titleFidelity }),
    },
  };
}

function approvalResolved(sessionId: string, approvalId: string, decision: ApprovalDecision): AgentEvent {
  return {
    eventId: ++eventId,
    sessionId,
    provider: "mock",
    type: "approval.resolved",
    timestamp: NOW.toISOString(),
    payload: { approvalId, decision },
  };
}

function questionRequested(sessionId: string, questionId: string, expiresAt?: string): AgentEvent {
  return {
    eventId: ++eventId,
    sessionId,
    provider: "mock",
    type: "question.requested",
    timestamp: NOW.toISOString(),
    payload: {
      questionId,
      turnId: "trn_1",
      text: "Open a PR?",
      options: [{ id: "opt_yes", label: "Yes" }],
      allowFreeText: true,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  };
}

function questionAnswered(sessionId: string, questionId: string, outcome?: QuestionOutcome): AgentEvent {
  return {
    eventId: ++eventId,
    sessionId,
    provider: "mock",
    type: "question.answered",
    timestamp: NOW.toISOString(),
    payload: { questionId, answer: "opt_yes", ...(outcome === undefined ? {} : { outcome }) },
  };
}

function sessionCompleted(sessionId: string): AgentEvent {
  return {
    eventId: ++eventId,
    sessionId,
    provider: "mock",
    type: "session.completed",
    timestamp: NOW.toISOString(),
    payload: { reason: "completed" },
  };
}

describe("InteractionRegistry", () => {
  test("a pending approval becomes resolved on approval.resolved", () => {
    const registry = new InteractionRegistry();
    registry.observe(approvalRequested("ses_a"));
    expect(registry.get("apr_1")?.state).toBe("pending");

    registry.observe(approvalResolved("ses_a", "apr_1", "accepted"));

    expect(registry.get("apr_1")).toEqual({
      id: "apr_1",
      kind: "approval",
      sessionId: "ses_a",
      state: "resolved",
      expiresAt: binding().expiresAt,
      deskOnly: true,
    });
  });

  test("a terminal state ignores later transitions", () => {
    const registry = new InteractionRegistry();
    registry.observe(approvalRequested("ses_a"));
    registry.observe(approvalResolved("ses_a", "apr_1", "rejected"));
    expect(registry.get("apr_1")?.state).toBe("resolved");

    // A later, out-of-order or duplicate resolution must not move a terminal record.
    registry.observe(approvalResolved("ses_a", "apr_1", "expired"));
    expect(registry.get("apr_1")?.state).toBe("resolved");

    // Nor can a duplicate `requested` resurrect it back to pending.
    registry.observe(approvalRequested("ses_a"));
    expect(registry.get("apr_1")?.state).toBe("resolved");
  });

  test("a session end marks its still-pending interactions cancelled", () => {
    const registry = new InteractionRegistry();
    registry.observe(approvalRequested("ses_a", { approvalId: "apr_1" }));
    registry.observe(questionRequested("ses_a", "qst_1"));
    // A question already answered before the session ends must stay resolved, not be flipped to
    // cancelled by the session end.
    registry.observe(questionRequested("ses_a", "qst_2"));
    registry.observe(questionAnswered("ses_a", "qst_2"));

    registry.observe(sessionCompleted("ses_a"));

    expect(registry.get("apr_1")?.state).toBe("cancelled");
    expect(registry.get("qst_1")?.state).toBe("cancelled");
    expect(registry.get("qst_2")?.state).toBe("resolved");
    expect(registry.pendingFor("ses_a")).toEqual([]);
  });

  test("rebuild from events restores the pending set", () => {
    const events: AgentEvent[] = [
      approvalRequested("ses_a", { approvalId: "apr_1" }),
      questionRequested("ses_b", "qst_1"),
      approvalRequested("ses_b", { approvalId: "apr_2" }),
      approvalResolved("ses_b", "apr_2", "accepted"),
    ];

    const registry = new InteractionRegistry();
    registry.rebuild(events);

    expect(registry.get("apr_1")?.state).toBe("pending");
    expect(registry.get("qst_1")?.state).toBe("pending");
    expect(registry.get("apr_2")?.state).toBe("resolved");
    expect(registry.pendingFor("ses_a").map((r) => r.id)).toEqual(["apr_1"]);
    expect(registry.pendingFor("ses_b").map((r) => r.id)).toEqual(["qst_1"]);

    // rebuild replaces prior state rather than accumulating.
    registry.rebuild([]);
    expect(registry.size()).toBe(0);
  });

  test("approval.resolved cancelled/superseded map directly to the matching state", () => {
    const registry = new InteractionRegistry();
    registry.observe(approvalRequested("ses_a", { approvalId: "apr_cancelled" }));
    registry.observe(approvalResolved("ses_a", "apr_cancelled", "cancelled"));
    expect(registry.get("apr_cancelled")?.state).toBe("cancelled");

    registry.observe(approvalRequested("ses_a", { approvalId: "apr_superseded" }));
    registry.observe(approvalResolved("ses_a", "apr_superseded", "superseded"));
    expect(registry.get("apr_superseded")?.state).toBe("superseded");
  });

  test("question.answered uses outcome when present, else defaults to resolved", () => {
    const registry = new InteractionRegistry();

    registry.observe(questionRequested("ses_a", "qst_answered"));
    registry.observe(questionAnswered("ses_a", "qst_answered", "answered"));
    expect(registry.get("qst_answered")?.state).toBe("resolved");

    registry.observe(questionRequested("ses_a", "qst_expired"));
    registry.observe(questionAnswered("ses_a", "qst_expired", "expired"));
    expect(registry.get("qst_expired")?.state).toBe("expired");

    registry.observe(questionRequested("ses_a", "qst_cancelled"));
    registry.observe(questionAnswered("ses_a", "qst_cancelled", "cancelled"));
    expect(registry.get("qst_cancelled")?.state).toBe("cancelled");

    registry.observe(questionRequested("ses_a", "qst_superseded"));
    registry.observe(questionAnswered("ses_a", "qst_superseded", "superseded"));
    expect(registry.get("qst_superseded")?.state).toBe("superseded");

    registry.observe(questionRequested("ses_a", "qst_no_outcome"));
    registry.observe(questionAnswered("ses_a", "qst_no_outcome"));
    expect(registry.get("qst_no_outcome")?.state).toBe("resolved");
  });

  test("question.requested stores expiresAt on the record", () => {
    const registry = new InteractionRegistry();
    const expiresAt = new Date(NOW.getTime() + 30_000).toISOString();
    registry.observe(questionRequested("ses_a", "qst_1", expiresAt));
    expect(registry.get("qst_1")?.expiresAt).toBe(expiresAt);
  });

  test("deskOnly is true for truncated or absent titleFidelity, false for exact", () => {
    const registry = new InteractionRegistry();

    registry.observe(approvalRequested("ses_a", { approvalId: "apr_absent" }));
    expect(registry.get("apr_absent")?.deskOnly).toBe(true);

    registry.observe(approvalRequested("ses_a", { approvalId: "apr_truncated" }, "truncated"));
    expect(registry.get("apr_truncated")?.deskOnly).toBe(true);

    registry.observe(approvalRequested("ses_a", { approvalId: "apr_summary" }, "summary"));
    expect(registry.get("apr_summary")?.deskOnly).toBe(true);

    registry.observe(approvalRequested("ses_a", { approvalId: "apr_exact" }, "exact"));
    expect(registry.get("apr_exact")?.deskOnly).toBe(false);
  });

  test("deskOnly survives a rebuild from the event log", () => {
    const events: AgentEvent[] = [
      approvalRequested("ses_a", { approvalId: "apr_exact" }, "exact"),
      approvalRequested("ses_a", { approvalId: "apr_desk" }, "truncated"),
    ];

    const registry = new InteractionRegistry();
    registry.rebuild(events);

    expect(registry.get("apr_exact")?.deskOnly).toBe(false);
    expect(registry.get("apr_desk")?.deskOnly).toBe(true);

    // A fresh registry rebuilt from the same log, mirroring a bridge restart, must land on the
    // same derived values rather than something stored independently of the log.
    const restarted = new InteractionRegistry();
    restarted.rebuild(events);
    expect(restarted.get("apr_exact")?.deskOnly).toBe(false);
    expect(restarted.get("apr_desk")?.deskOnly).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import eventSchema from "../../schema/agent-event.schema.json";
import commandSchema from "../../schema/command.schema.json";
import { requiresDeskReview } from "./index";
import type { AgentEventEnvelope, ApprovalBinding, CommandEnvelope } from "./index";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validateEvent = ajv.compile(eventSchema);
const validateCommand = ajv.compile(commandSchema);

const binding: ApprovalBinding = {
  approvalId: "apr_01",
  sessionId: "ses_01",
  turnId: "trn_01",
  toolCallId: "tc_01",
  actionDigest: "sha256:6f1c0b1e6b4f0a2d",
  expiresAt: "2026-09-14T10:20:00.000Z",
};

const approvalRequested: AgentEventEnvelope<"approval.requested"> = {
  eventId: 42,
  sessionId: "ses_01",
  provider: "mock",
  type: "approval.requested",
  timestamp: "2026-09-14T10:15:00.000Z",
  payload: {
    binding,
    kind: "command",
    title: "Run git push origin main",
    detail: "Pushes 3 commits to origin/main.",
  },
};

const approvalAccept: CommandEnvelope<"approval.accept"> = {
  commandId: "9f3a1d54-3b1e-4a0c-9d58-2f0f1d7c9a11",
  sessionId: "ses_01",
  type: "approval.accept",
  timestamp: "2026-09-14T10:15:30.000Z",
  payload: { binding },
};

// Fixed JSON vector shared with the Swift binding's AgentEventTests. Any change here must be
// mirrored there so both sides are tested against the same bytes.
const titleFidelityVector = {
  eventId: 46,
  sessionId: "ses_01",
  provider: "mock",
  type: "approval.requested",
  timestamp: "2026-09-14T10:19:00.000Z",
  payload: {
    binding,
    kind: "command",
    title: "Run git push origin main",
  },
};

describe("titleFidelity", () => {
  test("titleFidelity 'exact' is valid", () => {
    const event = {
      ...titleFidelityVector,
      payload: { ...titleFidelityVector.payload, titleFidelity: "exact" },
    };
    expect(validateEvent(event)).toBe(true);
    expect(validateEvent.errors ?? []).toEqual([]);
  });

  test("titleFidelity 'bogus' is rejected by the schema", () => {
    const event = {
      ...titleFidelityVector,
      payload: { ...titleFidelityVector.payload, titleFidelity: "bogus" },
    };
    expect(validateEvent(event)).toBe(false);
  });

  test("requiresDeskReview is fail closed", () => {
    expect(requiresDeskReview({})).toBe(true);
    expect(requiresDeskReview({ titleFidelity: "exact" })).toBe(false);
    expect(requiresDeskReview({ titleFidelity: "truncated" })).toBe(true);
    expect(requiresDeskReview({ titleFidelity: "summary" })).toBe(true);
  });
});

describe("protocol samples validate against the JSON Schemas", () => {
  test("a sample approval.requested event is valid", () => {
    const valid = validateEvent(approvalRequested);
    expect(validateEvent.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test("a sample approval.accept command is valid", () => {
    const valid = validateCommand(approvalAccept);
    expect(validateCommand.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test("an approval.requested event missing its binding is rejected", () => {
    const broken = { ...approvalRequested, payload: { kind: "command", title: "x" } };
    expect(validateEvent(broken)).toBe(false);
  });

  test("a command whose payload does not match its type is rejected", () => {
    const broken = { ...approvalAccept, payload: { text: "hello" } };
    expect(validateCommand(broken)).toBe(false);
  });

  test("a sample event carrying the envelope-level projectId is valid", () => {
    const withProjectId: AgentEventEnvelope<"approval.requested"> = {
      ...approvalRequested,
      projectId: "prj_01",
    };
    const valid = validateEvent(withProjectId);
    expect(validateEvent.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  test("an event whose projectId is not a non-empty string is rejected", () => {
    const broken = { ...approvalRequested, projectId: "" };
    expect(validateEvent(broken)).toBe(false);
  });

  test("approval.resolved events with the cancelled and superseded decisions validate", () => {
    for (const decision of ["cancelled", "superseded"] as const) {
      const approvalResolved: AgentEventEnvelope<"approval.resolved"> = {
        eventId: 43,
        sessionId: "ses_01",
        provider: "mock",
        type: "approval.resolved",
        timestamp: "2026-09-14T10:16:00.000Z",
        payload: { approvalId: "apr_01", decision },
      };
      expect(validateEvent(approvalResolved)).toBe(true);
      expect(validateEvent.errors ?? []).toEqual([]);
    }
  });

  test("question.answered events validate with an outcome and without one", () => {
    const withOutcome: AgentEventEnvelope<"question.answered"> = {
      eventId: 44,
      sessionId: "ses_01",
      provider: "mock",
      type: "question.answered",
      timestamp: "2026-09-14T10:17:00.000Z",
      payload: { questionId: "q_01", answer: "", outcome: "cancelled" },
    };
    expect(validateEvent(withOutcome)).toBe(true);
    expect(validateEvent.errors ?? []).toEqual([]);

    const withoutOutcome: AgentEventEnvelope<"question.answered"> = {
      ...withOutcome,
      payload: { questionId: "q_01", answer: "yes" },
    };
    expect(validateEvent(withoutOutcome)).toBe(true);
    expect(validateEvent.errors ?? []).toEqual([]);
  });

  test("question.requested events validate with and without expiresAt", () => {
    const questionRequested: AgentEventEnvelope<"question.requested"> = {
      eventId: 45,
      sessionId: "ses_01",
      provider: "mock",
      type: "question.requested",
      timestamp: "2026-09-14T10:18:00.000Z",
      payload: {
        questionId: "q_02",
        turnId: "trn_01",
        text: "Continue?",
        options: [{ id: "yes", label: "Yes" }],
        allowFreeText: true,
        expiresAt: "2026-09-14T10:23:00.000Z",
      },
    };
    expect(validateEvent(questionRequested)).toBe(true);
    expect(validateEvent.errors ?? []).toEqual([]);

    const withoutExpiresAt: AgentEventEnvelope<"question.requested"> = {
      ...questionRequested,
      payload: {
        questionId: "q_02",
        turnId: "trn_01",
        text: "Continue?",
        options: [{ id: "yes", label: "Yes" }],
        allowFreeText: true,
      },
    };
    expect(validateEvent(withoutExpiresAt)).toBe(true);
    expect(validateEvent.errors ?? []).toEqual([]);
  });
});

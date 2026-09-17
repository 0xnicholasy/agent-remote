import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import eventSchema from "../../schema/agent-event.schema.json";
import commandSchema from "../../schema/command.schema.json";
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
});

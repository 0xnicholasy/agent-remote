import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  ApprovalBinding,
  Command,
  CommandResponse,
  EventsResponse,
  SessionsResponse,
} from "@agentremote/protocol";

import { createBridge, type Bridge } from "./server";

let bridge: Bridge;

function post(command: Command): Promise<Response> {
  return bridge.fetch(
    new Request("http://bridge.local/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    }),
  );
}

async function eventsAfter(after: number): Promise<AgentEvent[]> {
  const response = await bridge.fetch(new Request(`http://bridge.local/v1/events?after=${after}`));
  const body = (await response.json()) as EventsResponse;
  return body.events;
}

function promptCommand(commandId: string): Command {
  return {
    commandId,
    sessionId: bridge.session.id,
    type: "prompt.send",
    timestamp: new Date().toISOString(),
    payload: { text: "run the tests and push" },
  };
}

function pendingBinding(events: AgentEvent[]): ApprovalBinding {
  const requested = events.find((event) => event.type === "approval.requested");
  if (requested === undefined || requested.type !== "approval.requested") {
    throw new Error("no approval.requested event was emitted");
  }
  return requested.payload.binding;
}

function approvalRequested(events: AgentEvent[]) {
  const requested = events.find((event) => event.type === "approval.requested");
  if (requested === undefined || requested.type !== "approval.requested") {
    throw new Error("no approval.requested event was emitted");
  }
  return requested.payload;
}

function pendingQuestion(events: AgentEvent[]) {
  const requested = events.find((event) => event.type === "question.requested");
  if (requested === undefined || requested.type !== "question.requested") {
    throw new Error("no question.requested event was emitted");
  }
  return requested.payload;
}

beforeEach(() => {
  bridge = createBridge();
});

describe("bridge HTTP surface", () => {
  test("a duplicate commandId is executed exactly once", async () => {
    const command = promptCommand("11111111-1111-4111-8111-111111111111");

    const first = (await (await post(command)).json()) as CommandResponse;
    const afterFirst = await eventsAfter(0);

    const second = (await (await post(command)).json()) as CommandResponse;
    const afterSecond = await eventsAfter(0);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  test("two concurrent retries of one commandId still execute it once", async () => {
    const command = promptCommand("77777777-7777-4777-8777-777777777777");
    const [first, second] = await Promise.all([post(command), post(command)]);

    const bodies = (await Promise.all([first.json(), second.json()])) as CommandResponse[];
    const accepted = bodies.filter((body) => body.accepted);
    expect(accepted.length).toBe(1);

    const events = await eventsAfter(0);
    expect(events.filter((event) => event.type === "turn.started").length).toBe(1);
  });

  test("GET /v1/events?after=N returns only newer events with increasing ids", async () => {
    await post(promptCommand("22222222-2222-4222-8222-222222222222"));

    const all = await eventsAfter(0);
    expect(all.length).toBeGreaterThan(3);
    expect(all.map((event) => event.eventId)).toEqual(all.map((_, index) => index + 1));

    const tail = await eventsAfter(3);
    expect(tail.map((event) => event.eventId)).toEqual(all.slice(3).map((event) => event.eventId));
    expect(await eventsAfter(all.length)).toEqual([]);
  });

  test("approval.accept resolves the pending approval and emits approval.resolved", async () => {
    await post(promptCommand("33333333-3333-4333-8333-333333333333"));
    const initialEvents = await eventsAfter(0);
    const binding = pendingBinding(initialEvents);
    expect(typeof approvalRequested(initialEvents).spokenSummary).toBe("string");
    const before = initialEvents.length;

    const response = await post({
      commandId: "44444444-4444-4444-8444-444444444444",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });
    expect(response.status).toBe(200);

    const emitted = await eventsAfter(before);
    const resolved = emitted.find((event) => event.type === "approval.resolved");
    if (resolved === undefined || resolved.type !== "approval.resolved") {
      throw new Error("no approval.resolved event was emitted");
    }
    expect(resolved.payload.decision).toBe("accepted");
    expect(resolved.payload.approvalId).toBe(binding.approvalId);
    const questionRequested = emitted.find((event) => event.type === "question.requested");
    if (questionRequested === undefined || questionRequested.type !== "question.requested") {
      throw new Error("no question.requested event was emitted");
    }
    expect(typeof questionRequested.payload.spokenSummary).toBe("string");
  });

  test("question.answer with an optionId resolves the pending question and completes the turn", async () => {
    await post(promptCommand("99999999-9999-4999-8999-999999999999"));
    const binding = pendingBinding(await eventsAfter(0));

    await post({
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });

    const beforeAnswer = await eventsAfter(0);
    const question = pendingQuestion(beforeAnswer);
    expect(question.options.length).toBe(2);
    expect(question.allowFreeText).toBe(true);
    const before = beforeAnswer.length;

    const response = await post({
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sessionId: bridge.session.id,
      type: "question.answer",
      timestamp: new Date().toISOString(),
      payload: { questionId: question.questionId, optionId: question.options[0]?.id ?? "" },
    });
    expect(response.status).toBe(200);

    const emitted = await eventsAfter(before);
    const answered = emitted.find((event) => event.type === "question.answered");
    if (answered === undefined || answered.type !== "question.answered") {
      throw new Error("no question.answered event was emitted");
    }
    expect(answered.payload.questionId).toBe(question.questionId);
    const message = emitted.find((event) => event.type === "agent.message");
    if (message === undefined || message.type !== "agent.message") {
      throw new Error("no agent.message event was emitted");
    }
    expect(message.payload.role).toBe("assistant");
    expect(message.payload.final).toBe(true);
    expect(emitted.some((event) => event.type === "turn.completed")).toBe(true);
  });

  test("an approval whose binding no longer matches is refused with 409", async () => {
    await post(promptCommand("55555555-5555-4555-8555-555555555555"));
    const binding = pendingBinding(await eventsAfter(0));

    const response = await post({
      commandId: "66666666-6666-4666-8666-666666666666",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: { ...binding, actionDigest: "sha256:tampered" } },
    });

    expect(response.status).toBe(409);
  });

  test("session.create starts a session and reports its new id", async () => {
    const response = await post({
      commandId: "88888888-8888-4888-8888-888888888888",
      sessionId: "ses_placeholder",
      type: "session.create",
      timestamp: new Date().toISOString(),
      payload: { projectId: "prj_demo", provider: "mock" },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as CommandResponse;
    const newSessionId = body.sessionId;
    expect(body.accepted).toBe(true);
    if (newSessionId === undefined) {
      throw new Error("session.create did not report a session id");
    }
    expect(newSessionId).not.toBe("ses_placeholder");

    const started = (await eventsAfter(0)).filter((event) => event.type === "session.started");
    expect(started.length).toBe(1);
    const only = started[0];
    if (only === undefined || only.type !== "session.started") {
      throw new Error("no session.started event was emitted");
    }
    expect(only.sessionId).toBe(newSessionId);
    expect(only.payload.projectId).toBe("prj_demo");
    expect(only.payload.resumed).toBe(false);

    const listed = await bridge.fetch(new Request("http://bridge.local/v1/sessions"));
    const sessions = ((await listed.json()) as SessionsResponse).sessions.map((s) => s.id);
    expect(sessions).toContain(newSessionId);
    expect(sessions).toContain(bridge.session.id);
  });

  test("GET /v1/sessions lists the seeded session", async () => {
    const response = await bridge.fetch(new Request("http://bridge.local/v1/sessions"));
    const body = (await response.json()) as SessionsResponse;
    expect(body.sessions.map((session) => session.id)).toContain(bridge.session.id);
  });

  test("a prompt.send whose sessionId sits inside payload instead of the envelope is rejected", async () => {
    // Regression for the Swift decode stall: sessionId belongs on the envelope, not the
    // payload. The schema's additionalProperties: false on both levels must catch this.
    const malformed = {
      commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "run the tests", sessionId: bridge.session.id },
    };
    const response = await bridge.fetch(
      new Request("http://bridge.local/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(malformed),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_command");
    expect(await eventsAfter(0)).toEqual([]);
  });

  test("a command referencing an unknown sessionId is rejected", async () => {
    const response = await post({
      commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sessionId: "ses_does_not_exist",
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "run the tests" },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_command");
    expect(await eventsAfter(0)).toEqual([]);
  });

  test("cancelling an unknown session id is rejected with 404", async () => {
    const response = await bridge.fetch(
      new Request("http://bridge.local/v1/sessions/ses_does_not_exist/cancel", { method: "POST" }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unknown_session");
    expect(await eventsAfter(0)).toEqual([]);
  });
});

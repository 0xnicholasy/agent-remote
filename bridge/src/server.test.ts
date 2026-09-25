import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  AgentCapabilities,
  AgentEvent,
  AgentProvider,
  ApprovalBinding,
  Command,
  CommandResponse,
  EventsResponse,
  Project,
  ProviderHost,
  Session,
  SessionsResponse,
} from "@agentremote/protocol";
import { SessionLimitError, TurnInProgressError, UnknownSessionError } from "@agentremote/protocol";

import {
  assertAuthBypassAllowed,
  createBridge,
  projectIdFor,
  resolveBindHost,
  type Bridge,
  type CreateBridgeOptions,
} from "./server";
import { DeviceRegistry, type DeviceRecord } from "./auth/devices";
import { deriveDeviceKey, pairingProof } from "./auth/pairing";
import { signRequest } from "./auth/verify";

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

// Every bridge built without an explicit devicesFilePath resolves its state dir from the
// environment, and slice 2 made that dir hold durable journals (events, commands, nonces,
// sessions). Pointing it at a fresh temp dir per test keeps one test's persisted command ids
// from colliding with the next one's, and keeps the suite out of the real ~/.agentremote.
let testStateDir: string;
const originalStateDir = process.env.AGENTREMOTE_STATE_DIR;

beforeEach(() => {
  testStateDir = mkdtempSync(join(tmpdir(), "agentremote-bridge-test-"));
  process.env.AGENTREMOTE_STATE_DIR = testStateDir;
  bridge = createBridge({ authEnabled: false });
});

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.AGENTREMOTE_STATE_DIR;
  } else {
    process.env.AGENTREMOTE_STATE_DIR = originalStateDir;
  }
  rmSync(testStateDir, { recursive: true, force: true });
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

  test("a fresh bridge with no event history never reports a cursor as truncated", async () => {
    const response = await bridge.fetch(new Request("http://bridge.local/v1/events?after=0"));
    const body = (await response.json()) as EventsResponse;

    expect(body.firstEventId).toBe(0);
    expect(body.truncated).toBe(false);
  });

  test("two concurrent retries of one commandId execute it once and get the same outcome", async () => {
    const command = promptCommand("77777777-7777-4777-8777-777777777777");
    const [first, second] = await Promise.all([post(command), post(command)]);

    const bodies = (await Promise.all([first.json(), second.json()])) as CommandResponse[];
    // The retry that lands while the original is running waits for it and reports the original's
    // outcome, marked as a duplicate, instead of a placeholder that disagrees with it.
    expect(bodies.map((body) => body.accepted)).toEqual([true, true]);
    expect(bodies.filter((body) => body.duplicate).length).toBe(1);

    const events = await eventsAfter(0);
    expect(events.filter((event) => event.type === "turn.started").length).toBe(1);
  });

  test("a concurrent retry with the same commandId but a different body is a conflict", async () => {
    const command = promptCommand("78787878-7878-4878-8878-787878787878");
    const altered: Command = {
      commandId: command.commandId,
      sessionId: command.sessionId,
      type: "prompt.send",
      timestamp: command.timestamp,
      payload: { text: "something else entirely" },
    };
    const [first, second] = await Promise.all([post(command), post(altered)]);

    expect(first.status).toBe(200);
    expect(((await first.json()) as CommandResponse).accepted).toBe(true);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "command_id_conflict" });
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

  test("approval.accept on a desk-only approval is refused with 403 and the provider is never called", async () => {
    // "desk" in the prompt is MockProvider's scripted trigger for a desk-only card (see mock.ts).
    await post({
      commandId: "d0000000-0000-4000-8000-000000000001",
      sessionId: bridge.session.id,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "review this at the desk" },
    });
    const initialEvents = await eventsAfter(0);
    const requested = approvalRequested(initialEvents);
    expect(requested.titleFidelity).toBe("truncated");
    const binding = pendingBinding(initialEvents);
    const before = initialEvents.length;

    const response = await post({
      commandId: "d0000000-0000-4000-8000-000000000002",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "review_at_desk", interactionId: binding.approvalId });
    // No approval.resolved and no journal side effect: the provider was never invoked.
    const after = await eventsAfter(before);
    expect(after.some((event) => event.type === "approval.resolved")).toBe(false);
  });

  test("a desk-only approval past its expiresAt is refused with 410, not 403 review_at_desk", async () => {
    // "desk" in the prompt is MockProvider's scripted trigger for a desk-only card (see mock.ts).
    await post({
      commandId: "d0000000-0000-4000-8000-000000000005",
      sessionId: bridge.session.id,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "review this at the desk" },
    });
    const initialEvents = await eventsAfter(0);
    const requested = approvalRequested(initialEvents);
    expect(requested.titleFidelity).toBe("truncated");
    const binding = pendingBinding(initialEvents);
    const expired = { ...binding, expiresAt: new Date(Date.now() - 1000).toISOString() };

    const response = await post({
      commandId: "d0000000-0000-4000-8000-000000000006",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: expired },
    });

    // Expiry is checked before the desk-only gate, so a past-deadline desk-only approval reads
    // as expired, not as a desk-only refusal.
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "decision_expired" });
  });

  test("approval.reject still works on a desk-only approval", async () => {
    await post({
      commandId: "d0000000-0000-4000-8000-000000000003",
      sessionId: bridge.session.id,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "review this at the desk" },
    });
    const binding = pendingBinding(await eventsAfter(0));
    const before = (await eventsAfter(0)).length;

    const response = await post({
      commandId: "d0000000-0000-4000-8000-000000000004",
      sessionId: bridge.session.id,
      type: "approval.reject",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });

    expect(response.status).toBe(200);
    const emitted = await eventsAfter(before);
    const resolved = emitted.find((event) => event.type === "approval.resolved");
    if (resolved === undefined || resolved.type !== "approval.resolved") {
      throw new Error("no approval.resolved event was emitted");
    }
    expect(resolved.payload.decision).toBe("rejected");
  });

  test("prompt.send while an approval is pending is refused with 409 and emits no new turn.started", async () => {
    await post(promptCommand("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    const before = await eventsAfter(0);

    const response = await post(promptCommand("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("pending approval");

    const after = await eventsAfter(0);
    expect(after).toEqual(before);
    expect(after.filter((event) => event.type === "turn.started").length).toBe(1);
  });

  test("a second prompt.send succeeds once the session is cancelled", async () => {
    await post(promptCommand("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"));

    const cancelResponse = await bridge.fetch(
      new Request(`http://bridge.local/v1/sessions/${bridge.session.id}/cancel`, { method: "POST" }),
    );
    expect(cancelResponse.status).toBe(200);

    const response = await post(promptCommand("11111111-2222-4111-8111-111111111112"));
    expect(response.status).toBe(200);

    const events = await eventsAfter(0);
    expect(events.filter((event) => event.type === "turn.started").length).toBe(2);
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

/** A scripted stand-in for `ClaudeProvider`, wired through `createClaudeProvider` so these
 * tests exercise the AGENTREMOTE_PROVIDER=claude branch without spawning the real SDK
 * subprocess. */
class StubClaudeProvider implements AgentProvider {
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
  private readonly sessions = new Map<string, Session>();
  /** Set by a test to make the next sendPrompt call throw instead of emitting a reply. */
  sendPromptError: Error | undefined;
  /** Set by a test to make sendPrompt wait for this promise before resolving or throwing, so a
   * retry can be sent while the original is provably still in flight. */
  sendPromptGate: Promise<void> | undefined;
  /** Set by a test to make the next cancel call throw instead of resolving. */
  cancelError: Error | undefined;
  /** Set by a test to make the next createSession call throw instead of returning a session. */
  createSessionError: Error | undefined;
  /** Set by a test to make createSession wait for this promise before resolving or throwing, so a
   * retry can be sent while the original session.create is provably still in flight. */
  createSessionGate: Promise<void> | undefined;
  /** Incremented on every createSession call, so a test can assert a retry never caused a second
   * session to be created. */
  createSessionCallCount = 0;
  /** Set by a test to make the next listSessions call throw instead of returning sessions. */
  listSessionsError: Error | undefined;

  constructor(host: ProviderHost, options: { projects: Project[] }) {
    this.host = host;
    this.projects = options.projects;
  }

  seedSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  async listProjects(): Promise<Project[]> {
    return this.projects;
  }

  async listSessions(): Promise<Session[]> {
    if (this.listSessionsError !== undefined) {
      throw this.listSessionsError;
    }
    return [...this.sessions.values()];
  }

  async createSession(projectId: string): Promise<Session> {
    this.createSessionCallCount += 1;
    if (this.createSessionGate !== undefined) {
      await this.createSessionGate;
    }
    if (this.createSessionError !== undefined) {
      throw this.createSessionError;
    }
    const now = new Date().toISOString();
    const session: Session = {
      id: "ses_stub",
      projectId,
      provider: this.id,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      title: "stub",
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendPrompt(sessionId: string): Promise<void> {
    if (this.sendPromptGate !== undefined) {
      await this.sendPromptGate;
    }
    if (this.sendPromptError !== undefined) {
      throw this.sendPromptError;
    }
    this.host.emit(sessionId, "agent.message", {
      messageId: "msg_stub",
      role: "assistant",
      text: "stub reply",
      final: true,
    });
  }

  async approve(): Promise<void> {}
  async reject(): Promise<void> {}
  async cancel(): Promise<void> {
    if (this.cancelError !== undefined) {
      throw this.cancelError;
    }
  }
  async answerQuestion(): Promise<void> {}

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true as const, value: undefined }) };
      },
    };
  }
}

describe("AGENTREMOTE_PROVIDER selection", () => {
  const originalProvider = process.env.AGENTREMOTE_PROVIDER;

  // Every test in this file gets a `bridge` from the top-level beforeEach, pointed at the same
  // AGENTREMOTE_STATE_DIR this describe's own createBridge calls use by default. Close it first
  // so this describe's bridges do not collide with it on the single-writer lock.
  beforeEach(() => {
    bridge.close();
  });

  function restoreProviderEnv(): void {
    if (originalProvider === undefined) {
      delete process.env.AGENTREMOTE_PROVIDER;
    } else {
      process.env.AGENTREMOTE_PROVIDER = originalProvider;
    }
  }

  test("an unrecognized AGENTREMOTE_PROVIDER throws at startup instead of defaulting to mock", () => {
    process.env.AGENTREMOTE_PROVIDER = "claud"; // typo
    try {
      expect(() => createBridge()).toThrow(/invalid AGENTREMOTE_PROVIDER/);
    } finally {
      restoreProviderEnv();
    }
  });

  test("AGENTREMOTE_PROVIDER=claude wires the claude provider and tags events with provider.id", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
      };
      const claudeBridge = createBridge(options);
      expect(claudeBridge.session.provider).toBe("claude");
      expect(claudeBridge.provider.id).toBe("claude");

      const response = await claudeBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            sessionId: claudeBridge.session.id,
            type: "prompt.send",
            timestamp: new Date().toISOString(),
            payload: { text: "hello" },
          } satisfies Command),
        }),
      );
      expect(response.status).toBe(200);

      const eventsResponse = await claudeBridge.fetch(
        new Request("http://bridge.local/v1/events?after=0"),
      );
      const body = (await eventsResponse.json()) as EventsResponse;
      expect(body.events.length).toBeGreaterThan(0);
      for (const event of body.events) {
        expect(event.provider).toBe("claude");
      }
    } finally {
      restoreProviderEnv();
    }
  });

  test("a prompt sent while a turn is in progress is rejected with 409", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const stub = { current: undefined as StubClaudeProvider | undefined };
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => {
          stub.current = new StubClaudeProvider(host, providerOptions);
          return stub.current;
        },
      };
      const claudeBridge = createBridge(options);
      stub.current!.sendPromptError = new TurnInProgressError("turn already in progress");

      const response = await claudeBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            sessionId: claudeBridge.session.id,
            type: "prompt.send",
            timestamp: new Date().toISOString(),
            payload: { text: "hello" },
          } satisfies Command),
        }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("turn already in progress");
    } finally {
      restoreProviderEnv();
    }
  });

  test("a prompt sent against a session with no live conversation is rejected with 404", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const stub = { current: undefined as StubClaudeProvider | undefined };
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => {
          stub.current = new StubClaudeProvider(host, providerOptions);
          return stub.current;
        },
      };
      const claudeBridge = createBridge(options);
      stub.current!.sendPromptError = new UnknownSessionError("unknown session: " + claudeBridge.session.id);

      const response = await claudeBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            sessionId: claudeBridge.session.id,
            type: "prompt.send",
            timestamp: new Date().toISOString(),
            payload: { text: "hello" },
          } satisfies Command),
        }),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("unknown session: " + claudeBridge.session.id);
    } finally {
      restoreProviderEnv();
    }
  });

  test("a cancel that races the session disappearing after sessionExists is rejected with 404", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const stub = { current: undefined as StubClaudeProvider | undefined };
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => {
          stub.current = new StubClaudeProvider(host, providerOptions);
          return stub.current;
        },
      };
      const claudeBridge = createBridge(options);
      stub.current!.cancelError = new UnknownSessionError("unknown session: " + claudeBridge.session.id);

      const response = await claudeBridge.fetch(
        new Request(`http://bridge.local/v1/sessions/${claudeBridge.session.id}/cancel`, { method: "POST" }),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("unknown session: " + claudeBridge.session.id);
    } finally {
      restoreProviderEnv();
    }
  });

  test("session.create with an unknown projectId is rejected with 400", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
      };
      const claudeBridge = createBridge(options);

      const response = await claudeBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccd",
            sessionId: "ses_placeholder",
            type: "session.create",
            timestamp: new Date().toISOString(),
            payload: { projectId: "prj_does_not_exist", provider: "claude" },
          } satisfies Command),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_command");
    } finally {
      restoreProviderEnv();
    }
  });

  test("session.create past the provider's session limit is rejected with 429 (R-042)", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const stub = { current: undefined as StubClaudeProvider | undefined };
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => {
          stub.current = new StubClaudeProvider(host, providerOptions);
          return stub.current;
        },
      };
      const claudeBridge = createBridge(options);
      stub.current!.createSessionError = new SessionLimitError("session limit reached");

      const response = await claudeBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "cccccccc-cccc-4ccc-8ccc-ccccccccccce",
            sessionId: "ses_placeholder",
            type: "session.create",
            timestamp: new Date().toISOString(),
            payload: { projectId: claudeBridge.session.projectId, provider: "claude" },
          } satisfies Command),
        }),
      );
      // 429, not 409/400: nothing about the request is wrong, the host is at capacity.
      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: string; code: string };
      expect(body.code).toBe("session_limit");
      expect(body.error).toBe("session limit reached");
    } finally {
      restoreProviderEnv();
    }
  });

  test("R-011: a concurrent retry of session.create waits for the in-flight original instead of creating a second session", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    let releaseGate: () => void = () => {};
    try {
      const stub = { current: undefined as StubClaudeProvider | undefined };
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => {
          stub.current = new StubClaudeProvider(host, providerOptions);
          return stub.current;
        },
      };
      const claudeBridge = createBridge(options);
      stub.current!.createSessionGate = new Promise((resolve) => {
        releaseGate = resolve;
      });

      const command: Command = {
        commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sessionId: "ses_placeholder",
        type: "session.create",
        timestamp: new Date().toISOString(),
        payload: { projectId: claudeBridge.session.projectId, provider: "claude" },
      };
      const send = () =>
        claudeBridge.fetch(
          new Request("http://bridge.local/v1/commands", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(command),
          }),
        );

      const originalPromise = send();
      // Give the original's execution a chance to register itself as in-flight and block on the
      // gate before the retry is sent, so the retry provably observes it still running.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const retryPromise = send();
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseGate();

      const [original, retry] = await Promise.all([originalPromise, retryPromise]);
      expect(original.status).toBe(200);
      expect(retry.status).toBe(200);
      const originalBody = (await original.json()) as CommandResponse;
      const retryBody = (await retry.json()) as CommandResponse;
      expect(originalBody.accepted).toBe(true);
      expect(retryBody.accepted).toBe(true);
      // The retry waited for and reports the original's outcome, marked as a duplicate, instead
      // of racing the provider into creating a second session.
      expect(originalBody.duplicate).toBe(false);
      expect(retryBody.duplicate).toBe(true);
      expect(retryBody.sessionId).toBe(originalBody.sessionId);
      expect(stub.current!.createSessionCallCount).toBe(1);
    } finally {
      // Release unconditionally so a failure above can never leave the gated createSession call
      // (and this test) hanging.
      releaseGate();
      restoreProviderEnv();
    }
  });

  test("C1-002: an unmapped provider error on GET /v1/sessions returns a generic 500 with no leaked detail", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    try {
      const stub = { current: undefined as StubClaudeProvider | undefined };
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => {
          stub.current = new StubClaudeProvider(host, providerOptions);
          return stub.current;
        },
      };
      const claudeBridge = createBridge(options);
      const distinctiveMessage = "boom: unexpected stub failure at /secret/path";
      stub.current!.listSessionsError = new Error(distinctiveMessage);

      const response = await claudeBridge.fetch(new Request("http://bridge.local/v1/sessions"));

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain(distinctiveMessage);
      expect(JSON.parse(text)).toEqual({ error: "internal" });
    } finally {
      restoreProviderEnv();
    }
  });
});

describe("indeterminate commands", () => {
  const originalProvider = process.env.AGENTREMOTE_PROVIDER;

  // See the matching comment in "AGENTREMOTE_PROVIDER selection" above.
  beforeEach(() => {
    bridge.close();
  });

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.AGENTREMOTE_PROVIDER;
    } else {
      process.env.AGENTREMOTE_PROVIDER = originalProvider;
    }
  });

  test("a command whose provider call threw an unmapped error is not replayed on retry", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    const stub = { current: undefined as StubClaudeProvider | undefined };
    const claudeBridge = createBridge({
      authEnabled: false,
      createClaudeProvider: (host, providerOptions) => {
        stub.current = new StubClaudeProvider(host, providerOptions);
        return stub.current;
      },
    });
    stub.current!.sendPromptError = new Error("boom: unexpected stub failure");

    const command: Command = {
      commandId: "b1111111-1111-4111-8111-111111111111",
      sessionId: claudeBridge.session.id,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "run the tests and push" },
    };
    const request = (): Request =>
      new Request("http://bridge.local/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });

    const first = await claudeBridge.fetch(request());
    expect(first.status).toBe(500);

    // The side effect may or may not have landed, so the retry must be refused rather than
    // executed a second time - even without a restart in between.
    stub.current!.sendPromptError = undefined;
    const retry = await claudeBridge.fetch(request());
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "command_indeterminate", commandId: command.commandId });
  });

  test("a concurrent retry waiting on an original that throws gets 409 command_indeterminate and the original gets 500", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord({ allowedProjects: [projectIdFor(process.cwd())] }));
    const stub = { current: undefined as StubClaudeProvider | undefined };
    const claudeBridge = createBridge({
      registry,
      now: () => FIXED_NOW,
      createClaudeProvider: (host, providerOptions) => {
        stub.current = new StubClaudeProvider(host, providerOptions);
        return stub.current;
      },
    });
    let releaseGate: () => void = () => {};
    stub.current!.sendPromptGate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    stub.current!.sendPromptError = new Error("boom: unexpected stub failure");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const command: Command = {
      commandId: "c1111111-1111-4111-8111-111111111111",
      sessionId: claudeBridge.session.id,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: "run the tests and push" },
    };

    try {
      const originalPromise = claudeBridge.fetch(
        signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body: command }),
      );
      // Give the original's execution a chance to register itself as in-flight and block on the
      // gate before the retry is sent, so the retry provably observes it still running.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const retryPromise = claudeBridge.fetch(
        signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body: command, nonce: "retry-nonce" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseGate();

      const [original, retry] = await Promise.all([originalPromise, retryPromise]);
      expect(original.status).toBe(500);
      expect(await original.json()).toEqual({ error: "internal" });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toEqual({ error: "command_indeterminate", commandId: command.commandId });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a concurrent retry signed by a different device while the original is in flight is a conflict", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    const registry = new DeviceRegistry();
    const allowedProjects = [projectIdFor(process.cwd())];
    registry.register(sampleDeviceRecord({ allowedProjects }));
    const deviceId2 = "dev_2222222222222222";
    const deviceKey2 = Buffer.from("ee".repeat(32), "hex");
    registry.register(
      sampleDeviceRecord({
        deviceId: deviceId2,
        deviceKeyHex: deviceKey2.toString("hex"),
        keyId: "key_second",
        allowedProjects,
      }),
    );
    const stub = { current: undefined as StubClaudeProvider | undefined };
    const claudeBridge = createBridge({
      registry,
      now: () => FIXED_NOW,
      createClaudeProvider: (host, providerOptions) => {
        stub.current = new StubClaudeProvider(host, providerOptions);
        return stub.current;
      },
    });
    let releaseGate: () => void = () => {};
    stub.current!.sendPromptGate = new Promise((resolve) => {
      releaseGate = resolve;
    });

    const command: Command = {
      commandId: "c2222222-2222-4222-8222-222222222222",
      sessionId: claudeBridge.session.id,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: "run the tests and push" },
    };

    const originalPromise = claudeBridge.fetch(
      signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body: command }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const retryResponse = await claudeBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: command,
        deviceId: deviceId2,
        deviceKey: deviceKey2,
      }),
    );
    expect(retryResponse.status).toBe(409);
    expect(await retryResponse.json()).toEqual({ error: "command_id_conflict" });

    releaseGate();
    const original = await originalPromise;
    expect(original.status).toBe(200);
    expect(((await original.json()) as CommandResponse).accepted).toBe(true);
  });

  test("a concurrent retry waiting on an original that resolves to a mapped non-accepted response gets the same status and body", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord({ allowedProjects: [projectIdFor(process.cwd())] }));
    const stub = { current: undefined as StubClaudeProvider | undefined };
    const claudeBridge = createBridge({
      registry,
      now: () => FIXED_NOW,
      createClaudeProvider: (host, providerOptions) => {
        stub.current = new StubClaudeProvider(host, providerOptions);
        return stub.current;
      },
    });
    let releaseGate: () => void = () => {};
    stub.current!.sendPromptGate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    stub.current!.sendPromptError = new TurnInProgressError("turn already in progress");

    const command: Command = {
      commandId: "c3333333-3333-4333-8333-333333333333",
      sessionId: claudeBridge.session.id,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: "run the tests and push" },
    };

    const originalPromise = claudeBridge.fetch(
      signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body: command }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const retryPromise = claudeBridge.fetch(
      signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body: command, nonce: "retry-nonce" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseGate();

    const [original, retry] = await Promise.all([originalPromise, retryPromise]);
    expect(original.status).toBe(409);
    const originalBody = (await original.json()) as { error: string };
    expect(originalBody.error).toBe("turn already in progress");

    expect(retry.status).toBe(409);
    const retryBody = await retry.json();
    expect(retryBody).toEqual(originalBody);
    expect((retryBody as { duplicate?: boolean }).duplicate).toBeUndefined();
  });
});

describe("projectIdFor", () => {
  test("produces a prj_<slug>_<hex> id built from the directory's basename and a path digest", () => {
    const id = projectIdFor("/Users/dev/checkouts/watch-2-code");
    expect(id).toMatch(/^prj_watch-2-code_[0-9a-f]{8}$/);
  });

  test("two directories sharing a basename get different ids", () => {
    const first = projectIdFor("/Users/dev/one/app");
    const second = projectIdFor("/Users/dev/two/app");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^prj_app_[0-9a-f]{8}$/);
    expect(second).toMatch(/^prj_app_[0-9a-f]{8}$/);
  });
});

describe("AGENTREMOTE_PROJECT_DIRS parsing", () => {
  const originalProvider = process.env.AGENTREMOTE_PROVIDER;
  const originalDirs = process.env.AGENTREMOTE_PROJECT_DIRS;

  // See the matching comment in "AGENTREMOTE_PROVIDER selection" above.
  beforeEach(() => {
    bridge.close();
  });

  function restoreEnv(): void {
    if (originalProvider === undefined) {
      delete process.env.AGENTREMOTE_PROVIDER;
    } else {
      process.env.AGENTREMOTE_PROVIDER = originalProvider;
    }
    if (originalDirs === undefined) {
      delete process.env.AGENTREMOTE_PROJECT_DIRS;
    } else {
      process.env.AGENTREMOTE_PROJECT_DIRS = originalDirs;
    }
  }

  test("comma-separated dirs with surrounding spaces and blank entries are trimmed and registered", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    process.env.AGENTREMOTE_PROJECT_DIRS = " /repos/one , , /repos/two ,";
    try {
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
      };
      const claudeBridge = createBridge(options);
      const projectsResponse = await claudeBridge.fetch(new Request("http://bridge.local/v1/projects"));
      const projects = ((await projectsResponse.json()) as { projects: Project[] }).projects;
      expect(projects.map((project) => project.path)).toEqual(["/repos/one", "/repos/two"]);
      expect(projects.map((project) => project.id)).toEqual([projectIdFor("/repos/one"), projectIdFor("/repos/two")]);
    } finally {
      restoreEnv();
    }
  });

  test("a blank AGENTREMOTE_PROJECT_DIRS falls back to cwd instead of leaving projects empty", () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    process.env.AGENTREMOTE_PROJECT_DIRS = "   ";
    try {
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
      };
      let claudeBridge: Bridge | undefined;
      expect(() => {
        claudeBridge = createBridge(options);
      }).not.toThrow();
      expect(claudeBridge!.session.projectId).toBe(projectIdFor(process.cwd()));
    } finally {
      restoreEnv();
    }
  });

  test("an all-delimiter AGENTREMOTE_PROJECT_DIRS behaves like unset and lists exactly the cwd project", async () => {
    process.env.AGENTREMOTE_PROVIDER = "claude";
    process.env.AGENTREMOTE_PROJECT_DIRS = ",, ,";
    try {
      const options: CreateBridgeOptions = {
        authEnabled: false,
        createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
      };
      let claudeBridge: Bridge | undefined;
      expect(() => {
        claudeBridge = createBridge(options);
      }).not.toThrow();
      expect(claudeBridge!.session.projectId).toBe(projectIdFor(process.cwd()));
      const projectsResponse = await claudeBridge!.fetch(new Request("http://bridge.local/v1/projects"));
      const projects = ((await projectsResponse.json()) as { projects: Project[] }).projects;
      expect(projects.map((project) => project.path)).toEqual([process.cwd()]);
    } finally {
      restoreEnv();
    }
  });
});

describe("resolveBindHost", () => {
  test("defaults the claude provider to loopback when AGENTREMOTE_HOST is unset", () => {
    expect(resolveBindHost("claude", undefined)).toEqual({ hostname: "127.0.0.1", warnNoAuth: false });
  });

  test("leaves the mock provider on Bun's own default when AGENTREMOTE_HOST is unset", () => {
    expect(resolveBindHost("mock", undefined)).toEqual({ hostname: undefined, warnNoAuth: false });
  });

  test("an explicit non-loopback AGENTREMOTE_HOST with the claude provider warns", () => {
    expect(resolveBindHost("claude", "0.0.0.0")).toEqual({ hostname: "0.0.0.0", warnNoAuth: true });
  });

  test("an explicit loopback AGENTREMOTE_HOST never warns", () => {
    expect(resolveBindHost("claude", "127.0.0.1")).toEqual({ hostname: "127.0.0.1", warnNoAuth: false });
  });
});

describe("assertAuthBypassAllowed", () => {
  test("refuses AGENTREMOTE_AUTH=off with the claude provider bound to a non-loopback host", () => {
    expect(() =>
      assertAuthBypassAllowed({ authEnabled: false, providerId: "claude", hostname: "0.0.0.0" }),
    ).toThrow(/AGENTREMOTE_AUTH=off refuses to start/);
  });

  test("permits AGENTREMOTE_AUTH=off with the claude provider bound to loopback", () => {
    expect(() =>
      assertAuthBypassAllowed({ authEnabled: false, providerId: "claude", hostname: "127.0.0.1" }),
    ).not.toThrow();
  });

  test("permits AGENTREMOTE_AUTH=off with the mock provider bound to a non-loopback host: the gate is claude-only", () => {
    // The mock provider is exempt by design: it serves fixed demo data (a constant fake cwd,
    // prj_demo/ses_seed) and executes nothing on the host, so an unauthenticated non-loopback
    // mock bridge exposes no real data.
    expect(() =>
      assertAuthBypassAllowed({ authEnabled: false, providerId: "mock", hostname: "0.0.0.0" }),
    ).not.toThrow();
  });

  test("permits when auth is enabled regardless of provider or hostname", () => {
    expect(() =>
      assertAuthBypassAllowed({ authEnabled: true, providerId: "claude", hostname: "0.0.0.0" }),
    ).not.toThrow();
  });
});

const FIXED_NOW = new Date("2026-09-20T10:15:00.000Z");
const DEVICE_ID = "dev_9f2c4a1b7d3e5061";
const DEVICE_KEY = Buffer.from("cc".repeat(32), "hex");
const ALL_ACTIONS = [
  "prompt.send",
  "approval.accept",
  "approval.reject",
  "session.cancel",
  "question.answer",
  "session.create",
];

function sampleDeviceRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: DEVICE_ID,
    deviceName: "Test Watch",
    keyId: "key_deadbeef",
    deviceKeyHex: DEVICE_KEY.toString("hex"),
    pairedAt: FIXED_NOW.toISOString(),
    allowedProjects: ["prj_demo"],
    allowedActions: ALL_ACTIONS,
    revokedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

/** Builds a fully signed request against the six-line envelope from docs/pairing-v0.md. */
function signedRequest(params: {
  method: string;
  pathWithQuery: string;
  body?: unknown;
  deviceId?: string;
  deviceKey?: Buffer;
  timestamp?: string;
  nonce?: string;
}): Request {
  const rawBody = params.body === undefined ? "" : JSON.stringify(params.body);
  const timestamp = params.timestamp ?? FIXED_NOW.toISOString();
  const nonce = params.nonce ?? randomBytes(16).toString("hex");
  const deviceId = params.deviceId ?? DEVICE_ID;
  const deviceKey = params.deviceKey ?? DEVICE_KEY;
  const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
  const signature = signRequest(deviceKey, {
    method: params.method,
    pathWithQuery: params.pathWithQuery,
    timestamp,
    nonce,
    bodySha256,
  });
  return new Request(`http://bridge.local${params.pathWithQuery}`, {
    method: params.method,
    headers: {
      "content-type": "application/json",
      "X-AgentRemote-Device": deviceId,
      "X-AgentRemote-Timestamp": timestamp,
      "X-AgentRemote-Nonce": nonce,
      "X-AgentRemote-Signature": signature,
    },
    ...(rawBody.length > 0 ? { body: rawBody } : {}),
  });
}

describe("signed request envelope and command authorization", () => {
  test("an unsigned request is rejected with 401 unauthenticated", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(new Request("http://bridge.local/v1/sessions"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  test("a revoked device is rejected with 403 device_revoked", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    registry.revoke(DEVICE_ID, FIXED_NOW);
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/sessions" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "device_revoked" });
  });

  test("a timestamp outside the skew window is rejected with 401 stale_request", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const staleTimestamp = new Date(FIXED_NOW.getTime() - 200_000).toISOString();
    const response = await authedBridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", timestamp: staleTimestamp }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "stale_request" });
  });

  test("a replayed nonce is rejected with 401 replayed_request", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });
    const nonce = randomBytes(16).toString("hex");

    const first = await authedBridge.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", nonce }));
    expect(first.status).toBe(200);

    const second = await authedBridge.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", nonce }));
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: "replayed_request" });
  });

  test("a tampered body fails the signature with 401 unauthenticated", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const commandId = "f0000000-0000-4000-8000-000000000001";
    const originalBody = {
      commandId,
      sessionId: authedBridge.session.id,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: "original" },
    } satisfies Command;
    const timestamp = FIXED_NOW.toISOString();
    const nonce = randomBytes(16).toString("hex");
    const bodySha256 = createHash("sha256").update(JSON.stringify(originalBody)).digest("hex");
    const signature = signRequest(DEVICE_KEY, {
      method: "POST",
      pathWithQuery: "/v1/commands",
      timestamp,
      nonce,
      bodySha256,
    });
    const tamperedBody = { ...originalBody, payload: { text: "tampered" } };

    const response = await authedBridge.fetch(
      new Request("http://bridge.local/v1/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-AgentRemote-Device": DEVICE_ID,
          "X-AgentRemote-Timestamp": timestamp,
          "X-AgentRemote-Nonce": nonce,
          "X-AgentRemote-Signature": signature,
        },
        body: JSON.stringify(tamperedBody),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  test("GET /v1/health needs no signature", async () => {
    const registry = new DeviceRegistry();
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(new Request("http://bridge.local/v1/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, bridgeId: authedBridge.bridgeId });
  });

  test("an action outside allowedActions is rejected with 403 action_not_allowed", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord({ allowedActions: ["session.cancel"] }));
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId: "f0000000-0000-4000-8000-000000000002",
          sessionId: authedBridge.session.id,
          type: "prompt.send",
          timestamp: FIXED_NOW.toISOString(),
          payload: { text: "hi" },
        } satisfies Command,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "action_not_allowed" });
  });

  test("a project outside allowedProjects is rejected with 403 project_not_allowed", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord({ allowedProjects: ["prj_other"] }));
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId: "f0000000-0000-4000-8000-000000000003",
          sessionId: authedBridge.session.id,
          type: "prompt.send",
          timestamp: FIXED_NOW.toISOString(),
          payload: { text: "hi" },
        } satisfies Command,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "project_not_allowed" });
  });

  test("an approval binding whose expiresAt has passed is rejected with 410 and never reaches the provider", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const binding: ApprovalBinding = {
      approvalId: "apr_1",
      sessionId: authedBridge.session.id,
      turnId: "turn_1",
      toolCallId: "tool_1",
      actionDigest: "sha256:whatever",
      expiresAt: new Date(FIXED_NOW.getTime() - 1000).toISOString(),
    };
    const response = await authedBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId: "f0000000-0000-4000-8000-000000000004",
          sessionId: authedBridge.session.id,
          type: "approval.accept",
          timestamp: FIXED_NOW.toISOString(),
          payload: { binding },
        } satisfies Command,
      }),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "decision_expired" });
  });

  test("a repeat commandId with a different body is rejected with 409 command_id_conflict", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });
    const commandId = "f0000000-0000-4000-8000-000000000005";

    const first = await authedBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId,
          sessionId: authedBridge.session.id,
          type: "prompt.send",
          timestamp: FIXED_NOW.toISOString(),
          payload: { text: "first" },
        } satisfies Command,
      }),
    );
    expect(first.status).toBe(200);

    const second = await authedBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId,
          sessionId: authedBridge.session.id,
          type: "prompt.send",
          timestamp: FIXED_NOW.toISOString(),
          payload: { text: "second" },
        } satisfies Command,
      }),
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "command_id_conflict" });
  });

  test("a repeat commandId with the same body still replays", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });
    const commandId = "f0000000-0000-4000-8000-000000000006";
    const body = {
      commandId,
      sessionId: authedBridge.session.id,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: "same" },
    } satisfies Command;

    const first = await authedBridge.fetch(signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as CommandResponse;
    expect(firstBody.duplicate).toBe(false);

    const second = await authedBridge.fetch(signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body }));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as CommandResponse;
    expect(secondBody.duplicate).toBe(true);
  });
});

describe("cancel route authorization", () => {
  test("a device without session.cancel in allowedActions is rejected with 403 action_not_allowed", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord({ allowedActions: ["prompt.send"] }));
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(
      signedRequest({ method: "POST", pathWithQuery: `/v1/sessions/${authedBridge.session.id}/cancel` }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "action_not_allowed" });
  });

  test("a device not allowed the session's project is rejected with 403 project_not_allowed", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord({ allowedProjects: ["prj_other"] }));
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(
      signedRequest({ method: "POST", pathWithQuery: `/v1/sessions/${authedBridge.session.id}/cancel` }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "project_not_allowed" });
  });

  test("a fully allowed device can still cancel", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await authedBridge.fetch(
      signedRequest({ method: "POST", pathWithQuery: `/v1/sessions/${authedBridge.session.id}/cancel` }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true, sessionId: authedBridge.session.id });
  });
});

describe("allowedProjects filtering on GET /v1/sessions and /v1/events", () => {
  test("GET /v1/sessions hides a session in a project the device is not allowed", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord()); // allowedProjects: ["prj_demo"], per the default above.
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });
    // Bypasses the /v1/commands schema check (which would reject an unknown projectId) to seed
    // a session in a project the device is not allowed, exercising the registry's existing
    // per-device narrowing directly against the provider.
    const otherSession = await authedBridge.provider.createSession("prj_other");

    const response = await authedBridge.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/sessions" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionsResponse;
    const ids = body.sessions.map((session) => session.id);
    expect(ids).toContain(authedBridge.session.id);
    expect(ids).not.toContain(otherSession.id);
  });

  test("GET /v1/events hides events from a disallowed project while lastEventId stays the global maximum", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord()); // allowedProjects: ["prj_demo"].
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });
    const otherSession = await authedBridge.provider.createSession("prj_other");

    const response = await authedBridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/events?after=0" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as EventsResponse;
    expect(body.events.some((event) => event.sessionId === otherSession.id)).toBe(false);
    // createSession emitted one session.started event for otherSession, so the true global
    // maximum is 1 even though every visible event for this device was filtered out.
    expect(body.lastEventId).toBe(1);
  });
});

describe("pairing", () => {
  let stateDir: string;
  let devicesFilePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "agentremote-pair-test-"));
    devicesFilePath = join(stateDir, "devices.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("a successful pairing followed by a signed command succeeds", async () => {
    const pairBridge = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const deviceId = "dev_aaaaaaaaaaaaaaaa";
    const deviceName = "Ting's Apple Watch";
    const nonce = randomBytes(16).toString("hex");
    const proof = pairingProof(pairBridge.pairingCode, deviceId, deviceName, nonce);

    const pairResponse = await pairBridge.fetch(
      new Request("http://bridge.local/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, deviceName, nonce, proof }),
      }),
    );
    expect(pairResponse.status).toBe(200);
    const pairBody = (await pairResponse.json()) as {
      deviceId: string;
      keyId: string;
      pairedAt: string;
      bridgeId: string;
      allowedProjects: string[];
      allowedActions: string[];
    };
    expect(pairBody.deviceId).toBe(deviceId);
    expect(pairBody.bridgeId).toBe(pairBridge.bridgeId);
    expect(pairBody.allowedProjects).toEqual(["prj_demo"]);
    expect(pairBody.allowedActions).toContain("prompt.send");

    const deviceKey = deriveDeviceKey(pairBridge.pairingCode, deviceId, nonce);
    const response = await pairBridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", deviceId, deviceKey }),
    );
    expect(response.status).toBe(200);
  });

  test("a wrong pairing code is rejected with 401 pairing_rejected", async () => {
    const pairBridge = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const deviceId = "dev_bbbbbbbbbbbbbbbb";
    const nonce = randomBytes(16).toString("hex");
    const proof = pairingProof("WRONGWRONGWR", deviceId, "Watch", nonce);

    const response = await pairBridge.fetch(
      new Request("http://bridge.local/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, deviceName: "Watch", nonce, proof }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "pairing_rejected" });
  });

  test("a malformed JSON body is rejected with 401 pairing_rejected and enrolls no device", async () => {
    const registry = new DeviceRegistry(devicesFilePath);
    const pairBridge = createBridge({ registry, now: () => FIXED_NOW });

    const response = await pairBridge.fetch(
      new Request("http://bridge.local/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "pairing_rejected" });
    expect(registry.list()).toEqual([]);
  });

  test("valid JSON missing/ill-typed required fields is rejected with 401 pairing_rejected and enrolls no device", async () => {
    const registry = new DeviceRegistry(devicesFilePath);
    const pairBridge = createBridge({ registry, now: () => FIXED_NOW });

    // Well-formed JSON, but `nonce` is missing and `proof` is a number rather than a string.
    const response = await pairBridge.fetch(
      new Request("http://bridge.local/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "dev_eeeeeeeeeeeeeeee", deviceName: "Watch", proof: 12345 }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "pairing_rejected" });
    expect(registry.list()).toEqual([]);
  });

  test("pairing survives a new createBridge over the same devices file", async () => {
    const firstBridge = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const deviceId = "dev_cccccccccccccccc";
    const deviceName = "Watch";
    const nonce = randomBytes(16).toString("hex");
    const proof = pairingProof(firstBridge.pairingCode, deviceId, deviceName, nonce);

    const pairResponse = await firstBridge.fetch(
      new Request("http://bridge.local/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, deviceName, nonce, proof }),
      }),
    );
    expect(pairResponse.status).toBe(200);
    const deviceKey = deriveDeviceKey(firstBridge.pairingCode, deviceId, nonce);

    firstBridge.close();
    const secondBridge = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const response = await secondBridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", deviceId, deviceKey }),
    );
    expect(response.status).toBe(200);
    expect(secondBridge.bridgeId).toBe(firstBridge.bridgeId);
  });

  // Regression test for the live bug: AGENTREMOTE_REVOKE runs as a separate one-shot process
  // that writes devices.json directly. A running bridge must notice that write on its next
  // request rather than needing a restart, since restarting kills every live session.
  test("a device revoked by a separate DeviceRegistry over the same file is rejected without a bridge restart", async () => {
    const bridge = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const deviceId = "dev_dddddddddddddddd";
    const deviceName = "Watch";
    const nonce = randomBytes(16).toString("hex");
    const proof = pairingProof(bridge.pairingCode, deviceId, deviceName, nonce);

    const pairResponse = await bridge.fetch(
      new Request("http://bridge.local/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, deviceName, nonce, proof }),
      }),
    );
    expect(pairResponse.status).toBe(200);
    const deviceKey = deriveDeviceKey(bridge.pairingCode, deviceId, nonce);

    const beforeRevoke = await bridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", deviceId, deviceKey }),
    );
    expect(beforeRevoke.status).toBe(200);

    // Stands in for the `AGENTREMOTE_REVOKE=<deviceId>` operator command: a separate registry
    // instance over the same file, with no reference to `bridge` at all.
    const operatorRegistry = DeviceRegistry.load(devicesFilePath);
    operatorRegistry.revoke(deviceId, FIXED_NOW);

    const afterRevoke = await bridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", deviceId, deviceKey }),
    );
    expect(afterRevoke.status).toBe(403);
    expect(await afterRevoke.json()).toEqual({ error: "device_revoked" });
  });
});

describe("interaction lifecycle", () => {
  async function createSecondSession(): Promise<string> {
    const response = await post({
      commandId: "b0000000-0000-4000-8000-000000000001",
      sessionId: "ses_placeholder",
      type: "session.create",
      timestamp: new Date().toISOString(),
      payload: { projectId: "prj_demo", provider: "mock" },
    });
    const body = (await response.json()) as CommandResponse;
    if (body.sessionId === undefined) {
      throw new Error("session.create did not report a session id");
    }
    return body.sessionId;
  }

  function promptCommandFor(sessionId: string, commandId: string): Command {
    return {
      commandId,
      sessionId,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "run the tests and push" },
    };
  }

  async function eventsFor(sessionId: string): Promise<AgentEvent[]> {
    return (await eventsAfter(0)).filter((event) => event.sessionId === sessionId);
  }

  test("question.answer for session A with session B's questionId is refused, and B's question is still answerable", async () => {
    const sessionB = await createSecondSession();
    await post(promptCommandFor(bridge.session.id, "b0000000-0000-4000-8000-000000000002"));
    await post(promptCommandFor(sessionB, "b0000000-0000-4000-8000-000000000003"));

    await post({
      commandId: "b0000000-0000-4000-8000-000000000004",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: pendingBinding(await eventsFor(bridge.session.id)) },
    });
    await post({
      commandId: "b0000000-0000-4000-8000-000000000005",
      sessionId: sessionB,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: pendingBinding(await eventsFor(sessionB)) },
    });

    const questionB = pendingQuestion(await eventsFor(sessionB));

    const crossSession = await post({
      commandId: "b0000000-0000-4000-8000-000000000006",
      sessionId: bridge.session.id,
      type: "question.answer",
      timestamp: new Date().toISOString(),
      payload: { questionId: questionB.questionId, optionId: "opt_yes" },
    });
    expect(crossSession.status).toBe(409);
    expect(await crossSession.json()).toEqual({
      error: "interaction_not_pending",
      interactionId: questionB.questionId,
      state: "not_found",
    });

    const stillAnswerable = await post({
      commandId: "b0000000-0000-4000-8000-000000000007",
      sessionId: sessionB,
      type: "question.answer",
      timestamp: new Date().toISOString(),
      payload: { questionId: questionB.questionId, optionId: "opt_yes" },
    });
    expect(stillAnswerable.status).toBe(200);
  });

  test("approval.accept with another session's approvalId is refused, and that approval stays pending", async () => {
    const sessionB = await createSecondSession();
    await post(promptCommandFor(bridge.session.id, "b0000000-0000-4000-8000-000000000008"));
    await post(promptCommandFor(sessionB, "b0000000-0000-4000-8000-000000000009"));

    const bindingB = pendingBinding(await eventsFor(sessionB));

    const crossSession = await post({
      commandId: "b0000000-0000-4000-8000-00000000000a",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: bindingB },
    });
    expect(crossSession.status).toBe(409);
    expect(await crossSession.json()).toEqual({
      error: "interaction_not_pending",
      interactionId: bindingB.approvalId,
      state: "not_found",
    });

    const stillPending = await post({
      commandId: "b0000000-0000-4000-8000-00000000000b",
      sessionId: sessionB,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: bindingB },
    });
    expect(stillPending.status).toBe(200);
  });

  test("session.cancel on A leaves B's pending approval intact and refuses a later decision on A's own", async () => {
    const sessionB = await createSecondSession();
    await post(promptCommandFor(bridge.session.id, "b0000000-0000-4000-8000-00000000000c"));
    await post(promptCommandFor(sessionB, "b0000000-0000-4000-8000-00000000000d"));

    const bindingA = pendingBinding(await eventsFor(bridge.session.id));
    const bindingB = pendingBinding(await eventsFor(sessionB));

    const cancelResponse = await post({
      commandId: "b0000000-0000-4000-8000-00000000000e",
      sessionId: bridge.session.id,
      type: "session.cancel",
      timestamp: new Date().toISOString(),
      payload: {},
    });
    expect(cancelResponse.status).toBe(200);

    const decideB = await post({
      commandId: "b0000000-0000-4000-8000-00000000000f",
      sessionId: sessionB,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: bindingB },
    });
    expect(decideB.status).toBe(200);

    const decideA = await post({
      commandId: "b0000000-0000-4000-8000-000000000010",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: bindingA },
    });
    expect(decideA.status).toBe(409);
    expect(await decideA.json()).toEqual({
      error: "interaction_not_pending",
      interactionId: bindingA.approvalId,
      state: "cancelled",
    });
  });

  test("a decision past its expiry is refused with 410 even when auth is off", async () => {
    await post(promptCommand("b0000000-0000-4000-8000-000000000011"));
    const binding = pendingBinding(await eventsAfter(0));
    const expired = { ...binding, expiresAt: new Date(Date.now() - 1000).toISOString() };

    const response = await post({
      commandId: "b0000000-0000-4000-8000-000000000012",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding: expired },
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "decision_expired" });
  });

  test("two devices racing to decide the same approval: exactly one succeeds, the loser is told it is already resolved", async () => {
    const registry = new DeviceRegistry();
    registry.register(sampleDeviceRecord());
    const deviceId2 = "dev_1111111111111111";
    const deviceKey2 = Buffer.from("dd".repeat(32), "hex");
    registry.register(
      sampleDeviceRecord({ deviceId: deviceId2, deviceKeyHex: deviceKey2.toString("hex"), keyId: "key_second" }),
    );
    const authedBridge = createBridge({ registry, now: () => FIXED_NOW });

    const promptResponse = await authedBridge.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId: "b0000000-0000-4000-8000-000000000013",
          sessionId: authedBridge.session.id,
          type: "prompt.send",
          timestamp: FIXED_NOW.toISOString(),
          payload: { text: "run the tests and push" },
        } satisfies Command,
      }),
    );
    expect(promptResponse.status).toBe(200);

    const eventsResponse = await authedBridge.fetch(
      signedRequest({ method: "GET", pathWithQuery: "/v1/events?after=0" }),
    );
    const binding = pendingBinding(((await eventsResponse.json()) as EventsResponse).events);

    const decide = (deviceId: string, deviceKey: Buffer, commandId: string): Promise<Response> =>
      authedBridge.fetch(
        signedRequest({
          method: "POST",
          pathWithQuery: "/v1/commands",
          deviceId,
          deviceKey,
          body: {
            commandId,
            sessionId: authedBridge.session.id,
            type: "approval.accept",
            timestamp: FIXED_NOW.toISOString(),
            payload: { binding },
          } satisfies Command,
        }),
      );

    const [first, second] = await Promise.all([
      decide(DEVICE_ID, DEVICE_KEY, "b0000000-0000-4000-8000-000000000014"),
      decide(deviceId2, deviceKey2, "b0000000-0000-4000-8000-000000000015"),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(await loser.json()).toEqual({
      error: "interaction_not_pending",
      interactionId: binding.approvalId,
      state: "resolved",
    });
  });

  test("session.cancel reports the session's pending approval as cancelled before session.completed", async () => {
    await post(promptCommand("b0000000-0000-4000-8000-000000000016"));
    const binding = pendingBinding(await eventsAfter(0));

    const cancelResponse = await post({
      commandId: "b0000000-0000-4000-8000-000000000017",
      sessionId: bridge.session.id,
      type: "session.cancel",
      timestamp: new Date().toISOString(),
      payload: {},
    });
    expect(cancelResponse.status).toBe(200);

    const events = await eventsAfter(0);
    const approvalResolved = events.find(
      (event) => event.type === "approval.resolved" && event.payload.approvalId === binding.approvalId,
    );
    const completed = events.find((event) => event.type === "session.completed");
    expect(approvalResolved?.payload).toMatchObject({ approvalId: binding.approvalId, decision: "cancelled" });
    expect(completed).toBeDefined();
    // Reported before session.completed, or a card still on screen for this approval would
    // never learn why it disappeared.
    expect(events.indexOf(approvalResolved!)).toBeLessThan(events.indexOf(completed!));
  });

  test("session.cancel reports the session's pending question as cancelled before session.completed", async () => {
    await post(promptCommand("b0000000-0000-4000-8000-000000000018"));
    const binding = pendingBinding(await eventsAfter(0));
    await post({
      commandId: "b0000000-0000-4000-8000-000000000019",
      sessionId: bridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });
    const question = pendingQuestion(await eventsAfter(0));

    const cancelResponse = await post({
      commandId: "b0000000-0000-4000-8000-00000000001a",
      sessionId: bridge.session.id,
      type: "session.cancel",
      timestamp: new Date().toISOString(),
      payload: {},
    });
    expect(cancelResponse.status).toBe(200);

    const events = await eventsAfter(0);
    const questionAnswered = events.find(
      (event) => event.type === "question.answered" && event.payload.questionId === question.questionId,
    );
    const completed = events.find((event) => event.type === "session.completed");
    expect(questionAnswered?.payload).toMatchObject({ questionId: question.questionId, answer: "", outcome: "cancelled" });
    expect(completed).toBeDefined();
    expect(events.indexOf(questionAnswered!)).toBeLessThan(events.indexOf(completed!));
  });

  test("question.answer past its expiresAt is refused with 410 even though the mock's own timer has not fired yet", async () => {
    const registry = new DeviceRegistry();
    // The bridge's own clock (used for the 410 check) is jumped forward between the approval
    // decision and the question decision, with no real wait: the approval decision still sees an
    // unexpired deadline, but by the time the question is answered its `expiresAt` reads as
    // already past. `ttlMs: 5000` keeps the mock provider's own real-timer expiry (task 4) from
    // firing during this synchronous test, isolating the server's own expiresAt-vs-`now()` check
    // (task 2) from the provider's own timer.
    let clockOffsetMs = 0;
    const localBridge = createBridge({
      registry,
      authEnabled: false,
      now: () => new Date(Date.now() + clockOffsetMs),
      mockProviderOptions: { ttlMs: 5000 },
    });
    const localPost = (command: Command): Promise<Response> =>
      localBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        }),
      );
    const localEvents = async (): Promise<AgentEvent[]> => {
      const response = await localBridge.fetch(new Request("http://bridge.local/v1/events?after=0"));
      return ((await response.json()) as EventsResponse).events;
    };

    await localPost({
      commandId: "b0000000-0000-4000-8000-000000000019",
      sessionId: localBridge.session.id,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "run the tests and push" },
    });
    const binding = pendingBinding(await localEvents());
    await localPost({
      commandId: "b0000000-0000-4000-8000-00000000001a",
      sessionId: localBridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });
    const question = pendingQuestion(await localEvents());

    // No real wait: the bridge's own clock alone decides the question is past its deadline.
    clockOffsetMs = 10_000;

    const response = await localPost({
      commandId: "b0000000-0000-4000-8000-00000000001b",
      sessionId: localBridge.session.id,
      type: "question.answer",
      timestamp: new Date().toISOString(),
      payload: { questionId: question.questionId, optionId: "opt_yes" },
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "decision_expired" });
  });

  test("the mock provider's approval expiry timer emits expired, and a later decision is refused as stale", async () => {
    const registry = new DeviceRegistry();
    // A short ttlMs (not the 5-minute production default) lets this test observe the timer
    // firing after a brief real delay instead of a long sleep.
    const localBridge = createBridge({ registry, authEnabled: false, mockProviderOptions: { ttlMs: 20 } });
    const localPost = (command: Command): Promise<Response> =>
      localBridge.fetch(
        new Request("http://bridge.local/v1/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
        }),
      );
    const localEvents = async (): Promise<AgentEvent[]> => {
      const response = await localBridge.fetch(new Request("http://bridge.local/v1/events?after=0"));
      return ((await response.json()) as EventsResponse).events;
    };

    await localPost({
      commandId: "b0000000-0000-4000-8000-00000000001c",
      sessionId: localBridge.session.id,
      type: "prompt.send",
      timestamp: new Date().toISOString(),
      payload: { text: "run the tests and push" },
    });
    const binding = pendingBinding(await localEvents());

    await new Promise((resolve) => setTimeout(resolve, 60));

    const resolvedEvents = (await localEvents()).filter((event) => event.type === "approval.resolved");
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]?.payload).toMatchObject({ approvalId: binding.approvalId, decision: "expired" });

    const response = await localPost({
      commandId: "b0000000-0000-4000-8000-00000000001d",
      sessionId: localBridge.session.id,
      type: "approval.accept",
      timestamp: new Date().toISOString(),
      payload: { binding },
    });
    // The binding's own expiresAt is checked before the registry, so an expired approval is
    // always 410, whether or not the provider's timer has already fired.
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "decision_expired" });
  });
});

describe("restart recovery", () => {
  let stateDir: string;
  let devicesFilePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "agentremote-restart-test-"));
    devicesFilePath = join(stateDir, "devices.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** A second `createBridge` over the same state dir is exactly what a bridge restart is. Closes
   * the previous instance's single-writer lock first: a real restart's old process is gone by
   * the time the new one starts, and no test here uses `first` after calling `restart()` again. */
  let current: Bridge | undefined;
  function restart(): Bridge {
    current?.close();
    current = createBridge({ devicesFilePath, authEnabled: false, now: () => FIXED_NOW });
    return current;
  }

  function commandBody(commandId: string, sessionId: string): Command {
    return {
      commandId,
      sessionId,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: "run the tests and push" },
    };
  }

  function postTo(target: Bridge, command: Command): Promise<Response> {
    return target.fetch(
      new Request("http://bridge.local/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
  }

  async function eventsOf(target: Bridge, after: number): Promise<EventsResponse> {
    const response = await target.fetch(new Request(`http://bridge.local/v1/events?after=${after}`));
    return (await response.json()) as EventsResponse;
  }

  test("a command already applied before the restart is answered from the journal, not re-executed", async () => {
    const first = restart();
    const command = commandBody("a1111111-1111-4111-8111-111111111111", first.session.id);
    const firstResponse = (await (await postTo(first, command)).json()) as CommandResponse;
    expect(firstResponse.duplicate).toBe(false);
    const eventsBefore = (await eventsOf(first, 0)).events.length;

    const second = restart();
    const retried = await postTo(second, command);
    const retriedBody = (await retried.json()) as CommandResponse;

    expect(retried.status).toBe(200);
    expect(retriedBody.duplicate).toBe(true);
    expect(retriedBody.accepted).toBe(firstResponse.accepted);
    // Re-execution would have appended a second turn.started to the retained log.
    expect((await eventsOf(second, 0)).events.length).toBe(eventsBefore);
  });

  test("retained events survive the restart and event ids keep increasing", async () => {
    const first = restart();
    await postTo(first, commandBody("a2222222-2222-4222-8222-222222222222", first.session.id));
    const before = await eventsOf(first, 0);
    expect(before.events.length).toBeGreaterThan(0);

    const second = restart();
    const afterRestart = await eventsOf(second, 0);
    expect(afterRestart.events.map((event) => event.eventId)).toEqual(before.events.map((event) => event.eventId));

    await postTo(second, commandBody("a3333333-3333-4333-8333-333333333333", second.session.id));
    const withNewEvents = await eventsOf(second, before.lastEventId);
    expect(withNewEvents.events.length).toBeGreaterThan(0);
    // Ids are never reused across a restart: a client cursor stays meaningful.
    for (const event of withNewEvents.events) {
      expect(event.eventId).toBeGreaterThan(before.lastEventId);
    }
  });

  test("a cursor below the retained window is reported truncated instead of silently continued", async () => {
    const first = restart();
    await postTo(first, commandBody("a4444444-4444-4444-8444-444444444444", first.session.id));
    const page = await eventsOf(first, 0);

    const stale = await eventsOf(first, 0);
    expect(stale.truncated).toBe(false);
    expect(stale.firstEventId).toBe(page.events[0]?.eventId);

    // Rewrite the journal as if retention had dropped everything below id 500.
    const retained = page.events.map((event, index) => ({ ...event, eventId: 500 + index }));
    writeFileSync(join(stateDir, "events.jsonl"), retained.map((event) => `${JSON.stringify(event)}\n`).join(""));

    const second = restart();
    const gapped = await eventsOf(second, 10);
    expect(gapped.firstEventId).toBe(500);
    expect(gapped.truncated).toBe(true);

    const continuous = await eventsOf(second, 500);
    expect(continuous.truncated).toBe(false);
  });

  test("an id already reserved by the watermark is never reissued after a crash that lost the event log itself", async () => {
    const first = restart();
    await postTo(first, commandBody("a7777777-7777-4777-8777-777777777777", first.session.id));
    const before = await eventsOf(first, 0);
    const highestBefore = before.lastEventId;
    expect(highestBefore).toBeGreaterThan(0);

    // A crash that loses the event log file itself, not just a graceful restart: the log alone
    // can no longer prove which ids are already spent, which is exactly what the watermark file
    // is for.
    rmSync(join(stateDir, "events.jsonl"));

    const second = restart();
    const afterCrash = await postTo(second, commandBody("a8888888-8888-4888-8888-888888888888", second.session.id));
    expect(afterCrash.status).toBe(200);
    for (const emitted of (await eventsOf(second, 0)).events) {
      expect(emitted.eventId).toBeGreaterThan(highestBefore);
    }
  });

  test("a cursor against a log emptied by retention is reported truncated even though ids were already issued", async () => {
    const first = restart();
    await postTo(first, commandBody("a9999999-9999-4999-8999-999999999999", first.session.id));

    // Simulate retention having dropped every retained event: the file exists but holds
    // nothing, so firstEventId reports 0 even though the bridge has already issued many ids.
    writeFileSync(join(stateDir, "events.jsonl"), "");

    const second = restart();
    const stale = await eventsOf(second, 0);
    expect(stale.firstEventId).toBe(0);
    expect(stale.truncated).toBe(true);
  });

  test("a command the previous process died in the middle of is refused as indeterminate", async () => {
    const command = commandBody("a5555555-5555-4555-8555-555555555555", "ses_seed");
    const rawBody = JSON.stringify(command);
    const entry = {
      commandId: command.commandId,
      deviceId: null,
      digest: createHash("sha256").update(rawBody).digest("hex"),
      status: "in_flight",
      at: FIXED_NOW.getTime(),
    };
    writeFileSync(join(stateDir, "commands.jsonl"), `${JSON.stringify(entry)}\n`);

    const after = restart();
    const response = await postTo(after, command);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "command_indeterminate", commandId: command.commandId });
    // Nothing was applied on this side either: the log holds no turn for it.
    expect((await eventsOf(after, 0)).events.length).toBe(0);
  });

  test("a nonce used before the restart is still rejected as a replay", async () => {
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleDeviceRecord());
    const nonce = randomBytes(16).toString("hex");

    const first = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const accepted = await first.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", nonce }));
    expect(accepted.status).toBe(200);

    first.close();
    const second = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const replayed = await second.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/sessions", nonce }));
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toEqual({ error: "replayed_request" });
  });

  test("a narrowed device still sees retained events of a session the provider forgot", async () => {
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleDeviceRecord({ allowedProjects: ["prj_demo"] }));

    const first = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const created = await first.fetch(
      signedRequest({
        method: "POST",
        pathWithQuery: "/v1/commands",
        body: {
          commandId: "a6666666-6666-4666-8666-666666666666",
          sessionId: "ses_placeholder",
          type: "session.create",
          timestamp: FIXED_NOW.toISOString(),
          payload: { projectId: "prj_demo", provider: "mock" },
        },
      }),
    );
    expect(created.status).toBe(200);
    const createdSessionId = ((await created.json()) as CommandResponse).sessionId;
    expect(createdSessionId).toBeDefined();

    first.close();
    const second = createBridge({ devicesFilePath, now: () => FIXED_NOW });
    const response = await second.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/events?after=0" }));
    expect(response.status).toBe(200);
    const page = (await response.json()) as EventsResponse;

    // The restarted provider has no such session, so only the persisted session index can
    // authorize these events; without it the device would reconnect to an empty history.
    expect(page.events.some((event) => event.sessionId === createdSessionId)).toBe(true);
  });

  test("a decision on an approval already resolved before the restart is refused, not replayed", async () => {
    const first = restart();
    await postTo(first, commandBody("a1010101-1010-4101-8101-101010101010", first.session.id));
    const requested = (await eventsOf(first, 0)).events.find((event) => event.type === "approval.requested");
    if (requested === undefined || requested.type !== "approval.requested") {
      throw new Error("no approval.requested event was emitted");
    }
    const binding = requested.payload.binding;

    const decideResponse = await postTo(first, {
      commandId: "a1010101-1010-4101-8101-101010101011",
      sessionId: first.session.id,
      type: "approval.accept",
      timestamp: FIXED_NOW.toISOString(),
      payload: { binding },
    });
    expect(decideResponse.status).toBe(200);

    // A fresh commandId, not a retry: this exercises the interaction registry (rebuilt from the
    // event log at startup), not the command journal's own idempotency check.
    const second = restart();
    const retryResponse = await postTo(second, {
      commandId: "a1010101-1010-4101-8101-101010101012",
      sessionId: second.session.id,
      type: "approval.accept",
      timestamp: FIXED_NOW.toISOString(),
      payload: { binding },
    });
    expect(retryResponse.status).toBe(409);
    expect(await retryResponse.json()).toEqual({
      error: "interaction_not_pending",
      interactionId: binding.approvalId,
      state: "resolved",
    });
  });

  test("an approval requested after a restart is decidable even though the previous boot resolved one", async () => {
    const first = restart();
    await postTo(first, commandBody("a1010101-1010-4101-8101-101010101020", first.session.id));
    const firstRequested = (await eventsOf(first, 0)).events.find((event) => event.type === "approval.requested");
    if (firstRequested === undefined || firstRequested.type !== "approval.requested") {
      throw new Error("no approval.requested event was emitted");
    }
    const firstDecision = await postTo(first, {
      commandId: "a1010101-1010-4101-8101-101010101021",
      sessionId: first.session.id,
      type: "approval.accept",
      timestamp: FIXED_NOW.toISOString(),
      payload: { binding: firstRequested.payload.binding },
    });
    expect(firstDecision.status).toBe(200);

    // The new boot's provider issues approval ids from scratch. They must not collide with the
    // resolved record the registry rebuilt from the previous boot's log, or the gate refuses a
    // live approval.
    const second = restart();
    await postTo(second, commandBody("a1010101-1010-4101-8101-101010101022", second.session.id));
    const secondRequested = (await eventsOf(second, 0)).events.filter((event) => event.type === "approval.requested").at(-1);
    if (secondRequested === undefined || secondRequested.type !== "approval.requested") {
      throw new Error("no approval.requested event was emitted after the restart");
    }
    expect(secondRequested.payload.binding.approvalId).not.toBe(firstRequested.payload.binding.approvalId);
    const secondDecision = await postTo(second, {
      commandId: "a1010101-1010-4101-8101-101010101023",
      sessionId: second.session.id,
      type: "approval.accept",
      timestamp: FIXED_NOW.toISOString(),
      payload: { binding: secondRequested.payload.binding },
    });
    expect(secondDecision.status).toBe(200);
  });
});

describe("single-writer state dir lock", () => {
  let stateDir: string;
  let devicesFilePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "agentremote-lock-test-"));
    devicesFilePath = join(stateDir, "devices.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("a second bridge refuses to start while the first still holds a live lock", () => {
    createBridge({ devicesFilePath, authEnabled: false, now: () => FIXED_NOW });

    expect(() => createBridge({ devicesFilePath, authEnabled: false, now: () => FIXED_NOW })).toThrow(
      /already holds the lock/,
    );
  });

  test("a state file the bridge cannot write stops startup with its path, and releases the lock", () => {
    // A directory where a journal should be makes the append open fail (EISDIR), which is what
    // a wrong owner or a read-only file does too, without depending on the test user's privileges.
    mkdirSync(join(stateDir, "events.jsonl"));

    expect(() => createBridge({ devicesFilePath, authEnabled: false, now: () => FIXED_NOW })).toThrow(
      /cannot write its state file .*events\.jsonl/,
    );
    expect(existsSync(join(stateDir, "bridge.lock"))).toBe(false);
  });

  test("a lock file left behind by a dead process is taken over instead of blocking startup", () => {
    // No real process can hold this pid; it is well past any platform's max pid.
    writeFileSync(join(stateDir, "bridge.lock"), "999999999", "utf8");

    expect(() => createBridge({ devicesFilePath, authEnabled: false, now: () => FIXED_NOW })).not.toThrow();
  });

  test("a bridge boots against a state dir that does not exist yet", () => {
    // A fresh install has no ~/.agentremote at all: the lock is the first file written into it,
    // so the directory has to be created before the exclusive create rather than by whatever
    // journal happens to write first.
    const freshDir = join(stateDir, "not-created-yet");
    let fresh: Bridge | undefined;

    expect(() => {
      fresh = createBridge({
        devicesFilePath: join(freshDir, "devices.json"),
        authEnabled: false,
        now: () => FIXED_NOW,
      });
    }).not.toThrow();
    expect(readFileSync(join(freshDir, "bridge.lock"), "utf8").trim()).toBe(String(process.pid));

    fresh?.close();
  });
});

describe("retained events of a reused session id", () => {
  let stateDir: string;
  let devicesFilePath: string;
  const originalProvider = process.env.AGENTREMOTE_PROVIDER;
  const originalDirs = process.env.AGENTREMOTE_PROJECT_DIRS;
  const projectA = projectIdFor("/tmp/agentremote-project-a");
  const projectB = projectIdFor("/tmp/agentremote-project-b");

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "agentremote-rebind-test-"));
    devicesFilePath = join(stateDir, "devices.json");
    // Two projects are needed to reuse a session id across projects, and the stub claude
    // provider is the only one wired to more than one.
    process.env.AGENTREMOTE_PROVIDER = "claude";
    process.env.AGENTREMOTE_PROJECT_DIRS = "/tmp/agentremote-project-a,/tmp/agentremote-project-b";
  });

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env.AGENTREMOTE_PROVIDER;
    } else {
      process.env.AGENTREMOTE_PROVIDER = originalProvider;
    }
    if (originalDirs === undefined) {
      delete process.env.AGENTREMOTE_PROJECT_DIRS;
    } else {
      process.env.AGENTREMOTE_PROJECT_DIRS = originalDirs;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  function boot(authEnabled: boolean): Bridge {
    return createBridge({
      devicesFilePath,
      authEnabled,
      now: () => FIXED_NOW,
      createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
    });
  }

  function send(target: Bridge, command: Command): Promise<Response> {
    return target.fetch(
      new Request("http://bridge.local/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
  }

  /** One boot that creates a session in `projectId`, records an event under it, and shuts down.
   * The stub provider hands out the same session id (`ses_stub`) on every boot, which is how a
   * session id really can be reused after a restart. */
  async function bootAndRecord(projectId: string, suffix: string): Promise<string> {
    const booted = boot(false);
    const created = await send(booted, {
      commandId: `b${suffix}111111-1111-4111-8111-111111111111`,
      sessionId: "ses_placeholder",
      type: "session.create",
      timestamp: FIXED_NOW.toISOString(),
      payload: { projectId, provider: "claude" },
    });
    const body = (await created.json()) as CommandResponse;
    expect(created.status).toBe(200);
    const sessionId = body.sessionId;
    if (sessionId === undefined) {
      throw new Error("session.create did not report a session id");
    }
    const prompted = await send(booted, {
      commandId: `c${suffix}222222-2222-4222-8222-222222222222`,
      sessionId,
      type: "prompt.send",
      timestamp: FIXED_NOW.toISOString(),
      payload: { text: `prompt under ${projectId}` },
    });
    expect(prompted.status).toBe(200);
    booted.close();
    return sessionId;
  }

  /** Boots with `allowed` granted to the paired device, reuses `ses_stub` for a session under
   * project B, and returns the page that device reads. */
  async function reuseUnderProjectB(allowed: string[], commandId: string): Promise<EventsResponse> {
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleDeviceRecord({ allowedProjects: allowed }));

    const reader = boot(true);
    const createBody: Command = {
      commandId,
      sessionId: "ses_placeholder",
      type: "session.create",
      timestamp: FIXED_NOW.toISOString(),
      payload: { projectId: projectB, provider: "claude" },
    };
    const created = await reader.fetch(
      signedRequest({ method: "POST", pathWithQuery: "/v1/commands", body: createBody }),
    );
    expect(created.status).toBe(200);
    expect(((await created.json()) as CommandResponse).sessionId).toBe("ses_stub");

    const response = await reader.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/events?after=0" }));
    expect(response.status).toBe(200);
    const page = (await response.json()) as EventsResponse;
    reader.close();
    return page;
  }

  test("a retained event keeps the project it was emitted under when the session id is reused", async () => {
    const first = await bootAndRecord(projectA, "1");
    const page = await reuseUnderProjectB([projectA, projectB], "d1111111-1111-4111-8111-111111111111");

    // The event was stamped with project A when it was emitted, and reusing `ses_stub` for a
    // project B session afterwards does not restate what that older event was about.
    const retained = page.events.filter((event) => event.sessionId === first);
    expect(retained.length).toBe(1);
    expect(retained[0]?.projectId).toBe(projectA);
  });

  /** Strips the stamp from every persisted event, which is what a log written before the field
   * existed looks like after an upgrade. */
  function unstampPersistedEvents(): void {
    const eventsPath = join(stateDir, "events.jsonl");
    const lines = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const { projectId: _dropped, ...rest } = JSON.parse(line) as AgentEvent & { projectId?: string };
        return JSON.stringify(rest);
      });
    writeFileSync(eventsPath, `${lines.join("\n")}\n`);
  }

  test("an event persisted before the stamp existed is still authorized through the session index", async () => {
    const first = await bootAndRecord(projectA, "1");
    unstampPersistedEvents();

    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleDeviceRecord({ allowedProjects: [projectA] }));
    const reader = boot(true);
    const response = await reader.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/events?after=0" }));
    const page = (await response.json()) as EventsResponse;
    reader.close();

    // No stamp to read, so the durable session binding answers instead: an upgrade must not
    // blank out the history a paired device already had.
    expect(page.events.some((event) => event.sessionId === first)).toBe(true);
  });

  test("an unstamped event is withheld from a device not allowed its session's recorded project", async () => {
    const first = await bootAndRecord(projectA, "1");
    unstampPersistedEvents();

    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleDeviceRecord({ allowedProjects: [projectB] }));
    const reader = boot(true);
    const response = await reader.fetch(signedRequest({ method: "GET", pathWithQuery: "/v1/events?after=0" }));
    const page = (await response.json()) as EventsResponse;
    reader.close();

    expect(page.events.some((event) => event.sessionId === first)).toBe(false);
  });

  test("reusing a session id does not expose its earlier project's events to a device narrowed to the new project", async () => {
    const first = await bootAndRecord(projectA, "1");
    const page = await reuseUnderProjectB([projectB], "e1111111-1111-4111-8111-111111111111");

    // The device may read project B, and `ses_stub` is now a project B session, but the
    // retained event belongs to project A and stays withheld. Authorizing it against the live
    // session instead of its own stamp is exactly the hole this closes.
    expect(page.events.some((event) => event.sessionId === first)).toBe(false);
  });
});

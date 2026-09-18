import { beforeEach, describe, expect, test } from "bun:test";
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
import { TurnInProgressError, UnknownSessionError } from "@agentremote/protocol";

import { createBridge, projectIdFor, resolveBindHost, type Bridge, type CreateBridgeOptions } from "./server";

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
  /** Set by a test to make the next cancel call throw instead of resolving. */
  cancelError: Error | undefined;

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
    return [...this.sessions.values()];
  }

  async createSession(projectId: string): Promise<Session> {
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
        createClaudeProvider: (host, providerOptions) => new StubClaudeProvider(host, providerOptions),
      };
      expect(() => createBridge(options)).not.toThrow();
      const claudeBridge = createBridge(options);
      expect(claudeBridge.session.projectId).toBe(projectIdFor(process.cwd()));
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

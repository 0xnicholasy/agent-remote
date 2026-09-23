import { describe, expect, setSystemTime, test } from "bun:test";
import {
  ApprovalBindingMismatchError,
  digest,
  InteractionPendingError,
  SessionLimitError,
  TurnInProgressError,
  UnknownSessionError,
} from "@agentremote/protocol";

/** After an approval auto-expires nobody-answered, the SDK's `canUseTool` call unblocks with a
 * deny and its turn finishes on its own, which — depending on exactly how far that race has
 * gotten by the time the test calls `approve()` again — tears the conversation down before or
 * after the redundant `approve()` arrives. Either way a late `approve()` must fail rather than
 * double-resolve the same interaction, so both outcomes are accepted here (C1-001). */
async function expectApproveRefused(promise: Promise<void>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error instanceof ApprovalBindingMismatchError || error instanceof UnknownSessionError).toBe(true);
}
import type { AgentEvent, ApprovalBinding, Project, ProviderHost } from "@agentremote/protocol";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { ClaudeProvider, type QueryFn } from "./index";

function createHost(): { host: ProviderHost; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  let nextId = 1;
  const host: ProviderHost = {
    emit(sessionId, type, payload) {
      const event = {
        eventId: nextId++,
        sessionId,
        provider: "claude",
        type,
        timestamp: new Date().toISOString(),
        payload,
      } as AgentEvent;
      events.push(event);
      return event;
    },
    eventsAfter(after: number) {
      return events.filter((event) => event.eventId > after);
    },
    async waitForChange() {
      // Not exercised: these tests drive the provider directly rather than long-polling.
    },
  };
  return { host, events };
}

/** A host whose `emit` throws for the given event types, standing in for the bridge's durable
 * emit path after it was made to throw when an event cannot be appended to the event log. */
function createFailingHost(failTypes: Array<AgentEvent["type"]>): { host: ProviderHost; events: AgentEvent[] } {
  const inner = createHost();
  const host: ProviderHost = {
    emit(sessionId, type, payload) {
      if (failTypes.includes(type)) {
        throw new Error(`event log append failed for ${type}`);
      }
      return inner.host.emit(sessionId, type, payload);
    },
    eventsAfter(after: number) {
      return inner.host.eventsAfter(after);
    },
    waitForChange(timeoutMs: number) {
      return inner.host.waitForChange(timeoutMs);
    },
  };
  return { host, events: inner.events };
}

// Minimal stand-ins for the real SDK message and tool-call shapes. `SDKAssistantMessage` and
// `SDKResultMessage` each carry dozens of fields (BetaMessage ids, stop reasons, per-model
// usage tables, ...) that the provider never reads, so these fakes carry only the fields it
// does read and are cast past the rest.
function fakeAssistant(text: string, uuid: string): SDKMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] }, uuid } as unknown as SDKMessage;
}

function fakeResult(result: string, usage = { input_tokens: 10, output_tokens: 20 }): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 5,
    result,
    usage,
    total_cost_usd: 0.01,
    uuid: "res",
  } as unknown as SDKMessage;
}

function fakeResultError(
  subtype: "error_max_turns" | "error_during_execution",
  errors: string[] = [],
  usage = { input_tokens: 5, output_tokens: 7 },
): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 5,
    usage,
    total_cost_usd: 0.02,
    errors,
    uuid: "res_err",
  } as unknown as SDKMessage;
}

function callOpts(overrides: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: "tc_1",
    requestId: "req_1",
    ...overrides,
  } as Parameters<CanUseTool>[2];
}

/** Turns a plain async generator into a test double for `Query`: the provider only calls
 * `for await` iteration, `interrupt()`, and `return()` (disposal) on it, so the rest of the
 * real `Query` interface is cast past rather than implemented. */
function asQuery(
  gen: AsyncGenerator<SDKMessage, void>,
): { query: Query; interrupted: () => boolean; returned: () => boolean } {
  let interrupted = false;
  let returned = false;
  const query = gen as unknown as Query;
  query.interrupt = async () => {
    interrupted = true;
    return undefined;
  };
  const originalReturn = gen.return.bind(gen);
  query.return = ((value: void) => {
    returned = true;
    return originalReturn(value);
  }) as Query["return"];
  return { query, interrupted: () => interrupted, returned: () => returned };
}

function project(id: string, path: string): Project {
  return { id, name: id, path };
}

function delay(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bindingOf(events: AgentEvent[]): ApprovalBinding {
  const requested = events.find((event) => event.type === "approval.requested");
  if (requested === undefined || requested.type !== "approval.requested") {
    throw new Error("no approval.requested event was emitted");
  }
  return requested.payload.binding;
}

function allBindings(events: AgentEvent[]): ApprovalBinding[] {
  return events
    .filter((event) => event.type === "approval.requested")
    .map((event) => (event.type === "approval.requested" ? event.payload.binding : undefined))
    .filter((binding): binding is ApprovalBinding => binding !== undefined);
}

/** A malformed `assistant` message missing the `content` array `handleMessage` reads, so it
 * exercises a bug in our own message mapping rather than an SDK/transport failure. */
function malformedAssistant(): SDKMessage {
  return { type: "assistant", message: {}, uuid: "bad" } as unknown as SDKMessage;
}

async function readPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage> {
  const { value } = await prompt[Symbol.asyncIterator]().next();
  return value;
}

describe("ClaudeProvider", () => {
  test("a prompt produces an agent message and a completed turn", async () => {
    const queryFn: QueryFn = ((_args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield fakeAssistant("hi there", "u1");
        yield fakeResult("hi there");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "hello");
    await delay();

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("agent.message");
    expect(types).toContain("turn.completed");
    const message = events.find((event) => event.type === "agent.message");
    expect(message?.payload).toMatchObject({ text: "hi there", final: true, role: "assistant" });
  });

  test("every tool is routed through canUseTool: no filesystem settings, no auto-allowed Bash", async () => {
    // Measured against the real SDK on 2026-09-19: with these options left at their defaults a
    // Bash command ran with no approval.requested ever emitted, because the user's own settings
    // allow-list, the sandbox auto-allow and the CLI's safety classifier each resolve a tool call
    // before canUseTool runs. A watch that never sees the approval cannot withhold it.
    let seen: Options | undefined;
    const queryFn: QueryFn = ((args) => {
      seen = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    await provider.createSession("p1");

    expect(seen?.settingSources).toEqual([]);
    expect(seen?.sandbox).toEqual({ autoAllowBashIfSandboxed: false });
    expect(seen?.managedSettings).toEqual({ permissions: { ask: ["Bash"] } });
    expect(typeof seen?.canUseTool).toBe("function");
  });

  test("the settings/sandbox/Bash-ask enforcement holds even when the caller's own permissionMode conflicts (R-06)", async () => {
    // A caller-supplied `permissionMode` like "bypassPermissions" is exactly the kind of setting
    // that could plausibly widen the SDK's own auto-allow behavior; this proves the adapter's
    // hardcoded enforcement is not overridden or merged away by it.
    let seen: Options | undefined;
    const queryFn: QueryFn = ((args) => {
      seen = args.options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      permissionMode: "bypassPermissions",
    });
    await provider.createSession("p1");

    expect(seen?.permissionMode).toBe("bypassPermissions");
    expect(seen?.settingSources).toEqual([]);
    expect(seen?.sandbox).toEqual({ autoAllowBashIfSandboxed: false });
    expect(seen?.managedSettings).toEqual({ permissions: { ask: ["Bash"] } });
  });

  test("a Bash tool call stays pending until explicitly approved, never auto-allowed (R-07)", async () => {
    // Proves the bypass the R-06 config only configures: with no approve()/reject() call, the
    // canUseTool promise must not resolve on its own, no matter how long it waits.
    let settled = false;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const pending = args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        void pending.then(() => {
          settled = true;
        });
        const result = await pending;
        yield fakeResult(result?.behavior === "allow" ? "ran ls" : "denied");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay(30);

    expect(settled).toBe(false);
    const binding = bindingOf(events);

    await provider.approve(session.id, binding);
    await delay();

    expect(settled).toBe(true);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({ summary: "ran ls" });
  });

  test("an approval request unblocks the tool call once approved", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const result = await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts({ title: "Run ls" }));
        if (result === null) {
          throw new Error("canUseTool returned null");
        }
        yield fakeResult(result.behavior === "allow" ? "ran ls" : "denied");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const binding = bindingOf(events);

    await provider.approve(session.id, binding);
    await delay();

    expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({
      approvalId: binding.approvalId,
      decision: "accepted",
    });
    expect(events.map((event) => event.type)).toContain("turn.completed");
  });

  test("rejecting an approval denies the tool call with the given reason", async () => {
    let denyMessage: string | undefined;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const result = await args.options!.canUseTool!("Bash", { command: "rm -rf /" }, callOpts());
        if (result === null) {
          throw new Error("canUseTool returned null");
        }
        if (result.behavior === "deny") {
          denyMessage = result.message;
        }
        yield fakeResult("stopped");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "clean up");
    await delay();
    const binding = bindingOf(events);

    await provider.reject(session.id, binding, "too dangerous");
    await delay();

    expect(denyMessage).toBe("too dangerous");
    expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({
      decision: "rejected",
      reason: "too dangerous",
    });
  });

  test("a mismatched binding is refused and the pending approval stays", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const binding = bindingOf(events);
    const tampered: ApprovalBinding = { ...binding, actionDigest: "sha256:deadbeef" };

    await expect(provider.approve(session.id, tampered)).rejects.toBeInstanceOf(ApprovalBindingMismatchError);

    // The real binding still resolves the still-pending approval.
    await provider.approve(session.id, binding);
    expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({ decision: "accepted" });
  });

  test("an expired binding is refused and marks the approval expired", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      approvalTtlMs: -1000, // already expired the instant it is requested
    });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const binding = bindingOf(events);

    // The armed expiry timer (C1-001) may already have resolved this approval and torn the
    // conversation down by the time this runs, so a late `approve()` can throw either the
    // binding-mismatch or the unknown-session error; either means it correctly refused to
    // double-resolve.
    await expectApproveRefused(provider.approve(session.id, binding));
    expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({ decision: "expired" });
  });

  test("C1-001: an approval nobody answers auto-resolves as denied once the TTL elapses", async () => {
    let toolResult: PermissionResult | null = null;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const result = await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        toolResult = result;
        yield fakeResult(result?.behavior === "allow" ? "ran ls" : "denied");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    // A short TTL (constructor option, C1-001) lets this test observe the auto-expiry timer
    // firing instead of waiting out the real 5-minute `APPROVAL_TTL_MS`.
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      approvalTtlMs: 20,
    });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const binding = bindingOf(events);

    // Nobody calls approve()/reject(): wait past the TTL for the timer to fire on its own.
    await delay(60);

    expect(toolResult).toMatchObject({ behavior: "deny" });
    const resolvedEvents = events.filter((event) => event.type === "approval.resolved");
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]?.payload).toMatchObject({ approvalId: binding.approvalId, decision: "expired" });

    // The binding was already taken off `pendingApproval` by the timer, so a late approve() must
    // fail rather than double-resolving the same interaction.
    await expectApproveRefused(provider.approve(session.id, binding));
    expect(events.filter((event) => event.type === "approval.resolved")).toHaveLength(1);
  });

  test("a decision on an already-expired approval settles the SDK call even if its event cannot be persisted", async () => {
    let toolResult: PermissionResult | null = null;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        toolResult = await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("denied");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    // `approval.resolved` cannot be persisted, and the clock is moved past `expiresAt` while the
    // auto-expiry timer (armed for a full minute) has not fired, so `approve()` takes the expired
    // branch itself. The emit failure there must not strand `canUseTool`: the timer is already
    // cleared and the pending already detached, so nothing else would ever settle it.
    const { host, events } = createFailingHost(["approval.resolved"]);
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      approvalTtlMs: 60_000,
    });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const binding = bindingOf(events);

    setSystemTime(new Date(Date.now() + 120_000));
    try {
      await expectApproveRefused(provider.approve(session.id, binding));
      await delay();
      expect(toolResult).toMatchObject({ behavior: "deny" });
    } finally {
      setSystemTime();
    }
  });

  test("C1-003: a Bash approval is emitted with kind \"command\"", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();

    expect(events.find((event) => event.type === "approval.requested")?.payload).toMatchObject({ kind: "command" });
  });

  test("C1-003: an unrecognized tool's approval falls back to kind \"other\"", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("SomeCustomTool", { foo: "bar" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "do something");
    await delay();

    expect(events.find((event) => event.type === "approval.requested")?.payload).toMatchObject({ kind: "other" });
  });

  test("a question is answered by selecting an option", async () => {
    let updatedInputSeen: unknown;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const input = {
          questions: [
            {
              question: "Which library?",
              header: "Library",
              options: [
                { label: "date-fns", description: "smaller" },
                { label: "luxon", description: "more features" },
              ],
              multiSelect: false,
            },
          ],
        };
        const result = await args.options!.canUseTool!("AskUserQuestion", input, callOpts());
        if (result === null) {
          throw new Error("canUseTool returned null");
        }
        if (result.behavior === "allow") {
          updatedInputSeen = result.updatedInput;
        }
        yield fakeResult("picked");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "pick a library");
    await delay();
    const requested = events.find((event) => event.type === "question.requested");
    if (requested === undefined || requested.type !== "question.requested") {
      throw new Error("no question.requested event was emitted");
    }
    expect(requested.payload.options).toHaveLength(2);
    expect(requested.payload.allowFreeText).toBe(true);

    await provider.answerQuestion(session.id, { questionId: requested.payload.questionId, optionId: "opt_1" });
    await delay();

    expect(events.find((event) => event.type === "question.answered")?.payload).toMatchObject({ answer: "luxon" });
    expect(updatedInputSeen).toMatchObject({ answers: { "Which library?": "luxon" } });
  });

  test("a question is answered with free text", async () => {
    let updatedInputSeen: unknown;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const input = {
          questions: [
            {
              question: "Which library?",
              header: "Library",
              options: [
                { label: "date-fns", description: "smaller" },
                { label: "luxon", description: "more features" },
              ],
              multiSelect: false,
            },
          ],
        };
        const result = await args.options!.canUseTool!("AskUserQuestion", input, callOpts());
        if (result === null) {
          throw new Error("canUseTool returned null");
        }
        if (result.behavior === "allow") {
          updatedInputSeen = result.updatedInput;
        }
        yield fakeResult("picked");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "pick a library");
    await delay();
    const requested = events.find((event) => event.type === "question.requested");
    if (requested === undefined || requested.type !== "question.requested") {
      throw new Error("no question.requested event was emitted");
    }

    await provider.answerQuestion(session.id, { questionId: requested.payload.questionId, text: "day.js, actually" });
    await delay();

    expect(events.find((event) => event.type === "question.answered")?.payload).toMatchObject({ answer: "day.js, actually" });
    expect(updatedInputSeen).toMatchObject({ response: "day.js, actually" });
  });

  test("sendPrompt is refused while an approval is pending", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    expect(events.some((event) => event.type === "approval.requested")).toBe(true);

    await expect(provider.sendPrompt(session.id, "another one")).rejects.toBeInstanceOf(InteractionPendingError);
  });

  test("cancel interrupts the query and invalidates the pending approval", async () => {
    const captured: { interrupted?: () => boolean } = {};
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      const wrapped = asQuery(gen());
      captured.interrupted = wrapped.interrupted;
      return wrapped.query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const binding = bindingOf(events);

    await provider.cancel(session.id);

    expect(captured.interrupted?.()).toBe(true);
    expect(events.map((event) => event.type)).toContain("session.completed");
    // The whole conversation is torn down on cancel (not just the one approval), so a decision
    // made afterwards is against an unknown session rather than a stale binding.
    await expect(provider.approve(session.id, binding)).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test("cancel() still terminates the session when interrupt() throws (E-011)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      const wrapped = asQuery(gen());
      wrapped.query.interrupt = async () => {
        throw new Error("interrupt boom");
      };
      return wrapped.query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();

    await provider.cancel(session.id);

    expect(events.find((event) => event.type === "error")?.payload).toMatchObject({
      code: "provider_error",
      message: "interrupt failed: interrupt boom",
      fatal: false,
    });
    expect(events.map((event) => event.type)).toContain("session.completed");
    await expect(provider.sendPrompt(session.id, "another one")).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test("cancel() resolves within the timeout when the SDK's return() never settles (R-040)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      const wrapped = asQuery(gen());
      // Simulates a wedged SDK subprocess: `.return()` never settles.
      wrapped.query.return = (() => new Promise(() => {})) as Query["return"];
      return wrapped.query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      terminateTimeoutMs: 20,
    });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();

    await provider.cancel(session.id);

    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.type === "error" ? errorEvent.payload.message : undefined).toContain("queryHandle.return");
    expect(events.map((event) => event.type)).toContain("session.completed");
    expect((await provider.listSessions()).map((s) => s.id)).not.toContain(session.id);
  });

  test("cancelling one session leaves another session's pending approval intact", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1"), project("p2", "/tmp/p2")],
      query: queryFn,
    });
    const sessionA = await provider.createSession("p1");
    const sessionB = await provider.createSession("p2");

    await provider.sendPrompt(sessionA.id, "run ls");
    await provider.sendPrompt(sessionB.id, "run ls");
    await delay();

    const bindingB = events
      .filter((event) => event.sessionId === sessionB.id && event.type === "approval.requested")
      .map((event) => (event.type === "approval.requested" ? event.payload.binding : undefined))[0];
    if (bindingB === undefined) {
      throw new Error("no approval.requested event was emitted for session B");
    }

    await provider.cancel(sessionA.id);

    expect(events.some((event) => event.sessionId === sessionA.id && event.type === "session.completed")).toBe(true);
    await provider.approve(sessionB.id, bindingB);
    expect(
      events.some(
        (event) => event.sessionId === sessionB.id && event.type === "approval.resolved" && event.payload.decision === "accepted",
      ),
    ).toBe(true);
  });

  test("two concurrent canUseTool calls are served one after the other (E-008)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const [first, second] = await Promise.all([
          args.options!.canUseTool!("Bash", { command: "ls" }, callOpts({ toolUseID: "tc_a" })),
          args.options!.canUseTool!("Bash", { command: "pwd" }, callOpts({ toolUseID: "tc_b" })),
        ]);
        yield fakeResult(`${first?.behavior}/${second?.behavior}`);
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run two things");
    await delay();

    // Only the first interaction is visible; the second is queued behind the lock rather than
    // overwriting the first's pending slot.
    expect(allBindings(events)).toHaveLength(1);

    await provider.approve(session.id, allBindings(events)[0]!);
    await delay();

    expect(allBindings(events)).toHaveLength(2);
    await provider.approve(session.id, allBindings(events)[1]!);
    await delay();

    expect(events.map((event) => event.type)).toContain("turn.completed");
  });

  test("a pump crash clears pending interactions, terminates the session, and blocks further prompts (E-001)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        void args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        throw new Error("sdk process crashed");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();

    const types = events.map((event) => event.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("error");
    expect(types).toContain("session.completed");
    expect(events.find((event) => event.type === "session.completed")?.payload).toMatchObject({ reason: "error" });

    await expect(provider.sendPrompt(session.id, "another one")).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test("a handleMessage bug is reported distinctly from an SDK crash and still terminates cleanly (E-002)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield malformedAssistant();
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "hi");
    await delay();

    expect(events.find((event) => event.type === "error")?.payload).toMatchObject({ code: "message_handling_error" });
    expect(events.map((event) => event.type)).toContain("session.completed");
  });

  test("sendPrompt during an in-flight turn with no pending interaction throws (E-004)", async () => {
    let releaseTurn: (() => void) | undefined;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "first");
    await delay();

    await expect(provider.sendPrompt(session.id, "second")).rejects.toBeInstanceOf(TurnInProgressError);

    releaseTurn?.();
  });

  test("an SDKResultError emits an error event and usage, not turn.completed (E-007)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield fakeResultError("error_max_turns", ["ran out of turns"]);
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();

    const types = events.map((event) => event.type);
    expect(types).not.toContain("turn.completed");
    expect(types).toContain("usage.updated");
    expect(events.find((event) => event.type === "error")?.payload).toMatchObject({
      code: "error_max_turns",
      message: "ran out of turns",
    });
  });

  test("cancel disposes the query handle (E-010)", async () => {
    const captured: { returned?: () => boolean } = {};
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      const wrapped = asQuery(gen());
      captured.returned = wrapped.returned;
      return wrapped.query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();

    await provider.cancel(session.id);

    expect(captured.returned?.()).toBe(true);
  });

  test("a terminated session is no longer reported by listSessions, mirroring how the bridge's sessionExists gate reads it (E-015)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    expect((await provider.listSessions()).map((s) => s.id)).toContain(session.id);

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    await provider.cancel(session.id);

    // `sessionExists` in the bridge checks only id presence in `listSessions()`, not `state`, so
    // the session must be removed outright rather than left behind with a terminal state.
    expect((await provider.listSessions()).map((s) => s.id)).not.toContain(session.id);
  });

  test("canUseTool resolves a deny instead of throwing synchronously when it races a concurrent termination (E-016)", async () => {
    let capturedCanUseTool: CanUseTool | undefined;
    const queryFn: QueryFn = ((args) => {
      capturedCanUseTool = args.options!.canUseTool;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield fakeResult("done");
        // Keeps the stream open so the cancel below is what terminates the session, not the
        // idle-end teardown (R-031).
        await delay(200);
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");
    await provider.sendPrompt(session.id, "run ls");
    await delay();

    // Terminate the conversation, then invoke the SDK's captured `canUseTool` as if the SDK had
    // already committed to calling it just before termination landed (E-008's "in-flight
    // parallel tool call" race, but against a session that is now gone).
    await provider.cancel(session.id);

    let synchronousThrow = false;
    let result: unknown;
    try {
      const pending = capturedCanUseTool!("Bash", { command: "pwd" }, callOpts());
      // A synchronous throw would have happened above, before `pending` is ever assigned to a
      // promise; reaching here at all is already part of the assertion.
      result = await pending;
    } catch {
      synchronousThrow = true;
    }

    expect(synchronousThrow).toBe(false);
    expect(result).toMatchObject({ behavior: "deny" });
  });

  test("sendPrompt racing a concurrent cancel's teardown is rejected instead of hanging (E-017)", async () => {
    let releaseReturn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield fakeResult("done");
        // Keeps the stream open past the result so this test exercises the cancel race rather
        // than the idle-end teardown (R-031).
        await delay(200);
      }
      const wrapped = asQuery(gen());
      const originalReturn = wrapped.query.return;
      // Defers `.return()` so `terminateConversation` is caught mid-teardown: `terminal` has
      // already been set synchronously, but the conversation is still in `this.conversations`.
      wrapped.query.return = (async (value: void) => {
        await gate;
        return originalReturn(value);
      }) as Query["return"];
      return wrapped.query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "first");
    await delay();

    const cancelPromise = provider.cancel(session.id);
    await delay();

    await expect(provider.sendPrompt(session.id, "second")).rejects.toBeInstanceOf(UnknownSessionError);

    releaseReturn();
    await cancelPromise;

    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
  });

  test("seedSession throws for an unknown projectId (E-003)", () => {
    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: (() => {
        throw new Error("query() should not be called");
      }) as unknown as QueryFn,
    });
    const now = new Date().toISOString();

    expect(() =>
      provider.seedSession({
        id: "ses_seed",
        projectId: "does-not-exist",
        provider: "claude",
        state: "idle",
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow(/unknown projectId/);
  });

  test("a multi-question AskUserQuestion is asked sequentially and merged into one result (E-009)", async () => {
    let updatedInputSeen: unknown;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const input = {
          questions: [
            {
              question: "Which library?",
              header: "Library",
              options: [
                { label: "date-fns", description: "smaller" },
                { label: "luxon", description: "more features" },
              ],
              multiSelect: false,
            },
            {
              question: "Which runtime?",
              header: "Runtime",
              options: [
                { label: "bun", description: "fast" },
                { label: "node", description: "standard" },
              ],
              multiSelect: false,
            },
          ],
        };
        const result = await args.options!.canUseTool!("AskUserQuestion", input, callOpts());
        if (result === null) {
          throw new Error("canUseTool returned null");
        }
        if (result.behavior === "allow") {
          updatedInputSeen = result.updatedInput;
        }
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "pick things");
    await delay();

    const firstRequested = events.find((event) => event.type === "question.requested");
    if (firstRequested === undefined || firstRequested.type !== "question.requested") {
      throw new Error("missing first question.requested event");
    }
    expect(firstRequested.payload.text).toBe("Which library?");

    await provider.answerQuestion(session.id, { questionId: firstRequested.payload.questionId, optionId: "opt_1" });
    await delay();

    const secondRequested = events.filter((event) => event.type === "question.requested")[1];
    if (secondRequested === undefined || secondRequested.type !== "question.requested") {
      throw new Error("missing second question.requested event");
    }
    expect(secondRequested.payload.text).toBe("Which runtime?");

    await provider.answerQuestion(session.id, { questionId: secondRequested.payload.questionId, optionId: "opt_0" });
    await delay();

    expect(updatedInputSeen).toMatchObject({
      answers: { "Which library?": "luxon", "Which runtime?": "bun" },
    });
  });

  test("answerQuestion throws for an unknown questionId (E-012)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const input = {
          questions: [
            {
              question: "Which library?",
              header: "Library",
              options: [
                { label: "date-fns", description: "smaller" },
                { label: "luxon", description: "more features" },
              ],
              multiSelect: false,
            },
          ],
        };
        await args.options!.canUseTool!("AskUserQuestion", input, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "pick a library");
    await delay();

    await expect(
      provider.answerQuestion(session.id, { questionId: "bogus", optionId: "opt_0" }),
    ).rejects.toThrow(/no pending question/);
  });

  test("answerQuestion throws for an unknown optionId and leaves the question pending (E-018)", async () => {
    let updatedInputSeen: unknown;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const input = {
          questions: [
            {
              question: "Which library?",
              header: "Library",
              options: [
                { label: "date-fns", description: "smaller" },
                { label: "luxon", description: "more features" },
              ],
              multiSelect: false,
            },
          ],
        };
        const result = await args.options!.canUseTool!("AskUserQuestion", input, callOpts());
        if (result === null) {
          throw new Error("canUseTool returned null");
        }
        if (result.behavior === "allow") {
          updatedInputSeen = result.updatedInput;
        }
        yield fakeResult("picked");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "pick a library");
    await delay();
    const requested = events.find((event) => event.type === "question.requested");
    if (requested === undefined || requested.type !== "question.requested") {
      throw new Error("no question.requested event was emitted");
    }

    await expect(
      provider.answerQuestion(session.id, { questionId: requested.payload.questionId, optionId: "opt_9" }),
    ).rejects.toBeInstanceOf(ApprovalBindingMismatchError);

    // The canUseTool promise must still be unresolved: the invalid answer did not consume the
    // pending question, so updatedInputSeen was never set and the SDK's turn hasn't advanced.
    expect(updatedInputSeen).toBeUndefined();

    await provider.answerQuestion(session.id, { questionId: requested.payload.questionId, optionId: "opt_1" });
    await delay();
    expect(updatedInputSeen).toMatchObject({ answers: { "Which library?": "luxon" } });
  });

  test("approve/reject/sendPrompt throw for an unknown session id (E-013)", async () => {
    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: (() => {
        throw new Error("query() should not be called");
      }) as unknown as QueryFn,
    });
    const fakeBinding: ApprovalBinding = {
      approvalId: "apr_x",
      sessionId: "ses_missing",
      turnId: "trn_x",
      toolCallId: "tc_x",
      actionDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    await expect(provider.sendPrompt("ses_missing", "hi")).rejects.toBeInstanceOf(UnknownSessionError);
    await expect(provider.approve("ses_missing", fakeBinding)).rejects.toBeInstanceOf(UnknownSessionError);
    await expect(provider.reject("ses_missing", fakeBinding)).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test("cancel throws for an unknown session id instead of emitting a phantom session.completed (E-014)", async () => {
    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: (() => {
        throw new Error("query() should not be called");
      }) as unknown as QueryFn,
    });

    await expect(provider.cancel("ses_missing")).rejects.toBeInstanceOf(UnknownSessionError);
    expect(events.some((event) => event.type === "session.completed")).toBe(false);
  });

  test("an approval title for a Bash call reflects the command, matching the digested actionText (R-028)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "rm -rf /tmp/x" }, callOpts());
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "clean up");
    await delay();

    const requested = events.find((event) => event.type === "approval.requested");
    expect(requested?.payload).toMatchObject({ title: "rm -rf /tmp/x" });
  });

  test("a generator that ends mid-turn without a result is treated as an abnormal teardown (R-031)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        // Ends without ever yielding a `result`: the turn is still in progress.
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();

    const types = events.map((event) => event.type);
    expect(types).toContain("error");
    expect(types).toContain("session.completed");
    expect((await provider.listSessions()).map((s) => s.id)).not.toContain(session.id);
  });

  test("a session whose stream is still open stays live after a normal result (R-031)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield fakeResult("done");
        // The stream stays open after the result, which is the only case in which the session may
        // keep serving prompts: an ended stream is torn down (see the R-031 idle-end test).
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("session.completed");
    expect(types).not.toContain("error");
    expect((await provider.listSessions()).map((s) => s.id)).toContain(session.id);
  });

  test("aborting a pending canUseTool call releases the interaction lock for the next call (R-032)", async () => {
    const controller = new AbortController();
    let secondResolved: PermissionResult | null | undefined;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const first = args.options!.canUseTool!("Bash", { command: "one" }, callOpts({ signal: controller.signal }));
        // Let the interaction lock actually register the pending approval (emitting
        // `approval.requested`) before aborting, so this exercises "abort while pending" rather
        // than an abort that beats registration.
        await delay(5);
        controller.abort();
        await first;
        const second = await args.options!.canUseTool!("Bash", { command: "two" }, callOpts());
        secondResolved = second;
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run two things");
    await delay();

    // The second call is only ever reached if the abort released the interaction lock rather
    // than leaving `pendingApproval` occupied forever.
    const requestedForSecond = events.find(
      (event) => event.type === "approval.requested" && event.payload.title === "two",
    );
    expect(requestedForSecond).toBeDefined();
    if (requestedForSecond !== undefined && requestedForSecond.type === "approval.requested") {
      await provider.approve(session.id, requestedForSecond.payload.binding);
      await delay();
    }
    expect(secondResolved).toMatchObject({ behavior: "allow" });
  });

  test("listSessions(projectId) filters to sessions in that project (R-037)", async () => {
    const queryFn: QueryFn = (() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Never yields: no prompt is sent in this test, so nothing should be read from it. The
        // stream stays open, since an ended stream tears its session down (R-031).
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;
    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1"), project("p2", "/tmp/p2")],
      query: queryFn,
    });

    const s1 = await provider.createSession("p1");
    const s2 = await provider.createSession("p2");

    const p1Sessions = await provider.listSessions("p1");
    expect(p1Sessions.map((s) => s.id)).toEqual([s1.id]);
    const p2Sessions = await provider.listSessions("p2");
    expect(p2Sessions.map((s) => s.id)).toEqual([s2.id]);
    const allSessions = await provider.listSessions();
    expect(allSessions.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
  });

  test("session.state tracks the conversation through prompt, pending approval, approve, and result (R-038)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const result = await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        yield fakeResult(result?.behavior === "allow" ? "ran ls" : "denied");
        // Held open so the session is still live for the post-result state assertion: an ended
        // stream tears its session down (R-031).
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");
    expect(session.state).toBe("idle");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    const midFlight = (await provider.listSessions()).find((s) => s.id === session.id);
    expect(midFlight?.state).toBe("waiting");

    const binding = bindingOf(events);
    await provider.approve(session.id, binding);
    await delay();

    const afterResult = (await provider.listSessions()).find((s) => s.id === session.id);
    expect(afterResult?.state).toBe("idle");
  });

  test("only the last assistant text block before the result is marked final (R-039)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield fakeAssistant("first block", "u1");
        yield fakeAssistant("second block", "u2");
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();

    const messages = events.filter((event) => event.type === "agent.message");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.payload).toMatchObject({ text: "first block", final: false });
    expect(messages[1]?.payload).toMatchObject({ text: "second block", final: true });
  });
  test("a generator that ends while idle still tears the conversation down (R-031)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        yield fakeResult("done");
        // Ends right after a normal result: no turn is in progress, but the subprocess behind the
        // generator is gone all the same, so the conversation cannot serve another prompt.
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.completed");
    const completed = events.find((event) => event.type === "session.completed");
    expect(completed?.payload).toMatchObject({ reason: "completed", message: "provider stream ended" });
    expect((await provider.listSessions()).map((s) => s.id)).not.toContain(session.id);
    // The point of the teardown: the next prompt fails fast instead of hanging on an iterable
    // nothing is reading any more.
    await expect(provider.sendPrompt(session.id, "again")).rejects.toBeInstanceOf(UnknownSessionError);
  });

  test("a stream that fails as part of a concurrent cancel does not emit a fatal error (R-041)", async () => {
    // A `Query` double whose pending `next()` rejects when the handle is disposed: exactly what a
    // cancel does to the pump, which must not be reported as a crash the session never had.
    const queryFn: QueryFn = (() => {
      let rejectNext: ((error: unknown) => void) | undefined;
      const query = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () =>
          new Promise<IteratorResult<SDKMessage, void>>((_resolve, reject) => {
            rejectNext = reject;
          }),
        return: async () => {
          rejectNext?.(new Error("stream torn down"));
          return { done: true as const, value: undefined };
        },
        interrupt: async () => undefined,
      };
      return query as unknown as Query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.cancel(session.id);
    await delay();

    const fatal = events.filter((event) => event.type === "error" && event.payload.fatal);
    expect(fatal).toHaveLength(0);
    const completions = events.filter((event) => event.type === "session.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({ reason: "cancelled" });
  });

  test("createSession refuses to exceed maxSessions (R-042)", async () => {
    const queryFn: QueryFn = (() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      maxSessions: 1,
      // The held-open generator never acknowledges disposal, so the cancel below relies on the
      // teardown timeout rather than waiting out the production default.
      terminateTimeoutMs: 20,
    });
    const first = await provider.createSession("p1");

    await expect(provider.createSession("p1")).rejects.toBeInstanceOf(SessionLimitError);
    // Cancelling frees the slot, so the cap bounds live sessions rather than total creations.
    await provider.cancel(first.id);
    await expect(provider.createSession("p1")).resolves.toMatchObject({ projectId: "p1" });
  });

  test("session ids do not collide across provider instances (simulated restarts)", async () => {
    const queryFn: QueryFn = (() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    // A fresh instance mimics the bridge restarting; a per-instance counter would hand out the
    // same first id (`ses_1`) again, colliding with a session recorded before the restart.
    const { host: hostA } = createHost();
    const providerA = new ClaudeProvider(hostA, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const sessionA = await providerA.createSession("p1");

    const { host: hostB } = createHost();
    const providerB = new ClaudeProvider(hostB, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const sessionB = await providerB.createSession("p1");

    expect(sessionB.id).not.toBe(sessionA.id);
  });

  test("seedSession refuses to exceed maxSessions (R2-001)", async () => {
    const queryFn: QueryFn = (() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      maxSessions: 1,
    });
    await provider.createSession("p1");

    const now = new Date().toISOString();
    expect(() =>
      provider.seedSession({
        id: "ses_seed",
        projectId: "p1",
        provider: "claude",
        state: "idle",
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow(SessionLimitError);
    expect(await provider.listSessions()).toHaveLength(1);
  });

  test("a synchronous queryFn throw during createSession leaves no phantom session behind (R1-001)", async () => {
    let calls = 0;
    const queryFn: QueryFn = (() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("sdk validation error");
      }
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      maxSessions: 1,
    });

    await expect(provider.createSession("p1")).rejects.toThrow("sdk validation error");
    // The failed create must not leave a phantom entry counting against maxSessions or showing
    // up in listSessions.
    expect(await provider.listSessions()).toHaveLength(0);
    await expect(provider.createSession("p1")).resolves.toMatchObject({ projectId: "p1" });
  });

  test("a pending question force-resolved by teardown is reported to the client (R-043)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "Which one?", options: [{ label: "a" }, { label: "b" }] }] },
          callOpts(),
        );
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "pick one");
    await delay();
    const requested = events.find((event) => event.type === "question.requested");
    expect(requested).toBeDefined();

    await provider.cancel(session.id);
    await delay();

    // Without an outcome event for the question the watch would keep showing its card forever.
    const answered = events.find((event) => event.type === "question.answered");
    expect(answered?.payload).toMatchObject({
      questionId: requested?.type === "question.requested" ? requested.payload.questionId : "",
      answer: "(session terminated)",
    });
  });

  test("a cancel whose interrupt times out is not reported as a clean cancel (R-044)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await new Promise<void>(() => {});
      }
      const wrapped = asQuery(gen());
      // Simulates a wedged subprocess: `interrupt()` never settles, so the timeout fires.
      wrapped.query.interrupt = (() => new Promise(() => {})) as Query["interrupt"];
      return wrapped.query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, {
      projects: [project("p1", "/tmp/p1")],
      query: queryFn,
      terminateTimeoutMs: 20,
    });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();
    await provider.cancel(session.id);

    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.payload).toMatchObject({ code: "provider_error", fatal: false });
    expect(errorEvent?.type === "error" ? errorEvent.payload.message : "").toContain("interrupt failed");
    // The terminal event has to carry the failure: the interrupted work may still be running.
    expect(events.find((event) => event.type === "session.completed")?.payload).toMatchObject({
      reason: "cancelled",
      message: "interrupt_timeout",
    });
  });

  test("approving an approval puts the session back to running for the rest of the turn (R-045)", async () => {
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts());
        // Keeps the turn in progress after the approval, so the session's state after approve is
        // observable rather than immediately overwritten by a result.
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    expect((await provider.listSessions()).find((s) => s.id === session.id)?.state).toBe("waiting");

    await provider.approve(session.id, bindingOf(events));
    await delay();

    // "waiting" means a decision is pending; the agent is working again, so it must not stay set.
    expect((await provider.listSessions()).find((s) => s.id === session.id)?.state).toBe("running");
  });

  test("the fallback turnId is a fresh id per turn, not a reused counter value (R-046)", async () => {
    const queryFn: QueryFn = (() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Results with no matching sendPrompt: `conversation.turnId` is undefined, so both turn
        // ids come from the fallback.
        yield fakeResult("first");
        yield fakeResult("second");
        await new Promise<void>(() => {});
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    await provider.createSession("p1");
    await delay();

    const turnIds = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => (event.type === "turn.completed" ? event.payload.turnId : ""));
    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
  });

  test("a result message delivered after teardown began emits no turn.completed (entry E-003)", async () => {
    // A hand-rolled Query fake, not `asQuery(gen())`: exercising the real race needs independent
    // control over when the pump loop's pending `next()` resolves versus when `return()`
    // resolves, which a real async generator's own return-abort semantics would not give us.
    const queue: SDKMessage[] = [];
    const waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
    let releaseReturn: (() => void) | undefined;
    const query = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<SDKMessage>> {
        const item = queue.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        return new Promise((resolve) => waiters.push(resolve));
      },
      return(value: void): Promise<IteratorResult<SDKMessage, void>> {
        return new Promise((resolve) => {
          releaseReturn = () => resolve({ value, done: true });
        });
      },
      interrupt: async () => undefined,
    } as unknown as Query;
    const push = (message: SDKMessage): void => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ value: message, done: false });
        return;
      }
      queue.push(message);
    };

    const queryFn: QueryFn = (() => query) as QueryFn;
    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "go");
    await delay();

    const cancelPromise = provider.cancel(session.id);
    // Lets `cancel()` run past `interrupt()` and into `terminateConversation`, which marks the
    // conversation `terminal` synchronously and then blocks on `queryHandle.return()` (held open
    // above), mirroring `queryHandle.return()` racing a buffered `result` message that was already
    // about to be yielded.
    await delay();

    push(fakeResult("too late"));
    await delay();

    releaseReturn?.();
    await cancelPromise;
    await delay();

    expect(events.map((event) => event.type)).not.toContain("turn.completed");
    expect(events.filter((event) => event.type === "session.completed")).toHaveLength(1);
  });

  test("a truncated approval detail carries a marker; the digest stays computed over the truncated title (entry E-004)", async () => {
    const longCommand = `echo ${"x".repeat(250)}`;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        const result = await args.options!.canUseTool!("Bash", { command: longCommand }, callOpts());
        yield fakeResult(result?.behavior === "allow" ? "ran it" : "denied");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run the long command");
    await delay();

    const requested = events.find((event) => event.type === "approval.requested");
    if (requested === undefined || requested.type !== "approval.requested") {
      throw new Error("no approval.requested event was emitted");
    }
    // The title (and the digest computed over it) stay truncated to the same 200-char text as
    // before; only `detail` gains a visible marker of how much was cut.
    expect(requested.payload.title.length).toBeLessThan(longCommand.length);
    expect(requested.payload.detail).toContain("more chars");
    expect(requested.payload.binding.actionDigest).toBe(digest(requested.payload.title));
  });

  test("abort of a pending question restores the session to running, not stuck waiting (entry E-005)", async () => {
    const controller = new AbortController();
    let releaseTurn: (() => void) | undefined;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!(
          "AskUserQuestion",
          { questions: [{ question: "Which one?", options: [{ label: "a" }], multiSelect: false }] },
          callOpts({ signal: controller.signal }),
        );
        // Holds the turn open past the abort so the test can observe the state restored to
        // `running` before the turn's own `result` message would set it to `idle` anyway.
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "ask something");
    await delay();
    expect((await provider.listSessions()).find((s) => s.id === session.id)?.state).toBe("waiting");
    expect(events.map((event) => event.type)).toContain("question.requested");

    // The SDK gives up on this specific question (not the whole session): the conversation keeps
    // going, so `waiting` must come back to `running` rather than sticking around stale.
    controller.abort();
    await delay();

    expect((await provider.listSessions()).find((s) => s.id === session.id)?.state).toBe("running");
    releaseTurn?.();
  });

  test("abort of a pending approval restores the session to running, not stuck waiting (entry E-006)", async () => {
    const controller = new AbortController();
    let releaseTurn: (() => void) | undefined;
    const queryFn: QueryFn = ((args) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        await readPrompt(args.prompt as AsyncIterable<SDKUserMessage>);
        await args.options!.canUseTool!("Bash", { command: "ls" }, callOpts({ signal: controller.signal }));
        // Same reasoning as the question test above: keeps the turn open past the abort so the
        // restored state can be observed before the turn's `result` sets it to `idle`.
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        yield fakeResult("done");
      }
      return asQuery(gen()).query;
    }) as QueryFn;

    const { host, events } = createHost();
    const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
    const session = await provider.createSession("p1");

    await provider.sendPrompt(session.id, "run ls");
    await delay();
    expect((await provider.listSessions()).find((s) => s.id === session.id)?.state).toBe("waiting");
    expect(events.map((event) => event.type)).toContain("approval.requested");

    // Same reasoning as the question case: the SDK abandoning this one tool call does not end the
    // conversation, so `waiting` must come back to `running`.
    controller.abort();
    await delay();

    expect((await provider.listSessions()).find((s) => s.id === session.id)?.state).toBe("running");
    releaseTurn?.();
  });
  test("an emit the bridge cannot persist does not reject unhandled: it is logged and the session fails (entry R-041)", async () => {
    // `ProviderHost.emit` throws when the event log append fails. The message pump runs
    // fire-and-forget, so before the fix that throw became an unhandled rejection that could
    // take the whole bridge process down on a disk error.
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const logged: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      // Both the event the pump tries to emit and the `error` event its own failure path would
      // fall back to: before the fix that second throw escaped the unawaited pump as an
      // unhandled rejection.
      const { host, events } = createFailingHost(["agent.message", "error"]);
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        yield fakeAssistant("hello", "m1");
        yield fakeResult("done");
      }
      const { query } = asQuery(gen());
      const queryFn: QueryFn = (() => query) as QueryFn;
      const provider = new ClaudeProvider(host, { projects: [project("p1", "/tmp/p1")], query: queryFn });
      const session = await provider.createSession("p1");

      await provider.sendPrompt(session.id, "go");
      await delay();
      await delay();

      expect(rejections).toEqual([]);
      // Not swallowed: the failure names the session and the event that was lost.
      expect(logged.some((line) => line.includes(session.id) && line.includes("agent.message"))).toBe(true);
      // Defined state: the session is torn down rather than left running with a hole in its
      // event stream that the client's cursor cannot detect.
      expect(await provider.listSessions()).toHaveLength(0);
      expect(events.map((event) => event.type)).not.toContain("turn.completed");
      await expect(provider.sendPrompt(session.id, "again")).rejects.toBeInstanceOf(UnknownSessionError);
    } finally {
      console.error = realConsoleError;
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

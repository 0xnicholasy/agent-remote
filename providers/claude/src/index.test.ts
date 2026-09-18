import { describe, expect, test } from "bun:test";
import {
  ApprovalBindingMismatchError,
  InteractionPendingError,
  TurnInProgressError,
  UnknownSessionError,
} from "@agentremote/protocol";
import type { AgentEvent, ApprovalBinding, Project, ProviderHost } from "@agentremote/protocol";
import type { CanUseTool, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

    await expect(provider.approve(session.id, binding)).rejects.toBeInstanceOf(ApprovalBindingMismatchError);
    expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({ decision: "expired" });
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
});

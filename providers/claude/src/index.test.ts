import { describe, expect, test } from "bun:test";
import { ApprovalBindingMismatchError, InteractionPendingError } from "@agentremote/protocol";
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

function callOpts(overrides: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: "tc_1",
    requestId: "req_1",
    ...overrides,
  } as Parameters<CanUseTool>[2];
}

/** Turns a plain async generator into a test double for `Query`: the provider only calls
 * `for await` iteration and `interrupt()` on it, so the rest of the real `Query` interface is
 * cast past rather than implemented. */
function asQuery(gen: AsyncGenerator<SDKMessage, void>): { query: Query; interrupted: () => boolean } {
  let interrupted = false;
  const query = gen as unknown as Query;
  query.interrupt = async () => {
    interrupted = true;
    return undefined;
  };
  return { query, interrupted: () => interrupted };
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
    await expect(provider.approve(session.id, binding)).rejects.toBeInstanceOf(ApprovalBindingMismatchError);
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
});

/**
 * Manual M2 harness: starts the bridge in-process with the real `ClaudeProvider` (the real
 * Claude Agent SDK `query`, not the test fake) against a temp project directory, sends one
 * prompt, auto-approves the first approval it sees, and prints every event as one JSON line.
 *
 * Run with: `bun run providers/claude/loopback.ts`
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentEventPayloadMap,
  AgentEventType,
  ProviderHost,
  Session,
} from "@agentremote/protocol";

import { ClaudeProvider } from "./src/index";

const TIMEOUT_MS = 120_000;
const PROMPT = "Create a file named hello.txt containing the word hello";

async function main(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "agentremote-loopback-"));

  const log: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  let nextEventId = 1;

  const wake = (): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter();
    }
  };

  const host: ProviderHost = {
    emit<T extends AgentEventType>(sessionId: string, type: T, payload: AgentEventPayloadMap[T]): AgentEvent {
      const event = {
        eventId: nextEventId++,
        sessionId,
        provider: "claude",
        type,
        timestamp: new Date().toISOString(),
        payload,
      } as AgentEventEnvelope<T> as AgentEvent;
      log.push(event);
      console.log(JSON.stringify(event));
      wake();
      return event;
    },
    eventsAfter(after: number): AgentEvent[] {
      return log.filter((event) => event.eventId > after);
    },
    waitForChange(timeoutMs: number): Promise<void> {
      return new Promise((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };

  const provider = new ClaudeProvider(host, {
    projects: [{ id: "prj_loopback", name: "loopback", path: projectDir }],
  });

  let session: Session;
  try {
    session = await provider.createSession("prj_loopback");
  } catch (error) {
    console.error("Failed to create session:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let approved = false;
  let done = false;

  try {
    await provider.sendPrompt(session.id, PROMPT);

    let cursor = 0;
    while (!done && Date.now() < deadline) {
      const batch = host.eventsAfter(cursor).filter((event) => event.sessionId === session.id);
      for (const event of batch) {
        cursor = Math.max(cursor, event.eventId);
        if (event.type === "turn.completed") {
          done = true;
        }
        if (event.type === "error" && event.payload.fatal) {
          done = true;
        }
        if (!approved && event.type === "approval.requested") {
          approved = true;
          await provider.approve(session.id, event.payload.binding);
        }
      }
      if (!done) {
        await host.waitForChange(1000);
      }
    }

    if (!done) {
      console.error(`Timed out after ${TIMEOUT_MS}ms waiting for turn.completed`);
      process.exitCode = 1;
    }
  } finally {
    // The SDK subprocess (queryHandle, started in createSession) and the pumpMessages loop keep
    // the process referenced even after the turn completes or times out, so the harness would
    // otherwise hang on exit instead of returning from main(). `cancel` interrupts and disposes
    // it whether we got a clean `turn.completed` or hit the deadline.
    await provider.cancel(session.id).catch(() => {
      // Best effort: the conversation may already be terminal (turn.completed's error path).
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });

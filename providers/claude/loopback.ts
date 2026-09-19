/**
 * M2 loopback harness: drives the real `ClaudeProvider` (the real Claude Agent SDK `query`,
 * not the test fake) against a fresh temp project directory and proves each interactive
 * semantic the M2 exit gate names: prompt, approval, rejection, provider question, answer by
 * option, answer by supplied text plus a follow-up turn, and interrupt.
 *
 * Every scenario runs in its own session and its own temp directory, prints each event as one
 * JSON line prefixed with the scenario name, and checks a small set of expectations. The
 * process exits non-zero if any scenario fails.
 *
 * Run with:
 *   bun run providers/claude/loopback.ts            # every scenario
 *   bun run providers/claude/loopback.ts reject     # one or more named scenarios
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnknownSessionError } from "@agentremote/protocol";
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentEventPayloadMap,
  AgentEventType,
  ProviderHost,
} from "@agentremote/protocol";

import { ClaudeProvider } from "./src/index";

/** Per-scenario ceiling. A real turn with one approval took about 20 s in the first M2 run. */
const SCENARIO_TIMEOUT_MS = 180_000;
/** Ceiling for a single `waitFor`, kept below the scenario ceiling so a stall names the event. */
const WAIT_TIMEOUT_MS = 120_000;

const WRITE_PROMPT = "Create a file named hello.txt containing the word hello. Do not read or write any other file.";
const QUESTION_PROMPT =
  "Use the AskUserQuestion tool to ask me which filename to use, with exactly two options: " +
  "alpha.txt and beta.txt. Do not create, read or write any file; after I answer, reply with " +
  "the filename I picked and nothing else.";
const BASH_PROMPT = "Using the Bash tool, run `echo hello-from-bash`. Use no other tool.";
const SLOW_PROMPT =
  "Write a detailed 2000-word essay about the history of timekeeping, from sundials to atomic " +
  "clocks. Use no tools; write the whole essay in your reply.";

class ScenarioFailure extends Error {}

/**
 * One scenario's session: an in-process event log that plays the bridge's role, plus the
 * waiting helpers a scenario needs to react to the provider the way a Watch client would.
 */
class Harness {
  readonly events: AgentEvent[] = [];
  readonly provider: ClaudeProvider;
  readonly projectDir: string;

  private readonly waiters = new Set<() => void>();
  private nextEventId = 1;
  /** Events before this id have already been matched by an earlier `waitFor`. */
  private cursor = 0;
  private sessionId: string | undefined;
  /** Most recent non-fatal `error` event seen by `waitFor`, surfaced if the wait times out. */
  private lastNonFatalError: AgentEventEnvelope<"error"> | undefined;
  /** Set once `dispose` has run, so a second call (e.g. an early timeout teardown followed by
   * the runner's own cleanup) is a no-op instead of a spurious second cancel. */
  private disposed = false;

  constructor(
    private readonly name: string,
    projectDir: string,
  ) {
    this.projectDir = projectDir;
    const host: ProviderHost = {
      emit: <T extends AgentEventType>(
        sessionId: string,
        type: T,
        payload: AgentEventPayloadMap[T],
      ): AgentEvent => {
        const event = {
          eventId: this.nextEventId++,
          sessionId,
          provider: "claude",
          type,
          timestamp: new Date().toISOString(),
          payload,
        } as AgentEventEnvelope<T> as AgentEvent;
        this.events.push(event);
        console.log(`[${this.name}] ${JSON.stringify(event)}`);
        this.wake();
        return event;
      },
      eventsAfter: (after: number): AgentEvent[] => this.events.filter((event) => event.eventId > after),
      waitForChange: (timeoutMs: number): Promise<void> =>
        new Promise((resolve) => {
          const waiter = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.waiters.delete(waiter);
            resolve();
          }, timeoutMs);
          this.waiters.add(waiter);
        }),
    };

    this.provider = new ClaudeProvider(host, {
      projects: [{ id: "prj_loopback", name: "loopback", path: projectDir }],
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter();
    }
  }

  get session(): string {
    if (this.sessionId === undefined) {
      throw new ScenarioFailure("session was not created");
    }
    return this.sessionId;
  }

  async createSession(): Promise<void> {
    const session = await this.provider.createSession("prj_loopback");
    this.sessionId = session.id;
  }

  /**
   * Resolves with the first event of `type` at or after the scan cursor, advancing the cursor
   * past it. A `fatal` `error` event aborts the wait so a provider error fails fast with its
   * real message instead of the caller timing out waiting for something that will never
   * arrive. A non-fatal `error` event does not abort the wait (some scenarios, e.g. `cancel`,
   * emit one before the event the scenario is actually waiting for) but is recorded so a
   * subsequent timeout can name it instead of failing with a bare timeout message.
   */
  async waitFor<T extends AgentEventType>(type: T, timeoutMs = WAIT_TIMEOUT_MS): Promise<AgentEventEnvelope<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const event of this.events) {
        if (event.eventId <= this.cursor || event.sessionId !== this.sessionId) {
          continue;
        }
        if (event.type === type) {
          this.cursor = event.eventId;
          return event as AgentEventEnvelope<T>;
        }
        if (event.type === "error") {
          this.cursor = event.eventId;
          if (event.payload.fatal) {
            throw new ScenarioFailure(`fatal provider error while waiting for ${type}: ${event.payload.message}`);
          }
          this.lastNonFatalError = event as AgentEventEnvelope<"error">;
          console.log(`[${this.name}] non-fatal provider error while waiting for ${type}: ${event.payload.message}`);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const cause = this.lastNonFatalError
          ? `; last non-fatal provider error: ${this.lastNonFatalError.payload.message}`
          : "";
        throw new ScenarioFailure(`timed out after ${timeoutMs}ms waiting for ${type}${cause}`);
      }
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(waiter);
          resolve();
        }, Math.min(remaining, 1000));
        this.waiters.add(waiter);
      });
    }
  }

  /** Every event of `type` seen so far, in order, ignoring the scan cursor. */
  seen<T extends AgentEventType>(type: T): AgentEventEnvelope<T>[] {
    return this.events.filter((event) => event.type === type) as AgentEventEnvelope<T>[];
  }

  /** Resolves to a message describing a teardown failure, or `undefined` if teardown was clean. */
  async dispose(): Promise<string | undefined> {
    if (this.sessionId === undefined || this.disposed) {
      return undefined;
    }
    this.disposed = true;
    return this.provider.cancel(this.sessionId).then(
      () => undefined,
      (error: unknown) => {
        // Already finished or already cancelled is fine: the provider answers a cancel for a
        // terminal conversation with `UnknownSessionError`, and a scenario that cancels on its
        // own (e.g. `interrupt`) leaves exactly that state behind. Anything else is worth
        // knowing about, and must not be reported as a clean pass by the caller.
        if (error instanceof UnknownSessionError) {
          return undefined;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${this.name}] dispose: cancel failed:`, error);
        return `dispose: cancel failed: ${message}`;
      },
    );
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new ScenarioFailure(message);
  }
}

interface Scenario {
  name: string;
  /** What this scenario is evidence for, printed in the summary. */
  proves: string;
  run(harness: Harness): Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "approve",
    proves: "prompt, approval accepted, tool executed, agent response, turn completed",
    async run(harness) {
      await harness.provider.sendPrompt(harness.session, WRITE_PROMPT);
      await harness.waitFor("turn.started");

      const requested = await harness.waitFor("approval.requested");
      await harness.provider.approve(harness.session, requested.payload.binding);

      const resolved = await harness.waitFor("approval.resolved");
      check(resolved.payload.decision === "accepted", `expected an accepted approval, got ${resolved.payload.decision}`);

      await harness.waitFor("turn.completed");
      check(harness.seen("agent.message").length > 0, "expected at least one agent.message");

      const path = join(harness.projectDir, "hello.txt");
      check(existsSync(path), `expected the approved write to create ${path}`);
      const contents = (await readFile(path, "utf8")).trim();
      check(contents.includes("hello"), `expected hello.txt to contain "hello", got ${JSON.stringify(contents)}`);
    },
  },
  {
    name: "reject",
    proves: "approval rejected, the tool call is declined, the turn still completes",
    async run(harness) {
      await harness.provider.sendPrompt(harness.session, WRITE_PROMPT);
      await harness.waitFor("turn.started");

      const requested = await harness.waitFor("approval.requested");
      await harness.provider.reject(harness.session, requested.payload.binding, "not from the watch");

      const resolved = await harness.waitFor("approval.resolved");
      check(resolved.payload.decision === "rejected", `expected a rejected approval, got ${resolved.payload.decision}`);

      await harness.waitFor("turn.completed");
      check(
        !existsSync(join(harness.projectDir, "hello.txt")),
        "expected no file after the only write was rejected",
      );
    },
  },
  {
    name: "question",
    proves: "provider question, answered by option id, turn completed",
    async run(harness) {
      await harness.provider.sendPrompt(harness.session, QUESTION_PROMPT);
      await harness.waitFor("turn.started");

      const requested = await harness.waitFor("question.requested");
      check(requested.payload.options.length >= 2, "expected at least two options on the question");
      const chosen = requested.payload.options[0]!;
      await harness.provider.answerQuestion(harness.session, {
        questionId: requested.payload.questionId,
        optionId: chosen.id,
      });

      const answered = await harness.waitFor("question.answered");
      check(
        answered.payload.questionId === requested.payload.questionId,
        "question.answered carried a different questionId",
      );

      await harness.waitFor("turn.completed");
      const reply = harness.seen("agent.message").map((event) => event.payload.text).join("\n");
      check(
        reply.toLowerCase().includes(chosen.label.toLowerCase()),
        `expected the reply to carry the chosen option ${JSON.stringify(chosen.label)}, got ${JSON.stringify(reply)}`,
      );
    },
  },
  {
    name: "freetext",
    proves: "question answered with supplied text, then a follow-up turn in the same session",
    async run(harness) {
      await harness.provider.sendPrompt(harness.session, QUESTION_PROMPT);
      await harness.waitFor("turn.started");

      const requested = await harness.waitFor("question.requested");
      check(requested.payload.allowFreeText, "expected allowFreeText on a provider question");
      await harness.provider.answerQuestion(harness.session, {
        questionId: requested.payload.questionId,
        text: "gamma.txt",
      });

      const answered = await harness.waitFor("question.answered");
      check(answered.payload.answer.includes("gamma.txt"), `expected the supplied text in the answer, got ${answered.payload.answer}`);
      await harness.waitFor("turn.completed");

      // Follow-up turn: the same conversation must still hold what was answered mid-turn.
      await harness.provider.sendPrompt(
        harness.session,
        "Which filename did I pick? Reply with the filename and nothing else.",
      );
      await harness.waitFor("turn.started");
      await harness.waitFor("turn.completed");

      const reply = harness.seen("agent.message").map((event) => event.payload.text).join("\n");
      check(reply.includes("gamma.txt"), `expected the follow-up reply to recall gamma.txt, got ${JSON.stringify(reply)}`);
      check(harness.seen("turn.started").length === 2, "expected exactly two turns in the follow-up scenario");
    },
  },
  {
    name: "bash",
    proves: "a shell command reaches the watch as an approval instead of running unattended",
    async run(harness) {
      await harness.provider.sendPrompt(harness.session, BASH_PROMPT);
      await harness.waitFor("turn.started");

      // The SDK auto-allows a sandboxable Bash command unless the adapter turns that off, in
      // which case nothing here would ever be emitted and this wait would time out.
      const requested = await harness.waitFor("approval.requested");
      check(
        requested.payload.kind === "command",
        `expected a Bash approval of kind "command", got ${JSON.stringify(requested.payload.kind)}`,
      );
      await harness.provider.approve(harness.session, requested.payload.binding);
      await harness.waitFor("approval.resolved");
      await harness.waitFor("turn.completed");
    },
  },
  {
    name: "interrupt",
    proves: "cancel interrupts a running turn and ends the session as cancelled",
    async run(harness) {
      await harness.provider.sendPrompt(harness.session, SLOW_PROMPT);
      await harness.waitFor("turn.started");

      // Wait for the first streamed reply chunk instead of guessing with a flat sleep, so the
      // interrupt genuinely lands mid-generation rather than assuming timing.
      await harness.waitFor("agent.message");
      check(
        harness.seen("turn.completed").length === 0,
        "the essay turn finished before it could be interrupted; lengthen SLOW_PROMPT",
      );

      await harness.provider.cancel(harness.session);
      const completed = await harness.waitFor("session.completed", 30_000);
      check(
        completed.payload.reason === "cancelled",
        `expected session.completed reason "cancelled", got ${completed.payload.reason}`,
      );
      check(
        harness.seen("turn.completed").length === 0,
        "expected no turn.completed: the turn was interrupted, not finished",
      );
    },
  },
];

interface ScenarioOutcome {
  name: string;
  proves: string;
  ok: boolean;
  failure?: string | undefined;
  durationMs: number;
}

async function runScenario(scenario: Scenario): Promise<ScenarioOutcome> {
  const projectDir = await mkdtemp(join(tmpdir(), `agentremote-loopback-${scenario.name}-`));
  const harness = new Harness(scenario.name, projectDir);
  const startedAt = Date.now();
  console.log(`[${scenario.name}] project dir: ${projectDir}`);

  let failure: string | undefined;
  try {
    await harness.createSession();
    await withTimeout(scenario.run(harness), SCENARIO_TIMEOUT_MS, `scenario ${scenario.name}`, harness);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    const disposeFailure = await harness.dispose();
    if (disposeFailure !== undefined) {
      failure = failure === undefined ? disposeFailure : `${failure}; ${disposeFailure}`;
    }
  }

  return {
    name: scenario.name,
    proves: scenario.proves,
    ok: failure === undefined,
    failure,
    durationMs: Date.now() - startedAt,
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string, harness: Harness): Promise<T> {
  // If `work` loses the race, it keeps running; mark its eventual rejection handled so it
  // doesn't surface as an unhandled rejection after this function has already returned, but log
  // it so a genuine scenario error is never silently discarded.
  work.catch((error: unknown) => {
    console.error(`[${label}] abandoned scenario rejected:`, error);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Tear the timed-out scenario's session down before the runner proceeds, so it cannot
          // overlap the next scenario's session against a live SDK subprocess. The runner's own
          // `dispose` is a no-op after this one, so a teardown failure here would be lost unless
          // it is carried on the timeout error itself: report both, timeout first.
          void harness.dispose().then(
            (disposeFailure) => {
              const suffix = disposeFailure === undefined ? "" : `; ${disposeFailure}`;
              reject(new ScenarioFailure(`${label} exceeded ${timeoutMs}ms${suffix}`));
            },
            () => reject(new ScenarioFailure(`${label} exceeded ${timeoutMs}ms`)),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const unknown = requested.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown scenario(s): ${unknown.join(", ")}`);
    console.error(`Known scenarios: ${SCENARIOS.map((scenario) => scenario.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const selected = requested.length > 0 ? SCENARIOS.filter((s) => requested.includes(s.name)) : SCENARIOS;
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of selected) {
    outcomes.push(await runScenario(scenario));
  }

  console.log("");
  console.log("M2 loopback results");
  for (const outcome of outcomes) {
    const status = outcome.ok ? "PASS" : "FAIL";
    console.log(`${status}  ${outcome.name.padEnd(10)} ${(outcome.durationMs / 1000).toFixed(1)}s  ${outcome.proves}`);
    if (outcome.failure !== undefined) {
      console.log(`      ${outcome.failure}`);
    }
  }

  if (outcomes.some((outcome) => !outcome.ok)) {
    process.exitCode = 1;
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

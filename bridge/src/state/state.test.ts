import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentEvent } from "@agentremote/protocol";

import { NonceCache } from "../auth/verify";
import { CommandJournal, MAX_COMMANDS } from "./commands";
import { EventLog, MAX_RETAINED_EVENTS } from "./event-log";
import { JsonlJournal } from "./journal";
import { createNonceJournal } from "./nonces";
import { SessionIndex } from "./sessions";

const NOW = new Date("2026-09-20T12:00:00.000Z");

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agentremote-state-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function event(eventId: number, timestamp = NOW.toISOString()): AgentEvent {
  return {
    eventId,
    sessionId: "ses_seed",
    provider: "mock",
    type: "agent.message",
    timestamp,
    payload: { messageId: `msg_${eventId}`, role: "assistant", text: "hi", final: true },
  };
}

function lineCount(filePath: string): number {
  return readFileSync(filePath, "utf8").split("\n").filter((line) => line.length > 0).length;
}

describe("JsonlJournal", () => {
  test("a torn final line costs that record only", () => {
    const filePath = join(stateDir, "journal.jsonl");
    writeFileSync(filePath, '{"a":1}\n{"a":2}\n{"a":3', "utf8");

    expect(new JsonlJournal<{ a: number }>(filePath).load()).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("EventLog", () => {
  test("retention bounds the file and firstEventId reports the gap it leaves", () => {
    const filePath = join(stateDir, "events.jsonl");
    const overflow = MAX_RETAINED_EVENTS + 10;
    writeFileSync(
      filePath,
      Array.from({ length: overflow }, (_unused, index) => `${JSON.stringify(event(index + 1))}\n`).join(""),
      "utf8",
    );

    const log = new EventLog(filePath, { now: NOW });

    expect(log.all().length).toBe(MAX_RETAINED_EVENTS);
    expect(log.firstEventId).toBe(11);
    expect(lineCount(filePath)).toBe(MAX_RETAINED_EVENTS);
  });

  test("an event id is never reused even when the log file itself is lost", () => {
    const filePath = join(stateDir, "events.jsonl");
    const first = new EventLog(filePath, { now: NOW });
    const issued = first.takeEventId();
    first.append(event(issued));

    rmSync(filePath);
    const afterLoss = new EventLog(filePath, { now: NOW });

    // The persisted watermark reserved a block ahead, so ids resume past everything issued.
    expect(afterLoss.takeEventId()).toBeGreaterThan(issued);
  });

  test("an event id is never reused, even when the event that carried it was pruned", () => {
    const filePath = join(stateDir, "events.jsonl");
    const stale = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(filePath, `${JSON.stringify(event(41, stale))}\n${JSON.stringify(event(42, stale))}\n`, "utf8");

    const log = new EventLog(filePath, { now: NOW });

    expect(log.all().length).toBe(0); // both dropped by the 24h window
    expect(log.nextEventId).toBe(43);
  });
});

describe("CommandJournal", () => {
  test("the entry count is capped regardless of how many distinct command ids arrive", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const journal = new CommandJournal(filePath, { now: NOW });

    for (let index = 0; index < MAX_COMMANDS + 50; index += 1) {
      journal.begin(`cmd-${index}`, "dev_a", `digest-${index}`, NOW);
    }

    expect(journal.size()).toBe(MAX_COMMANDS);
    // The oldest ids were evicted, the newest kept.
    expect(journal.get("cmd-0")).toBeUndefined();
    expect(journal.get(`cmd-${MAX_COMMANDS + 49}`)).toBeDefined();
    expect(lineCount(filePath)).toBeLessThanOrEqual(MAX_COMMANDS);
  });

  test("a command left in flight by a dead process becomes indeterminate", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const previous = new CommandJournal(filePath, { now: NOW });
    previous.begin("cmd-1", "dev_a", "digest-a", NOW);

    const reloaded = new CommandJournal(filePath, { now: NOW });

    expect(reloaded.get("cmd-1")?.status).toBe("indeterminate");
  });

  test("a completed command keeps its recorded response across a reload", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const previous = new CommandJournal(filePath, { now: NOW });
    previous.begin("cmd-2", null, "digest-b", NOW);
    previous.complete("cmd-2", { accepted: true, commandId: "cmd-2", duplicate: false }, NOW);

    const reloaded = new CommandJournal(filePath, { now: NOW });
    const entry = reloaded.get("cmd-2");

    expect(entry?.status).toBe("completed");
    expect(entry?.response).toEqual({ accepted: true, commandId: "cmd-2", duplicate: false });
    expect(entry?.digest).toBe("digest-b");
  });

  test("retention drops old commands and compacts the file to one line each", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const journal = new CommandJournal(filePath, { now: NOW });
    journal.begin("cmd-3", null, "digest-c", NOW);
    journal.complete("cmd-3", { accepted: true, commandId: "cmd-3", duplicate: false }, NOW);
    expect(lineCount(filePath)).toBe(2); // append-only until something compacts it

    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    journal.prune(later);

    expect(journal.size()).toBe(0);
    expect(lineCount(filePath)).toBe(0);
  });
});

describe("SessionIndex", () => {
  test("a session's project binding is immutable once recorded", () => {
    const filePath = join(stateDir, "sessions.jsonl");
    const index = new SessionIndex(filePath, { now: NOW });
    index.record("ses_a", "prj_one", NOW);

    index.record("ses_a", "prj_two", NOW);

    // Rebinding would re-scope every retained event of that session for a narrowed device.
    expect(index.projectOf("ses_a")).toBe("prj_one");
    expect(new SessionIndex(filePath, { now: NOW }).projectOf("ses_a")).toBe("prj_one");
  });
});

describe("NonceCache persistence", () => {
  test("a nonce recorded before a restart is still known after it, and an expired one is not", () => {
    const filePath = join(stateDir, "nonces.jsonl");
    const before = new NonceCache({ journal: createNonceJournal(filePath), now: NOW });
    before.record("dev_a", "nonce-fresh", NOW);

    const afterRestart = new NonceCache({ journal: createNonceJournal(filePath), now: NOW });
    expect(afterRestart.has("dev_a", "nonce-fresh", NOW)).toBe(true);

    const muchLater = new Date(NOW.getTime() + 10 * 60 * 1000); // past the 300s nonce TTL
    const afterExpiry = new NonceCache({ journal: createNonceJournal(filePath), now: muchLater });
    expect(afterExpiry.has("dev_a", "nonce-fresh", muchLater)).toBe(false);
    expect(lineCount(filePath)).toBe(0);
  });
});

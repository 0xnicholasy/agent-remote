import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

  test("append after loading a torn tail does not corrupt the new record", () => {
    const filePath = join(stateDir, "journal.jsonl");
    writeFileSync(filePath, '{"a":1}\n{"a":2}\n{"a":3', "utf8");

    const journal = new JsonlJournal<{ a: number }>(filePath);
    expect(journal.load()).toEqual([{ a: 1 }, { a: 2 }]);

    // If the torn bytes were left on disk, this append would land right after them with no
    // separating newline, merging into one corrupt line and losing this record on reload too.
    journal.append({ a: 4 });

    expect(new JsonlJournal<{ a: number }>(filePath).load()).toEqual([{ a: 1 }, { a: 2 }, { a: 4 }]);
  });

  test("a short write is not reported as a successful durable append", () => {
    const filePath = join(stateDir, "journal.jsonl");
    const journal = new JsonlJournal<{ a: number }>(filePath);
    const realWriteSync = fs.writeSync.bind(fs);
    let calls = 0;
    // JsonlJournal only ever calls the buffer form of writeSync, never the string form, so the
    // mock only needs to satisfy that one overload rather than the full overloaded type.
    const bufferOverload: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number | null,
      length?: number | null,
      position?: number | null,
    ) => number = (fd, buffer, offset, length, position) => {
      calls += 1;
      if (calls === 1 && typeof offset === "number" && typeof length === "number") {
        // Simulate the OS accepting fewer bytes than asked for on the first call.
        const shortLength = Math.min(3, length);
        return realWriteSync(fd, buffer, offset, shortLength, position ?? undefined);
      }
      return realWriteSync(fd, buffer, offset as number, length as number, position ?? undefined);
    };
    const writeSpy = spyOn(fs, "writeSync").mockImplementation(
      // Cast is safe: it narrows the mocked overloaded signature down to the single overload
      // (buffer form) this test's production code path actually exercises.
      bufferOverload as typeof fs.writeSync,
    );

    try {
      journal.append({ a: 1 });
    } finally {
      writeSpy.mockRestore();
    }

    // The short first write must have been followed by at least one more to finish the record,
    // and the record on disk must be exactly what was appended, not the first partial chunk.
    expect(calls).toBeGreaterThan(1);
    expect(journal.load()).toEqual([{ a: 1 }]);
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

  test("crossing the append-count compaction threshold rewrites the journal, and logical content survives it", () => {
    const filePath = join(stateDir, "events.jsonl");
    // 999 valid events plus one line load() will silently drop (matching JsonlJournal's "a torn
    // line costs that record only" behavior above). Since nothing is dropped by time or by the
    // retention cap, the constructor does not compact, so the corrupt line stays on disk until
    // the append-count threshold does its own rewrite.
    const seededCount = 999;
    const seedLines = Array.from({ length: seededCount }, (_unused, index) => `${JSON.stringify(event(index + 1))}\n`).join(
      "",
    );
    writeFileSync(filePath, `${seedLines}not-json\n`, "utf8");

    const log = new EventLog(filePath, { now: NOW });
    expect(log.all().length).toBe(seededCount);
    expect(lineCount(filePath)).toBe(seededCount + 1); // the corrupt line is still physically there

    // COMPACT_AFTER_APPENDS is 1000; this is exactly enough new appends to cross it, and stays
    // well under MAX_RETAINED_EVENTS so the separate cap-eviction compaction path never fires.
    for (let index = 0; index < 1000; index += 1) {
      const id = log.takeEventId();
      log.append(event(id));
    }

    expect(log.all().length).toBe(seededCount + 1000);
    // Without the threshold firing, the file would carry the seed's corrupt line plus 1000
    // appended lines (2000). Compaction rewrote it down to exactly the live events (1999).
    expect(lineCount(filePath)).toBe(seededCount + 1000);

    const reloaded = new EventLog(filePath, { now: NOW });
    expect(reloaded.all().map((entry) => entry.eventId)).toEqual(log.all().map((entry) => entry.eventId));
  });

  test("an event whose journal append fails is not left readable in memory, and the caller sees the failure", () => {
    const filePath = join(stateDir, "events.jsonl");
    const log = new EventLog(filePath, { now: NOW });
    const id = log.takeEventId();

    mkdirSync(filePath); // the journal path is now a directory: every append fails

    expect(() => log.append(event(id))).toThrow();

    expect(log.all().length).toBe(0);
    expect(log.after(0)).toEqual([]);
    expect(log.lastEventId).toBe(0);
  });

  test("a corrupt watermark fails loudly instead of reissuing already-issued event ids", () => {
    const filePath = join(stateDir, "events.jsonl");
    const first = new EventLog(filePath, { now: NOW });
    const issued = first.takeEventId();
    first.append(event(issued));

    writeFileSync(`${filePath}.watermark`, "{not json", "utf8");
    expect(() => new EventLog(filePath, { now: NOW })).toThrow(/watermark/);

    writeFileSync(`${filePath}.watermark`, JSON.stringify({ reservedThrough: "lots" }), "utf8");
    expect(() => new EventLog(filePath, { now: NOW })).toThrow(/watermark/);

    // An absent watermark is still a legitimately fresh bridge, not a failure.
    rmSync(`${filePath}.watermark`);
    rmSync(filePath);
    expect(new EventLog(filePath, { now: NOW }).takeEventId()).toBe(1);
  });
});

describe("CommandJournal", () => {
  test("terminal entries past retention are capped, oldest evicted first", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const journal = new CommandJournal(filePath, { now: NOW });
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000); // past the 24h retention window

    for (let index = 0; index < 50; index += 1) {
      journal.begin(`stale-${index}`, "dev_a", `digest-stale-${index}`, stale);
      journal.complete(`stale-${index}`, { accepted: true, commandId: `stale-${index}`, duplicate: false }, stale);
    }
    for (let index = 0; index < MAX_COMMANDS; index += 1) {
      journal.begin(`cmd-${index}`, "dev_a", `digest-${index}`, NOW);
      journal.complete(`cmd-${index}`, { accepted: true, commandId: `cmd-${index}`, duplicate: false }, NOW);
    }

    // Cap pressure evicted exactly the records past retention, oldest first, so the store stays
    // bounded; no retry can still be relying on those.
    expect(journal.size()).toBe(MAX_COMMANDS);
    expect(journal.get("stale-0")).toBeUndefined();
    expect(journal.get("stale-49")).toBeUndefined();
    expect(journal.get("cmd-0")).toBeDefined();
    expect(journal.get(`cmd-${MAX_COMMANDS - 1}`)).toBeDefined();

    // The journal is append-only and only rewrites the file on eviction or every
    // COMPACT_AFTER_APPENDS appends, so a `complete()` right after an eviction-triggered
    // compaction can legitimately leave a stale line on disk until the next rewrite. Asserting an
    // exact on-disk line count at this arbitrary moment would pin that compaction timing rather
    // than the cap, so assert only that the file tracks the live set instead of every append.
    expect(lineCount(filePath)).toBeLessThanOrEqual(MAX_COMMANDS + 2);
  });

  test("a terminal entry still inside its retention window is not evicted by cap pressure", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const journal = new CommandJournal(filePath, { now: NOW });
    const warnings: string[] = [];
    const realWarn = console.warn;
    // Test double for a variadic console method, hence the unknown[] parameter.
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      for (let index = 0; index < MAX_COMMANDS + 10; index += 1) {
        journal.begin(`cmd-${index}`, "dev_a", `digest-${index}`, NOW);
        journal.complete(`cmd-${index}`, { accepted: true, commandId: `cmd-${index}`, duplicate: false }, NOW);
      }
    } finally {
      console.warn = realWarn;
    }

    // A retry of cmd-0 is still legitimate for another 24 hours, so its recorded response has to
    // survive the cap; evicting it would make that retry re-execute the command.
    expect(journal.size()).toBe(MAX_COMMANDS + 10);
    expect(journal.get("cmd-0")?.response).toEqual({ accepted: true, commandId: "cmd-0", duplicate: false });
    expect(journal.get(`cmd-${MAX_COMMANDS + 9}`)).toBeDefined();
    expect(warnings.some((line) => line.includes("terminal but within retention"))).toBe(true);

    // Growth past the cap is temporary: the same records are dropped once they age out.
    journal.prune(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    expect(journal.size()).toBe(0);
    expect(lineCount(filePath)).toBe(0);
  });

  test("in-flight entries are never evicted, even past the cap", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const journal = new CommandJournal(filePath, { now: NOW });

    for (let index = 0; index < MAX_COMMANDS + 50; index += 1) {
      journal.begin(`cmd-${index}`, "dev_a", `digest-${index}`, NOW);
    }

    // No terminal record exists to evict, so the cap is exceeded rather than dropping a live
    // in-flight idempotency record that a retry still depends on.
    expect(journal.size()).toBe(MAX_COMMANDS + 50);
    expect(journal.get("cmd-0")).toBeDefined();
    expect(journal.get(`cmd-${MAX_COMMANDS + 49}`)).toBeDefined();
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

  test("a failed complete() rolls the in-memory record back to the prior durable entry, and still throws", () => {
    const filePath = join(stateDir, "commands.jsonl");
    const journal = new CommandJournal(filePath, { now: NOW });
    journal.begin("cmd-4", "dev_a", "digest-d", NOW);

    // Replace the journal file with a directory of the same name: the next append's openSync
    // call fails with EISDIR, simulating a journal write failure after the in_flight record was
    // already durably persisted.
    rmSync(filePath);
    mkdirSync(filePath);

    expect(() => journal.complete("cmd-4", { accepted: true, commandId: "cmd-4", duplicate: false }, NOW)).toThrow();

    // The pre-existing in_flight record must still be there, not erased by the failed complete():
    // losing it in memory while the journal on disk still has it would let a retry re-execute the
    // command.
    expect(journal.get("cmd-4")).toEqual({
      commandId: "cmd-4",
      deviceId: "dev_a",
      digest: "digest-d",
      status: "in_flight",
      at: NOW.getTime(),
    });
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

  test("crossing the append-count compaction threshold rewrites the journal down to the live set", () => {
    const filePath = join(stateDir, "nonces.jsonl");
    const cache = new NonceCache({ journal: createNonceJournal(filePath), now: NOW });

    // Each call advances `now` past the previous nonce's 300s TTL, so pruneExpired drops it
    // before the next is recorded: the live set for this device never holds more than one
    // entry, yet every call still appends its own line, so the raw file would grow to 1000
    // lines by the time the append-count threshold is reached.
    let now = NOW;
    for (let index = 0; index < 1000; index += 1) {
      now = new Date(now.getTime() + 301_000);
      cache.record("dev_a", `nonce-${index}`, now);
    }

    expect(lineCount(filePath)).toBe(1); // compacted to just the one still-live nonce
    expect(cache.has("dev_a", "nonce-999", now)).toBe(true);

    const reloaded = new NonceCache({ journal: createNonceJournal(filePath), now });
    expect(reloaded.has("dev_a", "nonce-999", now)).toBe(true);
  });

  test("the per-device nonce cap and journal persistence agree on who survives a restart", () => {
    const filePath = join(stateDir, "nonces.jsonl");
    const MAX_NONCES_PER_DEVICE = 10_000; // mirrors auth/verify.ts's cap, which is not exported
    const cache = new NonceCache({ journal: createNonceJournal(filePath), now: NOW });

    const total = MAX_NONCES_PER_DEVICE + 10;
    for (let index = 0; index < total; index += 1) {
      cache.record("dev_a", `nonce-${index}`, NOW);
    }

    // In-memory eviction dropped the oldest 10 before any restart happens at all.
    expect(cache.has("dev_a", "nonce-9", NOW)).toBe(false);
    expect(cache.has("dev_a", "nonce-10", NOW)).toBe(true);

    const reloaded = new NonceCache({ journal: createNonceJournal(filePath), now: NOW });
    // The journal must agree with the in-memory eviction: a survivor the cap kept must still be
    // known after a restart, and one it evicted must not come back as if it were still fresh.
    expect(reloaded.has("dev_a", "nonce-9", NOW)).toBe(false);
    expect(reloaded.has("dev_a", "nonce-10", NOW)).toBe(true);
    expect(reloaded.has("dev_a", `nonce-${total - 1}`, NOW)).toBe(true);
  });
});

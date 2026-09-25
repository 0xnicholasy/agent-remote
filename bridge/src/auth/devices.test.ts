import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceRegistry, resolveStateDir, type DeviceRecord } from "./devices";
import { FileLockReleaseError, withFileLock } from "./persist";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentremote-devices-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleRecord(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: "dev_9f2c4a1b7d3e5061",
    deviceName: "Ting's Apple Watch",
    keyId: "key_deadbeef",
    deviceKeyHex: "aa".repeat(32),
    pairedAt: "2026-09-20T10:15:00.000Z",
    allowedProjects: ["prj_demo"],
    allowedActions: ["prompt.send"],
    revokedAt: null,
    lastSeenAt: null,
    ...overrides,
  };
}

describe("resolveStateDir", () => {
  test("uses AGENTREMOTE_STATE_DIR when set", () => {
    expect(resolveStateDir({ AGENTREMOTE_STATE_DIR: "/tmp/custom-state" })).toBe("/tmp/custom-state");
  });

  test("defaults to ~/.agentremote", () => {
    const resolved = resolveStateDir({});
    expect(resolved.endsWith(".agentremote")).toBe(true);
  });
});

describe("DeviceRegistry", () => {
  test("missing file loads as an empty registry", () => {
    const dir = tempDir();
    const registry = DeviceRegistry.load(join(dir, "devices.json"));
    expect(registry.list()).toEqual([]);
  });

  test("round-trips a registered device through a real temp file", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord();

    const writer = DeviceRegistry.load(filePath);
    writer.register(record);

    const reader = DeviceRegistry.load(filePath);
    expect(reader.get(record.deviceId)).toEqual(record);
  });

  test("a corrupt file throws an error naming the path", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    writeFileSync(filePath, "{ not json", "utf8");

    expect(() => DeviceRegistry.load(filePath)).toThrow(filePath);
  });

  test("valid JSON that is not a well-formed device record is rejected, not silently accepted", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    // Valid JSON array, but the entry is missing deviceKeyHex and has allowedProjects as a
    // string instead of an array -- exactly the shape isDeviceRecord must reject.
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          deviceId: "dev_missing_fields",
          deviceName: "Malformed Watch",
          keyId: "key_deadbeef",
          pairedAt: "2026-09-20T10:15:00.000Z",
          allowedProjects: "prj_demo",
          allowedActions: ["prompt.send"],
          revokedAt: null,
          lastSeenAt: null,
        },
      ]),
      "utf8",
    );

    expect(() => DeviceRegistry.load(filePath)).toThrow(/malformed device record/);
  });

  test("revoke persists revokedAt", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord();

    const writer = DeviceRegistry.load(filePath);
    writer.register(record);
    const revokedAt = new Date("2026-09-20T11:00:00.000Z");
    writer.revoke(record.deviceId, revokedAt);

    const reader = DeviceRegistry.load(filePath);
    expect(reader.get(record.deviceId)?.revokedAt).toBe(revokedAt.toISOString());
  });

  test("setAllowedProjects persists a deduped, sorted list and is visible to a second registry over the same file", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord();

    const writer = DeviceRegistry.load(filePath);
    writer.register(record);
    writer.setAllowedProjects(record.deviceId, ["prj_b", "prj_a", "prj_b"]);

    expect(writer.get(record.deviceId)?.allowedProjects).toEqual(["prj_a", "prj_b"]);

    const reader = DeviceRegistry.load(filePath);
    expect(reader.get(record.deviceId)?.allowedProjects).toEqual(["prj_a", "prj_b"]);
  });

  test("setAllowedProjects replaces the list wholesale, ignoring what was there", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord({ allowedProjects: ["prj_old"] });

    const writer = DeviceRegistry.load(filePath);
    writer.register(record);
    writer.setAllowedProjects(record.deviceId, ["prj_new"]);

    const reader = DeviceRegistry.load(filePath);
    expect(reader.get(record.deviceId)?.allowedProjects).toEqual(["prj_new"]);
  });

  test("updateAllowedProjects from a registry holding a stale snapshot keeps a change another registry made in between", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord({ allowedProjects: ["prj_b", "prj_keep"] });

    const a = DeviceRegistry.load(filePath);
    a.register(record);
    // B loads now and holds ["prj_b", "prj_keep"] in memory while A writes underneath it.
    const b = DeviceRegistry.load(filePath);
    expect(b.get(record.deviceId)?.allowedProjects).toEqual(["prj_b", "prj_keep"]);

    a.updateAllowedProjects(record.deviceId, (current) => [...current, "prj_a"]);
    b.updateAllowedProjects(record.deviceId, (current) => current.filter((id) => id !== "prj_b"));

    const reader = DeviceRegistry.load(filePath);
    expect(reader.get(record.deviceId)?.allowedProjects).toEqual(["prj_a", "prj_keep"]);
  });

  test("atomic write leaves no temp file behind", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const registry = DeviceRegistry.load(filePath);
    registry.register(sampleRecord());

    const entries = readdirSync(dir);
    expect(entries).toEqual(["devices.json"]);
    expect(existsSync(filePath)).toBe(true);
  });

  test("writes the file with mode 0600", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const registry = DeviceRegistry.load(filePath);
    registry.register(sampleRecord());

    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("touch updates lastSeenAt", () => {
    const registry = new DeviceRegistry();
    const record = sampleRecord();
    registry.register(record);

    const seenAt = new Date("2026-09-20T12:00:00.000Z");
    registry.touch(record.deviceId, seenAt);

    expect(registry.get(record.deviceId)?.lastSeenAt).toBe(seenAt.toISOString());
  });

  test("a second touch within the throttle interval updates lastSeenAt in memory but does not rewrite the file", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord();
    const registry = DeviceRegistry.load(filePath);
    registry.register(record);

    const firstSeenAt = new Date("2026-09-20T12:00:00.000Z");
    registry.touch(record.deviceId, firstSeenAt);
    const statAfterFirstTouch = statSync(filePath);
    const onDiskAfterFirstTouch = JSON.parse(readFileSync(filePath, "utf8"));

    const secondSeenAt = new Date(firstSeenAt.getTime() + 1_000);
    registry.touch(record.deviceId, secondSeenAt);

    expect(registry.get(record.deviceId)?.lastSeenAt).toBe(secondSeenAt.toISOString());
    expect(statSync(filePath).mtimeMs).toBe(statAfterFirstTouch.mtimeMs);
    const onDiskAfterSecondTouch = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDiskAfterSecondTouch[0].lastSeenAt).toBe(onDiskAfterFirstTouch[0].lastSeenAt);
  });

  test("a touch after the throttle interval has elapsed persists the new lastSeenAt", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const oldSeenAt = new Date("2026-09-20T12:00:00.000Z");
    const record = sampleRecord({ lastSeenAt: oldSeenAt.toISOString() });
    const registry = DeviceRegistry.load(filePath);
    registry.register(record);

    const newSeenAt = new Date(oldSeenAt.getTime() + 60_000);
    registry.touch(record.deviceId, newSeenAt);

    const reader = DeviceRegistry.load(filePath);
    expect(reader.get(record.deviceId)?.lastSeenAt).toBe(newSeenAt.toISOString());
  });

  // Regression test for the live bug: a bridge process's DeviceRegistry never re-reads
  // devices.json, so AGENTREMOTE_REVOKE (a separate one-shot process writing that same file)
  // never took effect until the bridge was restarted. Write this test first and watch it fail
  // against the old (load-once) DeviceRegistry before making the fix.
  test("a revocation written by a separate registry over the same file is visible without reconstructing this one", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord();

    const a = DeviceRegistry.load(filePath);
    a.register(record);

    // Simulates the AGENTREMOTE_REVOKE one-shot operator command: a second process/registry
    // instance over the same backing file, revoking behind A's back.
    const b = DeviceRegistry.load(filePath);
    b.revoke(record.deviceId, new Date("2026-09-20T12:00:00.000Z"));

    expect(a.get(record.deviceId)?.revokedAt).toBe("2026-09-20T12:00:00.000Z");
  });

  test("a device registered by a separate registry over the same file is visible to get and list", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const a = DeviceRegistry.load(filePath);

    const b = DeviceRegistry.load(filePath);
    const record = sampleRecord({ deviceId: "dev_b000000000000001" });
    b.register(record);

    expect(a.get(record.deviceId)).toEqual(record);
    expect(a.list().map((r) => r.deviceId)).toContain(record.deviceId);
  });

  test("a registry's own register/revoke does not re-parse the file it just wrote", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const registry = DeviceRegistry.load(filePath);

    // Spies on the real node:fs.readFileSync used internally by devices.ts's reload path.
    // reloadIfChanged() only calls readFileSync when the on-disk stamp differs from the stamp
    // this registry itself last wrote, so a registry that keeps writing (and never sees a
    // foreign write) should never call it again after the initial load.
    const readSpy = spyOn(fs, "readFileSync");
    const callsBeforeWrites = readSpy.mock.calls.length;

    const record = sampleRecord();
    registry.register(record);
    registry.revoke(record.deviceId, new Date("2026-09-20T13:00:00.000Z"));
    registry.get(record.deviceId);
    registry.list();

    expect(readSpy.mock.calls.length).toBe(callsBeforeWrites);
    readSpy.mockRestore();
  });

  test("registering a device does not resurrect one revoked out of band since this registry last read the file", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const deviceA = sampleRecord({ deviceId: "dev_a000000000000001" });

    const registry = DeviceRegistry.load(filePath);
    registry.register(deviceA);

    // The out-of-band revoke CLI writes devices.json directly; this registry has not looked since.
    const revokedAt = "2026-09-20T12:00:00.000Z";
    const onDisk = (JSON.parse(readFileSync(filePath, "utf8")) as DeviceRecord[]).map((r) => ({
      ...r,
      revokedAt,
    }));
    writeFileSync(filePath, JSON.stringify(onDisk, null, 2), "utf8");

    registry.register(sampleRecord({ deviceId: "dev_b000000000000002" }));

    const after = JSON.parse(readFileSync(filePath, "utf8")) as DeviceRecord[];
    expect(after.find((r) => r.deviceId === deviceA.deviceId)?.revokedAt).toBe(revokedAt);
    expect(after.map((r) => r.deviceId).sort()).toEqual(["dev_a000000000000001", "dev_b000000000000002"]);
    expect(registry.get(deviceA.deviceId)?.revokedAt).toBe(revokedAt);
  });

  test("touches more frequent than the throttle still advance the on-disk lastSeenAt over time", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord();
    const registry = DeviceRegistry.load(filePath);
    registry.register(record);

    // Seven touches 30s apart: 180s of traffic, never a 60s gap between consecutive touches.
    const startMs = Date.parse("2026-09-20T12:00:00.000Z");
    registry.touch(record.deviceId, new Date(startMs));
    const readPersistedLastSeenAt = (): string | null =>
      (JSON.parse(readFileSync(filePath, "utf8")) as DeviceRecord[]).find(
        (r) => r.deviceId === record.deviceId,
      )?.lastSeenAt ?? null;
    const firstPersisted = readPersistedLastSeenAt();
    for (let step = 1; step <= 6; step += 1) {
      registry.touch(record.deviceId, new Date(startMs + step * 30_000));
    }

    const persisted = readPersistedLastSeenAt();
    expect(firstPersisted).toBe(new Date(startMs).toISOString());
    // Throttling against the in-memory lastSeenAt would leave the file frozen at firstPersisted.
    expect(persisted).not.toBe(firstPersisted);
    expect(Date.parse(persisted ?? "")).toBeGreaterThanOrEqual(startMs + 120_000);
    expect(Date.parse(persisted ?? "")).toBeLessThanOrEqual(startMs + 180_000);
  });

  test("a device whose record could not be written is not left registered in memory", () => {
    const dir = tempDir();
    // The parent of the registry path is a regular file, so the atomic write's mkdir fails.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    const filePath = join(blocker, "devices.json");

    const registry = DeviceRegistry.load(filePath);
    const record = sampleRecord();

    expect(() => registry.register(record)).toThrow();
    expect(registry.get(record.deviceId)).toBeUndefined();
    expect(registry.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  test("a touch that persists does not resurrect a device revoked out of band since the last load", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord({ lastSeenAt: "2026-09-20T12:00:00.000Z" });

    const registry = DeviceRegistry.load(filePath);
    registry.register(record);

    // The out-of-band revoke CLI writes devices.json directly; this registry has not looked since.
    const revokedAt = "2026-09-20T12:05:00.000Z";
    const onDisk = (JSON.parse(readFileSync(filePath, "utf8")) as DeviceRecord[]).map((r) => ({
      ...r,
      revokedAt,
    }));
    writeFileSync(filePath, JSON.stringify(onDisk, null, 2), "utf8");

    // Past the throttle interval, so this touch actually persists (and must reload first).
    const touchedAt = new Date(Date.parse(record.lastSeenAt as string) + 60_000);
    registry.touch(record.deviceId, touchedAt);

    const after = JSON.parse(readFileSync(filePath, "utf8")) as DeviceRecord[];
    expect(after.find((r) => r.deviceId === record.deviceId)?.revokedAt).toBe(revokedAt);
  });

  test("a touch whose persist fails does not throw, and still updates lastSeenAt in memory", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord({ lastSeenAt: "2026-09-20T12:00:00.000Z" });

    const registry = DeviceRegistry.load(filePath);
    registry.register(record);

    // Make the parent directory read-only so mkdirSync (already exists) still succeeds but the
    // atomic write's temp-file writeFileSync fails with EACCES. The existing file and its stat
    // stay unchanged, so touch's reload sees "nothing new" and does not clear the in-memory map.
    chmodSync(dir, 0o500);
    try {
      // Past the throttle interval, so this touch attempts to persist.
      const touchedAt = new Date(Date.parse(record.lastSeenAt as string) + 60_000);
      expect(() => registry.touch(record.deviceId, touchedAt)).not.toThrow();
      expect(registry.get(record.deviceId)?.lastSeenAt).toBe(touchedAt.toISOString());
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a deleted backing file does not throw on the next get, and reports an empty registry", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const registry = DeviceRegistry.load(filePath);
    registry.register(sampleRecord());

    unlinkSync(filePath);

    expect(() => registry.get(sampleRecord().deviceId)).not.toThrow();
    expect(registry.get(sampleRecord().deviceId)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  test("a live holder of devices.json.lock makes revoke fail closed and touch skip its write", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord({ lastSeenAt: "2026-09-20T12:00:00.000Z" });
    const registry = DeviceRegistry.load(filePath, { lockTimeoutMs: 50 });
    registry.register(record);
    const before = readFileSync(filePath, "utf8");

    // Held by a live process (this one), as if the operator CLI were mid-write.
    writeFileSync(join(dir, "devices.json.lock"), String(process.pid), "utf8");

    expect(() => registry.revoke(record.deviceId, new Date("2026-09-20T12:30:00.000Z"))).toThrow(
      new RegExp(`held by running pid ${process.pid}`),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    registry.touch(record.deviceId, new Date("2026-09-20T12:01:00.000Z"));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(registry.get(record.deviceId)?.revokedAt).toBeNull();
  });

  // F-23: age never matters. A lock naming a live pid is not taken over however old its mtime,
  // because the lock is never taken over at all: it is held until its owner unlinks it.
  test("a devices.json.lock held by a live pid is not taken over however old its mtime", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const lockPath = join(dir, "devices.json.lock");
    const record = sampleRecord();
    const registry = DeviceRegistry.load(filePath, { lockTimeoutMs: 50 });
    registry.register(record);
    const before = readFileSync(filePath, "utf8");

    writeFileSync(lockPath, String(process.pid), "utf8");
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockPath, anHourAgo, anHourAgo);

    expect(() => registry.revoke(record.deviceId, new Date("2026-09-20T12:30:00.000Z"))).toThrow(
      new RegExp(`held by running pid ${process.pid}`),
    );
    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  // F-24: touch runs on the bridge event loop, so a busy lock must not make it wait at all, even
  // with the CLI's 2 s default configured for the mutating calls.
  test("touch with a busy devices.json.lock returns immediately and skips its write", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const record = sampleRecord({ lastSeenAt: "2026-09-20T12:00:00.000Z" });
    const registry = DeviceRegistry.load(filePath);
    registry.register(record);
    const before = readFileSync(filePath, "utf8");

    writeFileSync(join(dir, "devices.json.lock"), String(process.pid), "utf8");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const startedAt = performance.now();
    registry.touch(record.deviceId, new Date("2026-09-20T12:05:00.000Z"));
    const elapsedMs = performance.now() - startedAt;
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    expect(elapsedMs).toBeLessThan(50);
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });

  test("a devices.json.lock naming a dead pid is NOT taken over: it is only cleared at bridge startup", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const lockPath = join(dir, "devices.json.lock");
    const record = sampleRecord();
    const registry = DeviceRegistry.load(filePath, { lockTimeoutMs: 50 });
    registry.register(record);
    const before = readFileSync(filePath, "utf8");

    writeFileSync(lockPath, "999999", "utf8");

    expect(() => registry.revoke(record.deviceId, new Date("2026-09-20T12:30:00.000Z"))).toThrow(
      /pid 999999, which is not running/,
    );
    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("an empty devices.json.lock is reported as naming no pid", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const lockPath = join(dir, "devices.json.lock");
    const record = sampleRecord();
    const registry = DeviceRegistry.load(filePath, { lockTimeoutMs: 50 });
    registry.register(record);

    writeFileSync(lockPath, "", "utf8");

    expect(() => registry.revoke(record.deviceId, new Date("2026-09-20T12:30:00.000Z"))).toThrow(
      /names no pid/,
    );
  });

  // Isolates a release-only failure (the write itself succeeds; only the unlink that releases the
  // lock fails) by mocking unlinkSync rather than chmod'ing the state dir: chmod would also break
  // the persist inside the same locked callback, which would throw for an unrelated reason and
  // leave this regression untested.
  test("a lock that cannot be unlinked on release throws instead of wedging silently", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const lockPath = join(dir, "devices.json.lock");
    const record = sampleRecord();
    const registry = DeviceRegistry.load(filePath);
    registry.register(record);
    const before = readFileSync(filePath, "utf8");

    const realUnlinkSync = fs.unlinkSync;
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path: fs.PathLike) => {
      if (path === lockPath) {
        const error = new Error("EACCES: permission denied, unlink") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realUnlinkSync(path);
    });
    try {
      expect(() =>
        registry.updateAllowedProjects(record.deviceId, (current) => [...current, "proj-x"]),
      ).toThrow(/EACCES/);
    } finally {
      unlinkSpy.mockRestore();
    }
    // The write itself went through (unlink is the only thing that failed); what did not survive
    // is releasing the lock.
    expect(readFileSync(filePath, "utf8")).not.toBe(before);
    expect(existsSync(lockPath)).toBe(true);
  });

  // F-41: when fn's write already succeeded, a release failure must say so explicitly (not throw
  // the raw unlink error), so the caller does not read a persisted write as a failed one. Root can
  // write through a 0o500 directory, so this regression only reproduces as a non-root user.
  test.skipIf(process.getuid?.() === 0)(
    "a release failure after a successful write throws FileLockReleaseError and preserves the write",
    () => {
      const dir = tempDir();
      const lockPath = join(dir, "test.lock");
      const markerPath = join(dir, "marker");
      let thrown: unknown;
      try {
        withFileLock(
          lockPath,
          () => {
            writeFileSync(markerPath, "ok", "utf8");
            chmodSync(dir, 0o500);
          },
          0,
        );
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(thrown).toBeInstanceOf(FileLockReleaseError);
      expect((thrown as Error).message).toContain(lockPath);
      expect((thrown as Error).message).toContain("persist");
      expect(existsSync(markerPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  // F-41: when fn itself throws, that error must win over any release failure, not get replaced
  // by the unlink error.
  test.skipIf(process.getuid?.() === 0)(
    "a release failure after fn throws still propagates fn's own error",
    () => {
      const dir = tempDir();
      const lockPath = join(dir, "test.lock");
      let thrown: unknown;
      try {
        withFileLock(
          lockPath,
          () => {
            chmodSync(dir, 0o500);
            throw new Error("boom");
          },
          0,
        );
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(dir, 0o700);
      }
      expect((thrown as Error).message).toBe("boom");
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  // C1-02: registry A has already loaded devices.json when registry B (standing in for the CLI)
  // revokes; B's write is injected at the moment A goes to take devices.json.lock for its touch
  // persist. Because A reloads only once it holds the lock, it rewrites on top of B's revoke
  // instead of landing a stale, un-revoked copy.
  test("a touch persisting after another registry's revoke keeps the device revoked", () => {
    const dir = tempDir();
    const filePath = join(dir, "devices.json");
    const lockPath = `${filePath}.lock`;
    const record = sampleRecord({ lastSeenAt: "2026-09-20T12:00:00.000Z" });
    const a = DeviceRegistry.load(filePath);
    a.register(record);
    a.get(record.deviceId);
    const b = DeviceRegistry.load(filePath);
    const revokedAt = new Date("2026-09-20T12:05:00.000Z");

    const realWriteFileSync = fs.writeFileSync;
    let raced = false;
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(
      (path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
        if (!raced && path === lockPath) {
          raced = true;
          b.revoke(record.deviceId, revokedAt);
        }
        return realWriteFileSync(path, data, options);
      },
    );
    try {
      // Past the throttle interval, so this touch persists.
      a.touch(record.deviceId, new Date("2026-09-20T12:10:00.000Z"));
    } finally {
      writeSpy.mockRestore();
    }
    expect(raced).toBe(true);

    const after = JSON.parse(readFileSync(filePath, "utf8")) as DeviceRecord[];
    expect(after.find((r) => r.deviceId === record.deviceId)?.revokedAt).toBe(revokedAt.toISOString());
  });
});

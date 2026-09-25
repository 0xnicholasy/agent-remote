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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceRegistry, resolveStateDir, type DeviceRecord } from "./devices";

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
});

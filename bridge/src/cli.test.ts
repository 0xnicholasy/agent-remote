import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceRegistry, type DeviceRecord } from "./auth/devices";
import { runCli, type CliDeps, type CliHealth } from "./cli";
import { projectIdFor } from "./projects";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "agentremote-cli-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** A clock the test controls directly, so `pair`'s wait loop advances without real timers. */
function fakeClock(start: Date): { now: () => Date; advanceMs: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advanceMs: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const clock = fakeClock(new Date("2026-09-25T00:00:00.000Z"));
  return {
    stateDir,
    now: clock.now,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    sleep: async (ms) => {
      clock.advanceMs(ms);
    },
    health: async (): Promise<CliHealth | null> => null,
    env: {},
    cwd: "/Users/tester/code/demo",
    stdoutLines,
    stderrLines,
    ...overrides,
  };
}

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

describe("pair", () => {
  test("prints a dashed pairing code, and host:port for every printed LAN address", async () => {
    const deps = makeDeps({ env: { PORT: "8787" } });
    const exitCode = await runCli(["pair", "--no-wait"], deps);

    expect(exitCode).toBe(0);
    expect(deps.stdoutLines.some((line) => /^Pairing code: [0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4} \(expires /.test(line))).toBe(
      true,
    );
    for (const line of deps.stdoutLines.filter((l) => l.startsWith("Enter in Watch Settings:"))) {
      expect(line).toMatch(/^Enter in Watch Settings: [0-9.]+:8787$/);
    }
  });

  test("reports paired when a separate DeviceRegistry registers a device and pairing.json is removed", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const deps = makeDeps({
      sleep: async () => {
        // Stands in for the watch completing pairing out of band: a separate registry writes
        // the device, and the pairing code is burned (pairing.json removed), same as verify().
        const operatorRegistry = DeviceRegistry.load(devicesFilePath);
        operatorRegistry.register(sampleRecord({ pairedAt: new Date().toISOString() }));
        rmSync(join(stateDir, "pairing.json"), { force: true });
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(0);
    expect(deps.stdoutLines.some((line) => line.includes(sampleRecord().deviceId))).toBe(true);
  });

  test("expires when the injected clock passes the 5-minute TTL with no device paired", async () => {
    const deps = makeDeps();
    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("Pairing code expired before a device paired.");
  });
});

describe("devices", () => {
  test("never prints key material", async () => {
    const registry = DeviceRegistry.load(join(stateDir, "devices.json"));
    registry.register(sampleRecord());
    const deps = makeDeps();

    const exitCode = await runCli(["devices", "--json"], deps);

    expect(exitCode).toBe(0);
    const output = deps.stdoutLines.join("\n");
    expect(output).not.toContain(sampleRecord().deviceKeyHex);
    expect(output).not.toContain("key_deadbeef");
    expect(output).toContain(sampleRecord().deviceId);
  });
});

describe("revoke", () => {
  test("an unknown device exits 1", async () => {
    const deps = makeDeps();
    const exitCode = await runCli(["revoke", "dev_unknown"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("No such device: dev_unknown");
  });

  test("a known device is revoked and persisted", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord());
    const deps = makeDeps();

    const exitCode = await runCli(["revoke", sampleRecord().deviceId], deps);

    expect(exitCode).toBe(0);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.revokedAt).not.toBeNull();
  });
});

describe("projects", () => {
  test("deny removes a project from allowedProjects", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: ["prj_demo", "prj_other"] }));
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "deny", sampleRecord().deviceId, "prj_other"], deps);

    expect(exitCode).toBe(0);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.allowedProjects).toEqual(["prj_demo"]);
  });

  test("allow converts an absolute path to a project id", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: [] }));
    const deps = makeDeps({ env: { AGENTREMOTE_PROVIDER: "claude", AGENTREMOTE_PROJECT_DIRS: "/Users/tester/code/demo" } });

    const exitCode = await runCli(["projects", "allow", sampleRecord().deviceId, "/Users/tester/code/demo"], deps);

    expect(exitCode).toBe(0);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.allowedProjects).toEqual([projectIdFor("/Users/tester/code/demo")]);
  });

  test("allow refuses a prj_ id not in the current project list without --force", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: [] }));
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "allow", sampleRecord().deviceId, "prj_nonexistent"], deps);

    expect(exitCode).toBe(1);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.allowedProjects).toEqual([]);
  });

  test("allow accepts a prj_ id not in the current project list with --force", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: [] }));
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "allow", sampleRecord().deviceId, "prj_nonexistent", "--force"], deps);

    expect(exitCode).toBe(0);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.allowedProjects).toEqual(["prj_nonexistent"]);
  });
});

describe("corrupt state", () => {
  test("a corrupt devices.json exits 1 and names the path", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    writeFileSync(devicesFilePath, "{not valid json", { mode: 0o600 });
    const deps = makeDeps();

    const exitCode = await runCli(["devices"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(devicesFilePath) && line.includes("not valid JSON"))).toBe(true);
  });
});

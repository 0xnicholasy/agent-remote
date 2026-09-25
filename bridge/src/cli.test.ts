import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceRegistry, type DeviceRecord } from "./auth/devices";
import { PairingCodeStore } from "./auth/pairing";
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

  test("stops waiting when a second pair run replaces pairing.json before a device pairs with our code", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const pairingFilePath = join(stateDir, "pairing.json");
    const deps = makeDeps({
      sleep: async () => {
        // Stands in for a second `pair` run (or a bridge restart) minting its own code and
        // overwriting pairing.json, then a device enrolling under that new code -- all while
        // this invocation is still waiting on its own, now-superseded code.
        const otherStore = new PairingCodeStore(pairingFilePath);
        otherStore.mint(new Date("2026-09-25T00:00:05.000Z"));
        const registry = DeviceRegistry.load(devicesFilePath);
        registry.register(sampleRecord({ pairedAt: new Date("2026-09-25T00:00:06.000Z").toISOString() }));
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain(
      "pairing code was replaced by another pair run or a bridge restart; re-run pair",
    );
    expect(deps.stdoutLines.some((line) => line.includes(sampleRecord().deviceId))).toBe(false);
  });

  test("reports used up when the pairing code is burned without a device ever registering", async () => {
    const deps = makeDeps({
      sleep: async () => {
        rmSync(join(stateDir, "pairing.json"), { force: true });
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("Pairing code was used up before a device paired.");
  });

  test("pairing.json becoming invalid JSON during the wait exits 1 instead of retrying or hanging", async () => {
    const pairingFilePath = join(stateDir, "pairing.json");
    const deps = makeDeps({
      sleep: async () => {
        writeFileSync(pairingFilePath, "{not valid json", { mode: 0o600 });
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(pairingFilePath))).toBe(true);
    expect(deps.stdoutLines.some((line) => line.startsWith("Paired device"))).toBe(false);
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

  test("retries and succeeds when a concurrent writer clobbers the revoke exactly once", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord());
    const original = readFileSync(devicesFilePath, "utf8");
    let clobbered = false;
    const deps = makeDeps({
      sleep: async () => {
        if (!clobbered) {
          clobbered = true;
          // Simulate a second CLI invocation reverting our just-persisted revoke before this
          // process re-reads devices.json to confirm it.
          writeFileSync(devicesFilePath, original, { mode: 0o600 });
        }
      },
    });

    const exitCode = await runCli(["revoke", sampleRecord().deviceId], deps);

    expect(exitCode).toBe(0);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.revokedAt).not.toBeNull();
  });

  test("exits 1 when every retry is clobbered by a concurrent writer", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord());
    const original = readFileSync(devicesFilePath, "utf8");
    const deps = makeDeps({
      sleep: async () => {
        writeFileSync(devicesFilePath, original, { mode: 0o600 });
      },
    });

    const exitCode = await runCli(["revoke", sampleRecord().deviceId], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("devices.json was rewritten concurrently; state not confirmed, re-run");
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.revokedAt).toBeNull();
  });

  test("exits 1 when devices.json can't be persisted", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord());
    const deps = makeDeps();

    chmodSync(stateDir, 0o500);
    try {
      const exitCode = await runCli(["revoke", sampleRecord().deviceId], deps);
      expect(exitCode).toBe(1);
      expect(deps.stderrLines.some((line) => line.includes(devicesFilePath))).toBe(true);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });

  test("a corrupt devices.json exits 1", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    writeFileSync(devicesFilePath, "{not valid json", { mode: 0o600 });
    const deps = makeDeps();

    const exitCode = await runCli(["revoke", "dev_unknown"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(devicesFilePath) && line.includes("not valid JSON"))).toBe(true);
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

  test("deny of a project not allowed for the device exits 1 and leaves devices.json unchanged", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: ["prj_demo"] }));
    const before = readFileSync(devicesFilePath, "utf8");
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "deny", sampleRecord().deviceId, "prj_other"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes("prj_other") && line.includes("not allowed"))).toBe(true);
    expect(readFileSync(devicesFilePath, "utf8")).toBe(before);
  });

  test("allow exits 1 when devices.json can't be persisted", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: [] }));
    const deps = makeDeps();

    chmodSync(stateDir, 0o500);
    try {
      const exitCode = await runCli(["projects", "allow", sampleRecord().deviceId, "prj_nonexistent", "--force"], deps);
      expect(exitCode).toBe(1);
      expect(deps.stderrLines.some((line) => line.includes(devicesFilePath))).toBe(true);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });

  test("deny exits 1 when devices.json can't be persisted", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: ["prj_other"] }));
    const deps = makeDeps();

    chmodSync(stateDir, 0o500);
    try {
      const exitCode = await runCli(["projects", "deny", sampleRecord().deviceId, "prj_other"], deps);
      expect(exitCode).toBe(1);
      expect(deps.stderrLines.some((line) => line.includes(devicesFilePath))).toBe(true);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });

  test("allow: a corrupt devices.json exits 1", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    writeFileSync(devicesFilePath, "{not valid json", { mode: 0o600 });
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "allow", "dev_unknown", "prj_nonexistent", "--force"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(devicesFilePath) && line.includes("not valid JSON"))).toBe(true);
  });

  test("deny: a corrupt devices.json exits 1", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    writeFileSync(devicesFilePath, "{not valid json", { mode: 0o600 });
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "deny", "dev_unknown", "prj_nonexistent"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(devicesFilePath) && line.includes("not valid JSON"))).toBe(true);
  });
});

describe("projects: bridge-sourced project list", () => {
  test("projects.json present with ids differing from the CLI env: list shows file ids, allow enforces them", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const registry = DeviceRegistry.load(devicesFilePath);
    registry.register(sampleRecord({ allowedProjects: [] }));
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify([{ id: "prj_file_abc", name: "file-project", path: "/some/file/project" }]),
      { mode: 0o600 },
    );
    const deps = makeDeps();

    const listExit = await runCli(["projects", "list"], deps);
    expect(listExit).toBe(0);
    expect(deps.stdoutLines).toContain("Current projects (from last bridge start):");
    expect(deps.stdoutLines.some((line) => line.includes("prj_file_abc"))).toBe(true);

    // "prj_demo" is only what this shell's env/cwd would resolve to (the mock provider default),
    // not a project.json entry, so allow without --force must refuse it.
    const allowEnvOnlyExit = await runCli(["projects", "allow", sampleRecord().deviceId, "prj_demo"], deps);
    expect(allowEnvOnlyExit).toBe(1);

    const allowFileExit = await runCli(["projects", "allow", sampleRecord().deviceId, "prj_file_abc"], deps);
    expect(allowFileExit).toBe(0);
    const reloaded = DeviceRegistry.load(devicesFilePath);
    expect(reloaded.get(sampleRecord().deviceId)?.allowedProjects).toEqual(["prj_file_abc"]);
  });

  test("no projects.json: warns on stderr and falls back to env/cwd resolution", async () => {
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "list"], deps);

    expect(exitCode).toBe(0);
    expect(
      deps.stderrLines.some(
        (line) => line.includes("no projects.json") && line.includes(stateDir) && line.includes("bridge never started here"),
      ),
    ).toBe(true);
    expect(deps.stdoutLines).toContain("Current projects:");
    expect(deps.stdoutLines.some((line) => line.includes("prj_demo"))).toBe(true);
  });
});

describe("projects: unknown device on a clean registry", () => {
  test("allow exits 1 and does not write devices.json", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "allow", "dev_unknown", "prj_demo"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("No such device: dev_unknown");
    expect(existsSync(devicesFilePath)).toBe(false);
  });

  test("deny exits 1 and does not write devices.json", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    const deps = makeDeps();

    const exitCode = await runCli(["projects", "deny", "dev_unknown", "prj_demo"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("No such device: dev_unknown");
    expect(existsSync(devicesFilePath)).toBe(false);
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

  test("pair: a corrupt devices.json exits 1 while waiting", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    writeFileSync(devicesFilePath, "{not valid json", { mode: 0o600 });
    const deps = makeDeps();

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(devicesFilePath) && line.includes("not valid JSON"))).toBe(true);
  });
});

describe("usage errors", () => {
  test.each([
    [["revoke"]],
    [["projects", "allow", "dev"]],
    [["projects", "deny", "dev"]],
    [["projects", "bogus"]],
    [["bogus"]],
  ])("argv %p exits 2 with usage on stderr", async (argv: string[]) => {
    const deps = makeDeps();

    const exitCode = await runCli(argv, deps);

    expect(exitCode).toBe(2);
    expect(deps.stderrLines[0]).toStartWith("Usage:");
  });
});

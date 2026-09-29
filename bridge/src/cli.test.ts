import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceRegistry, type DeviceRecord } from "./auth/devices";
import { readPendingPair, writePendingPair, type PendingPairRecord } from "./auth/pending-pair";
import { healthCheckHost, runCli, type CliDeps, type CliHealth } from "./cli";
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
    prompt: async () => "n",
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

function samplePendingPair(overrides: Partial<PendingPairRecord> = {}): PendingPairRecord {
  return {
    requestId: "par_0011223344556677",
    deviceId: "dev_9f2c4a1b7d3e5061",
    deviceName: "Ting's Apple Watch",
    code: 487,
    revealedAt: "2026-09-25T00:00:00.000Z",
    expiresAt: "2026-09-25T00:02:00.000Z",
    decision: null,
    status: "pending",
    ...overrides,
  };
}

describe("pair", () => {
  test("tells the operator to open the Watch app instead of printing a LAN address to enter", async () => {
    const deps = makeDeps({ env: { PORT: "8787" } });
    // No pending-pair.json ever appears, so the window simply expires; this test only checks
    // what pair prints before it starts waiting. The Watch finds the Mac on its own now, so
    // there is no address for the operator to type in anywhere.
    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stdoutLines).toContain("Pairing open for 2 minutes. On your Watch, open Agent Remote and tap Next.");
    expect(deps.stdoutLines.some((line) => line.startsWith("Enter in Watch Settings:"))).toBe(false);
  });

  test("shows the code prominently and spells out the order, and pairs the device on 'y'", async () => {
    let revealed = false;
    const deps = makeDeps({
      prompt: async (question) => {
        expect(question).toBe("Pair this Watch? [y/N] ");
        return "y";
      },
      sleep: async () => {
        if (!revealed) {
          revealed = true;
          writeFileSync(join(stateDir, "pending-pair.json"), JSON.stringify(samplePendingPair()), { mode: 0o600 });
          return;
        }
        // Stands in for the bridge registering the device once it observes our "approved"
        // decision on the Watch's next /v1/pair/status poll.
        const pending = readPendingPair(stateDir);
        if (pending?.decision === "approved") {
          DeviceRegistry.load(join(stateDir, "devices.json")).register(sampleRecord());
        }
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(0);
    // Either order (tap-then-confirm or confirm-then-tap) must work on the Watch side; this CLI
    // just needs to spell out one order for the operator, not enforce it.
    expect(deps.stdoutLines).toContain("Code on this Mac: 487");
    expect(deps.stdoutLines).toContain("1. On your Watch, tap 487.");
    expect(deps.stdoutLines).toContain("2. Then confirm here.");
    expect(deps.stdoutLines.some((line) => line.includes(sampleRecord().deviceId))).toBe(true);
  });

  test("denies on anything other than 'y' and never waits for a device", async () => {
    const deps = makeDeps({
      prompt: async () => "n",
      sleep: async () => {
        writeFileSync(join(stateDir, "pending-pair.json"), JSON.stringify(samplePendingPair()), { mode: 0o600 });
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stdoutLines).toContain("Pairing denied.");
    // The CLI clears the record it just denied itself, rather than leaving it for the Watch's
    // next /v1/pair/status poll (which may never come) to clean up -- a stale decided record
    // would otherwise block the next `pair` attempt with 409 pairing_busy.
    expect(readPendingPair(stateDir)).toBeUndefined();
  });

  test("expires when the window passes with no device requesting to pair", async () => {
    const deps = makeDeps();
    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("Pairing window expired with no device requesting to pair.");
  });

  test("reports the request as gone when it disappears before the operator answers", async () => {
    writePendingPair(stateDir, samplePendingPair(), 2000);
    const deps = makeDeps({
      prompt: async () => {
        // The bridge (or the Watch's own cancel) removed pending-pair.json while we were
        // "typing" the answer.
        rmSync(join(stateDir, "pending-pair.json"), { force: true });
        return "y";
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines).toContain("Pairing request expired or was cancelled before it could be answered.");
  });

  test("prints the waiting message on approval and times out at the request's own expiresAt, not a fixed 30s", async () => {
    // expiresAt is 10s after the clock's start, well under the old fixed 30s -- this proves the
    // deadline now comes from the pending request itself.
    writePendingPair(stateDir, samplePendingPair({ expiresAt: "2026-09-25T00:00:10.000Z" }), 2000);
    const deps = makeDeps({ prompt: async () => "y" });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stdoutLines).toContain("Approved. Waiting for the Watch -- tap 487 on your Watch if you haven't.");
    expect(deps.stderrLines).toContain("The Watch did not finish pairing. Run this command again and tap the code on your Watch.");
    // Approved but never claimed: the CLI clears its own decided record rather than leaving an
    // "approved" pending-pair.json sitting past its expiry, which would block the next `pair`
    // attempt with 409 pairing_busy.
    expect(readPendingPair(stateDir)).toBeUndefined();
  });

  test("a corrupt pending-pair.json exits 1 while waiting", async () => {
    const pendingPairPath = join(stateDir, "pending-pair.json");
    const deps = makeDeps({
      sleep: async () => {
        writeFileSync(pendingPairPath, "{not valid json", { mode: 0o600 });
      },
    });

    const exitCode = await runCli(["pair"], deps);

    expect(exitCode).toBe(1);
    expect(deps.stderrLines.some((line) => line.includes(pendingPairPath))).toBe(true);
  });
});

describe("healthCheckHost", () => {
  test("defaults to loopback when AGENTREMOTE_HOST is unset", () => {
    expect(healthCheckHost({})).toBe("127.0.0.1");
  });

  test("uses AGENTREMOTE_HOST when it names a real address", () => {
    expect(healthCheckHost({ AGENTREMOTE_HOST: "192.168.0.2" })).toBe("192.168.0.2");
  });

  test("falls back to loopback for the every-interface addresses", () => {
    expect(healthCheckHost({ AGENTREMOTE_HOST: "0.0.0.0" })).toBe("127.0.0.1");
    expect(healthCheckHost({ AGENTREMOTE_HOST: "::" })).toBe("127.0.0.1");
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

  test("pair: a corrupt devices.json exits 1 while waiting for the approved device to appear", async () => {
    const devicesFilePath = join(stateDir, "devices.json");
    writeFileSync(join(stateDir, "pending-pair.json"), JSON.stringify(samplePendingPair()), { mode: 0o600 });
    writeFileSync(devicesFilePath, "{not valid json", { mode: 0o600 });
    const deps = makeDeps({ prompt: async () => "y" });

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

// The Agent Remote bridge admin CLI: `bun run bridge pair|devices|revoke|projects ...`.
//
// This module deliberately does NOT import server.ts. It edits devices.json/pending-pair.json/
// pairing-window.json in the state dir directly, exactly the way the old AGENTREMOTE_PAIR/
// AGENTREMOTE_REVOKE/AGENTREMOTE_LIST_DEVICES one-shot env vars did: a running bridge notices the
// change on its next request via DeviceRegistry.reloadIfChanged / the pending-pair reload trick
// (see bridge/src/auth/devices.ts and bridge/src/auth/pending-pair.ts). Importing server.ts would
// pull in the HTTP server, the command journal and bridge.lock — none of which this CLI may touch,
// since it has to work correctly while a bridge process already holds the lock.
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type { Project } from "@agentremote/protocol";

import { DeviceRegistry, resolveStateDir, type DeviceRecord } from "./auth/devices";
import {
  clearPairingWindow,
  clearPendingPair,
  openPairingWindow,
  PENDING_PAIR_CLI_LOCK_TIMEOUT_MS,
  readPendingPair,
  setPendingPairDecision,
} from "./auth/pending-pair";
import { bridgeProjectsFileName, projectIdFor, readBridgeProjects, resolveProjectIds } from "./projects";

const DEFAULT_PORT = 8787;
const PAIRING_WINDOW_TTL_MS = 120 * 1000;
const POLL_INTERVAL_MS = 1000;
const DEVICE_APPEAR_TIMEOUT_MS = 30 * 1000;
const DENIED_ACK_POLLS = 5;

/** Bridge health, as reported by `GET /v1/health`. `null` means the bridge could not be reached. */
export interface CliHealth {
  ok: boolean;
  bridgeId: string;
  name: string;
}

/**
 * Everything the CLI needs from its environment, injected so tests can run against a temp state
 * dir with a fake clock and no real network/process I/O. `import.meta.main` below wires the real
 * versions.
 */
export interface CliDeps {
  stateDir: string;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  health: () => Promise<CliHealth | null>;
  /** Asks `question` on stdin and resolves with the raw answer (no trimming/casing applied).
   * `pair` uses this for the "Pair this Watch? [y/N] " confirmation. */
  prompt: (question: string) => Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function usage(): string {
  return [
    "Usage: bun run bridge <command> [args]",
    "",
    "Commands:",
    "  pair",
    "  devices [--json]",
    "  revoke <deviceId>",
    "  projects list",
    "  projects allow <deviceId> <prj_id|/abs/path> [--force]",
    "  projects deny <deviceId> <prj_id|/abs/path>",
  ].join("\n");
}

/** Splits `--flag` tokens out of `args`, returning the remaining positionals plus which of
 * `knownFlags` were present. An unknown `--`-prefixed token is left in `positionals` so the
 * caller's own arity check reports it, rather than this generic parser guessing at usage. */
function splitFlags(args: string[], knownFlags: readonly string[]): { positionals: string[]; flags: Set<string> } {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const arg of args) {
    if (knownFlags.includes(arg)) {
      flags.add(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

/** Resolves a `projects allow|deny` target argument: `prj_...` ids pass through unchanged, an
 * absolute path is converted with `projectIdFor`, anything else is rejected. */
function resolveProjectArg(arg: string): string | { error: string } {
  if (arg.startsWith("prj_")) {
    return arg;
  }
  if (path.isAbsolute(arg)) {
    return projectIdFor(arg);
  }
  return { error: `expected a prj_ id or an absolute path, got: "${arg}"` };
}

function isResolveError(value: string | { error: string }): value is { error: string } {
  return typeof value !== "string";
}

type ProjectsResult = { projects: Project[]; source: "file" | "env" } | { error: string };

/** Resolves the projects a `projects` subcommand should treat as current: the running (or last
 * started) bridge's own `projects.json` when present, falling back to this shell's env/cwd (the
 * same resolution `createBridge` would do on a fresh start) with a stderr warning when it is
 * missing. Prefer this over calling `resolveProjectIds` directly so `list`/`allow` agree with
 * whatever project set the bridge actually seeded, rather than guessing from this invocation's
 * own environment. */
function currentProjects(deps: CliDeps): ProjectsResult {
  let fileProjects: Project[] | undefined;
  try {
    fileProjects = readBridgeProjects(deps.stateDir);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (fileProjects !== undefined) {
    return { projects: fileProjects, source: "file" };
  }

  deps.stderr(
    `Warning: no ${bridgeProjectsFileName} in ${deps.stateDir} (bridge never started here); showing projects resolved from this shell's env/cwd`,
  );
  try {
    return { projects: resolveProjectIds(deps.env, deps.cwd), source: "env" };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function isProjectsError(value: ProjectsResult): value is { error: string } {
  return "error" in value;
}

function devicesFilePath(stateDir: string): string {
  return path.join(stateDir, "devices.json");
}


/** Loads the device registry, turning a corrupt-file exception into the CLI's exit-1 contract
 * (print the path and the error, don't throw out of `runCli`) instead of letting every
 * subcommand duplicate this try/catch. */
function loadRegistry(deps: CliDeps): DeviceRegistry | { error: string } {
  const filePath = devicesFilePath(deps.stateDir);
  try {
    return DeviceRegistry.load(filePath);
  } catch (cause) {
    return { error: `${filePath}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

function isRegistryError(value: DeviceRegistry | { error: string }): value is { error: string } {
  return !(value instanceof DeviceRegistry);
}

/**
 * Applies `mutate` against a freshly loaded registry, then confirms the change actually reached
 * disk by loading a *second* fresh registry and checking `holds` against the persisted record.
 * DeviceRegistry's own `devices.json.lock` (see auth/persist.ts's no-takeover `withFileLock`) is
 * now the primary guarantee against two concurrent CLI invocations against the same device
 * (`allow` racing `deny`, two `revoke`s, ...) clobbering one another's read-modify-write; the
 * verify-after-write and retry here are belt-and-braces for whatever gets past that lock (e.g. a
 * writer that doesn't take it), not the main defense. `mutate` must recompute whatever it needs
 * from the registry it is handed, not from state captured outside this call, so every retry
 * starts from the current on-disk state. A hard persist failure inside `mutate` (disk full,
 * EACCES, ...) is caught and reported once via `deps.stderr`, matching the CLI's corrupt-file
 * error contract, without burning the remaining retries meant for the clobber case.
 */
async function applyVerified(
  deps: CliDeps,
  mutate: (registry: DeviceRegistry) => void,
  holds: (record: DeviceRecord | undefined) => boolean,
  deviceId: string,
  attempts = 3,
): Promise<boolean> {
  const filePath = devicesFilePath(deps.stateDir);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const registry = loadRegistry(deps);
    if (isRegistryError(registry)) {
      deps.stderr(registry.error);
      return false;
    }
    try {
      // A FileLockTimeoutError here has already waited the full lock timeout inside mutate (it
      // is thrown by withFileLock, not by us), so re-spending that timeout on every retry would
      // only multiply the wait. The retry budget on this loop is for the verify-read clobber
      // case above (a writer that bypasses the lock), not for lock contention.
      mutate(registry);
    } catch (cause) {
      deps.stderr(`${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
    // Yields once so a test (or, in practice, a concurrent writer's disk I/O) can land between
    // this process's own persist and its confirmation read below.
    await deps.sleep(0);
    const fresh = loadRegistry(deps);
    if (isRegistryError(fresh)) {
      deps.stderr(fresh.error);
      return false;
    }
    if (holds(fresh.get(deviceId))) {
      return true;
    }
  }
  deps.stderr("devices.json was rewritten concurrently; state not confirmed, re-run");
  return false;
}

/**
 * `bun run bridge pair`, per the pairing v2 flow: open a 120 s window, wait for a Watch to reach
 * `/v1/pair/reveal` (which writes pending-pair.json with the confirmation code), show the code
 * and ask the operator to confirm it matches the Watch's own display, then wait for the running
 * bridge to register the device (it does so on the Watch's next `/v1/pair/status` poll once it
 * sees our decision).
 */
async function runPair(_args: string[], deps: CliDeps): Promise<number> {
  const openedAt = deps.now();
  try {
    openPairingWindow(deps.stateDir, openedAt, PAIRING_WINDOW_TTL_MS, PENDING_PAIR_CLI_LOCK_TIMEOUT_MS);
  } catch (cause) {
    deps.stderr(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
  const windowExpiresAt = new Date(openedAt.getTime() + PAIRING_WINDOW_TTL_MS);

  const health = await deps.health();
  if (health === null) {
    deps.stdout("Warning: no running bridge was found at this port. Start one before pairing a Watch.");
  }

  deps.stdout("Pairing open for 2 minutes. On your Watch, open Agent Remote and tap Next.");

  // Phase 1: wait for a Watch to reach /v1/pair/reveal (pending-pair.json appears) or the window
  // to expire with no request at all.
  let requestId: string | undefined;
  let deviceId: string | undefined;
  let code: number | undefined;
  let pendingExpiresAt: string | undefined;
  let deviceName: string | undefined;
  for (;;) {
    let pending: ReturnType<typeof readPendingPair>;
    try {
      pending = readPendingPair(deps.stateDir);
    } catch (cause) {
      deps.stderr(cause instanceof Error ? cause.message : String(cause));
      return 1;
    }
    if (pending !== undefined) {
      requestId = pending.requestId;
      deviceId = pending.deviceId;
      code = pending.code;
      pendingExpiresAt = pending.expiresAt;
      deviceName = pending.deviceName;
      break;
    }
    if (deps.now().getTime() >= windowExpiresAt.getTime()) {
      deps.stderr("Pairing window expired with no device requesting to pair.");
      return 1;
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }

  // From here on, this process has a decision (or is about to make one) recorded against
  // requestId, in pending-pair.json. If the operator kills us with Ctrl-C before we reach one of
  // our own exit paths below, clear it here too -- otherwise it sits there, decided, until it
  // expires on its own, and blocks every pairing attempt in between (see /v1/pair/start's
  // pairing_busy check).
  const onSigint = (): void => {
    try {
      clearPendingPair(deps.stateDir, PENDING_PAIR_CLI_LOCK_TIMEOUT_MS);
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      process.exit(130);
    }
  };
  process.once("SIGINT", onSigint);
  try {
    try {
      // Phase 2: show the code prominently and spell out the order -- either order
      // (tap-then-confirm or confirm-then-tap) must actually work, since the operator may do
      // either first.
      deps.stdout(`Code on this Mac: ${code}`);
      deps.stdout(`1. On your Watch, tap ${code}.`);
      deps.stdout("2. Then confirm here.");
      // The name is Watch-supplied: strip control characters so it cannot inject terminal escapes.
      const shownName = deviceName!.replace(/\p{Cc}/gu, "");
      const answer = await deps.prompt(
        `Pair "${shownName}" (${deviceId})? Only press y if your Watch is showing ${code} and waiting. [y/N] `,
      );
      const approved = answer.trim().toLowerCase() === "y";

      const applied = setPendingPairDecision(
        deps.stateDir,
        requestId!,
        approved ? "approved" : "denied",
        PENDING_PAIR_CLI_LOCK_TIMEOUT_MS,
      );
      if (!applied) {
        deps.stderr("Pairing request expired or was cancelled before it could be answered.");
        return 1;
      }
      if (!approved) {
        deps.stdout("Pairing denied.");
        // Leave the denied record in place so the Watch's next /v1/pair/status poll sees `denied`
        // (the bridge clears it on delivery). Wait a bounded number of polls for that; bounded by
        // iteration count, not the clock, since callers may stub sleep without advancing now().
        for (let i = 0; i < DENIED_ACK_POLLS; i += 1) {
          await deps.sleep(POLL_INTERVAL_MS);
          const current = readPendingPair(deps.stateDir);
          if (current === undefined || current.requestId !== requestId) {
            return 1;
          }
        }
        // The Watch never polled; clear the record ourselves so the next `pair` isn't blocked by
        // a stale busy record.
        clearPendingPair(deps.stateDir, PENDING_PAIR_CLI_LOCK_TIMEOUT_MS);
        return 1;
      }

      // Phase 3: the bridge registers the device on the Watch's next status poll; wait for it to
      // appear in devices.json. The deadline is the pending request's own expiry -- not a fixed
      // 30s -- since the operator may have confirmed before the Watch even started polling.
      deps.stdout(`Approved. Waiting for the Watch -- tap ${code} on your Watch if you haven't.`);
      const parsedExpiresAt = pendingExpiresAt !== undefined ? Date.parse(pendingExpiresAt) : Number.NaN;
      const decidedAt = deps.now();
      const deadline = Number.isNaN(parsedExpiresAt) ? decidedAt.getTime() + DEVICE_APPEAR_TIMEOUT_MS : parsedExpiresAt;
      for (;;) {
        const registry = loadRegistry(deps);
        if (isRegistryError(registry)) {
          deps.stderr(registry.error);
          return 1;
        }
        // deviceId is freshly chosen by the Watch for this attempt, so simply appearing in the
        // registry at all -- with no clock comparison -- is enough to know this pairing landed.
        const paired = registry.get(deviceId!);
        if (paired !== undefined) {
          deps.stdout(`Paired device ${paired.deviceId} (${paired.deviceName})`);
          clearPairingWindow(deps.stateDir, PENDING_PAIR_CLI_LOCK_TIMEOUT_MS);
          return 0;
        }
        if (deps.now().getTime() >= deadline) {
          deps.stderr("The Watch did not finish pairing. Run this command again and tap the code on your Watch.");
          // Approved but the Watch never finished: leaving an approved, decided record sitting
          // past its own expiry would otherwise block the next attempt with pairing_busy too.
          clearPendingPair(deps.stateDir, PENDING_PAIR_CLI_LOCK_TIMEOUT_MS);
          return 1;
        }
        await deps.sleep(POLL_INTERVAL_MS);
      }
    } catch (cause) {
      // A lock timeout or unreadable state file must not escape as an unhandled rejection. The
      // record is ours; leaving it would block the next attempt, so clear it best-effort.
      deps.stderr(cause instanceof Error ? cause.message : String(cause));
      try {
        clearPendingPair(deps.stateDir, PENDING_PAIR_CLI_LOCK_TIMEOUT_MS);
      } catch (clearCause) {
        deps.stderr(clearCause instanceof Error ? clearCause.message : String(clearCause));
      }
      return 1;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function deviceRow(record: DeviceRecord): { deviceId: string; deviceName: string; pairedAt: string; lastSeenAt: string | null; revoked: boolean; allowedProjects: string[] } {
  // Deliberately omits keyId and deviceKeyHex: this CLI never prints key material.
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
    revoked: record.revokedAt !== null,
    allowedProjects: record.allowedProjects,
  };
}

function runDevices(args: string[], deps: CliDeps): number {
  const { flags } = splitFlags(args, ["--json"]);
  const registry = loadRegistry(deps);
  if (isRegistryError(registry)) {
    deps.stderr(registry.error);
    return 1;
  }

  const rows = registry.list().map(deviceRow);
  if (flags.has("--json")) {
    deps.stdout(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    deps.stdout("No paired devices.");
    return 0;
  }

  deps.stdout(["deviceId", "deviceName", "pairedAt", "lastSeenAt", "revoked", "allowedProjects"].join("\t"));
  for (const row of rows) {
    deps.stdout(
      [row.deviceId, row.deviceName, row.pairedAt, row.lastSeenAt ?? "-", String(row.revoked), row.allowedProjects.join(",") || "-"].join(
        "\t",
      ),
    );
  }
  return 0;
}

async function runRevoke(args: string[], deps: CliDeps): Promise<number> {
  const [deviceId] = args;
  if (deviceId === undefined) {
    deps.stderr(usage());
    return 2;
  }

  const registry = loadRegistry(deps);
  if (isRegistryError(registry)) {
    deps.stderr(registry.error);
    return 1;
  }

  if (registry.get(deviceId) === undefined) {
    deps.stderr(`No such device: ${deviceId}`);
    return 1;
  }

  const ok = await applyVerified(
    deps,
    (fresh) => fresh.revoke(deviceId, deps.now()),
    (record) => record !== undefined && record.revokedAt !== null,
    deviceId,
  );
  if (!ok) {
    return 1;
  }
  deps.stdout(`Revoked device: ${deviceId}`);
  return 0;
}

function runProjectsList(deps: CliDeps): number {
  const result = currentProjects(deps);
  if (isProjectsError(result)) {
    deps.stderr(result.error);
    return 1;
  }

  const registry = loadRegistry(deps);
  if (isRegistryError(registry)) {
    deps.stderr(registry.error);
    return 1;
  }

  deps.stdout(result.source === "file" ? "Current projects (from last bridge start):" : "Current projects:");
  for (const project of result.projects) {
    deps.stdout(`  ${project.id}\t${project.path}`);
  }

  deps.stdout("Devices:");
  for (const device of registry.list()) {
    deps.stdout(`  ${device.deviceId}\t${device.allowedProjects.join(",") || "-"}`);
  }
  return 0;
}

async function runProjectsAllow(args: string[], deps: CliDeps): Promise<number> {
  const { positionals, flags } = splitFlags(args, ["--force"]);
  const [deviceId, projectArg] = positionals;
  if (deviceId === undefined || projectArg === undefined) {
    deps.stderr(usage());
    return 2;
  }

  const resolved = resolveProjectArg(projectArg);
  if (isResolveError(resolved)) {
    deps.stderr(resolved.error);
    return 1;
  }
  const projectId = resolved;

  const registry = loadRegistry(deps);
  if (isRegistryError(registry)) {
    deps.stderr(registry.error);
    return 1;
  }

  const device = registry.get(deviceId);
  if (device === undefined) {
    deps.stderr(`No such device: ${deviceId}`);
    return 1;
  }

  if (!flags.has("--force")) {
    const result = currentProjects(deps);
    if (isProjectsError(result)) {
      deps.stderr(result.error);
      return 1;
    }
    const currentProjectIds = new Set(result.projects.map((project) => project.id));
    if (!currentProjectIds.has(projectId)) {
      deps.stderr(`${projectId} is not a current project. Pass --force to allow it anyway.`);
      return 1;
    }
  }

  const ok = await applyVerified(
    deps,
    (fresh) => fresh.updateAllowedProjects(deviceId, (current) => [...current, projectId]),
    (record) => record?.allowedProjects.includes(projectId) === true,
    deviceId,
  );
  if (!ok) {
    return 1;
  }
  deps.stdout(`Allowed ${projectId} for ${deviceId}`);
  return 0;
}

async function runProjectsDeny(args: string[], deps: CliDeps): Promise<number> {
  const [deviceId, projectArg] = args;
  if (deviceId === undefined || projectArg === undefined) {
    deps.stderr(usage());
    return 2;
  }

  const resolved = resolveProjectArg(projectArg);
  if (isResolveError(resolved)) {
    deps.stderr(resolved.error);
    return 1;
  }
  const projectId = resolved;

  const registry = loadRegistry(deps);
  if (isRegistryError(registry)) {
    deps.stderr(registry.error);
    return 1;
  }

  const device = registry.get(deviceId);
  if (device === undefined) {
    deps.stderr(`No such device: ${deviceId}`);
    return 1;
  }

  if (!device.allowedProjects.includes(projectId)) {
    deps.stderr(`${projectId} is not allowed for ${deviceId} (allowed: ${device.allowedProjects.join(",") || "-"})`);
    return 1;
  }

  const ok = await applyVerified(
    deps,
    (fresh) => fresh.updateAllowedProjects(deviceId, (current) => current.filter((id) => id !== projectId)),
    (record) => record !== undefined && !record.allowedProjects.includes(projectId),
    deviceId,
  );
  if (!ok) {
    return 1;
  }
  deps.stdout(`Denied ${projectId} for ${deviceId}`);
  return 0;
}

async function runProjects(args: string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return runProjectsList(deps);
    case "allow":
      return runProjectsAllow(rest, deps);
    case "deny":
      return runProjectsDeny(rest, deps);
    default:
      deps.stderr(usage());
      return 2;
  }
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "pair":
      return runPair(rest, deps);
    case "devices":
      return runDevices(rest, deps);
    case "revoke":
      return await runRevoke(rest, deps);
    case "projects":
      return await runProjects(rest, deps);
    default:
      deps.stderr(usage());
      return 2;
  }
}

/**
 * Which host the CLI's health probe should hit. A bridge started with `AGENTREMOTE_HOST` set to a
 * real address (not every-interface `0.0.0.0`/`::`) only listens there, not on loopback, so
 * probing 127.0.0.1 unconditionally reports "no running bridge" even though one is up. Mirrors
 * `resolveBindHost` in server.ts (not imported: see this file's header comment on why cli.ts
 * never imports server.ts).
 */
export function healthCheckHost(env: NodeJS.ProcessEnv): string {
  const explicit = env.AGENTREMOTE_HOST?.trim();
  if (explicit !== undefined && explicit.length > 0 && explicit !== "0.0.0.0" && explicit !== "::") {
    return explicit;
  }
  return "127.0.0.1";
}

if (import.meta.main) {
  const port = process.env.PORT ?? String(DEFAULT_PORT);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const deps: CliDeps = {
    stateDir: resolveStateDir(),
    now: () => new Date(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    health: async () => {
      try {
        const host = healthCheckHost(process.env);
        const response = await fetch(`http://${host}:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) {
          return null;
        }
        return (await response.json()) as CliHealth;
      } catch {
        return null;
      }
    },
    prompt: (question) => rl.question(question),
    env: process.env,
    cwd: process.cwd(),
  };

  let exitCode = 1;
  try {
    exitCode = await runCli(process.argv.slice(2), deps);
  } finally {
    rl.close();
  }
  process.exit(exitCode);
}

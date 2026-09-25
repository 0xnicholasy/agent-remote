// The Agent Remote bridge admin CLI: `bun run bridge pair|devices|revoke|projects ...`.
//
// This module deliberately does NOT import server.ts. It edits devices.json/pairing.json in the
// state dir directly, exactly the way the old AGENTREMOTE_PAIR/AGENTREMOTE_REVOKE/
// AGENTREMOTE_LIST_DEVICES one-shot env vars did: a running bridge notices the change on its next
// request via DeviceRegistry.reloadIfChanged / PairingCodeStore.verify's reload (see
// bridge/src/auth/devices.ts and bridge/src/auth/pairing.ts). Importing server.ts would pull in
// the HTTP server, the command journal and bridge.lock — none of which this CLI may touch, since
// it has to work correctly while a bridge process already holds the lock.
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";

import type { Project } from "@agentremote/protocol";

import { DeviceRegistry, resolveStateDir, type DeviceRecord } from "./auth/devices";
import { formatPairingCode, PairingCodeStore } from "./auth/pairing";
import { bridgeProjectsFileName, projectIdFor, readBridgeProjects, resolveProjectIds } from "./projects";

const DEFAULT_PORT = 8787;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

/** Bridge health, as reported by `GET /v1/health`. `null` means the bridge could not be reached. */
export interface CliHealth {
  ok: boolean;
  bridgeId: string;
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
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function usage(): string {
  return [
    "Usage: bun run bridge <command> [args]",
    "",
    "Commands:",
    "  pair [--no-wait]",
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

/** True for a Node `ENOENT` (file does not exist), the one error a read racing an external
 * writer's unlink is expected to see. */
function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function devicesFilePath(stateDir: string): string {
  return path.join(stateDir, "devices.json");
}

function pairingFilePath(stateDir: string): string {
  return path.join(stateDir, "pairing.json");
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

async function runPair(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = splitFlags(args, ["--no-wait"]);
  const noWait = flags.has("--no-wait");

  const store = new PairingCodeStore(pairingFilePath(deps.stateDir));
  const mintedAt = deps.now();
  let code: string;
  try {
    code = store.mint(mintedAt);
  } catch (cause) {
    deps.stderr(`${pairingFilePath(deps.stateDir)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  const expiresAt = new Date(mintedAt.getTime() + PAIRING_TTL_MS);

  const health = await deps.health();
  if (health === null) {
    deps.stdout(
      "Warning: no running bridge was found at this port. Starting one will mint its own " +
        "pairing code, which will replace the one below.",
    );
  }

  const port = deps.env.PORT ?? String(DEFAULT_PORT);
  for (const host of nonInternalIPv4Addresses()) {
    deps.stdout(`Enter in Watch Settings: ${host}:${port}`);
  }
  deps.stdout(`Pairing code: ${formatPairingCode(code)} (expires ${expiresAt.toISOString()})`);

  if (noWait) {
    return 0;
  }

  const pairingPath = pairingFilePath(deps.stateDir);
  const mintedAtIso = mintedAt.toISOString();

  for (;;) {
    await deps.sleep(POLL_INTERVAL_MS);

    // Loaded fresh every tick (rather than once, up front) so a corrupt devices.json follows the
    // CLI's own exit-1 contract instead of throwing out of registry.list() uncaught, and so this
    // loop always sees whatever the bridge process most recently wrote.
    const registry = loadRegistry(deps);
    if (isRegistryError(registry)) {
      deps.stderr(registry.error);
      return 1;
    }

    // A second `pair` run, or a bridge restart, mints its own code and overwrites pairing.json
    // while this run is still waiting. `pairedAt >= mintedAtIso` alone can't tell that device
    // apart from one enrolled under our own code, so check the persisted mintedAt (the field the
    // pairing store itself writes) against the one we minted before trusting any match below. A
    // corrupt/unparsable file is left to the existing registry/expiry checks rather than treated
    // as a supersession.
    if (existsSync(pairingPath)) {
      let currentMintedAt: string | undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(pairingPath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as { mintedAt?: unknown }).mintedAt === "string") {
          currentMintedAt = (parsed as { mintedAt: string }).mintedAt;
        }
      } catch (cause) {
        // Only the file vanishing between the exists() check above and this read is expected --
        // the pairing store's own burn-on-verify race this block exists to handle. Anything else
        // (invalid JSON, EACCES, ...) is a real problem: report it and stop rather than silently
        // treating it as "no supersession" and looping forever.
        if (!isEnoent(cause)) {
          deps.stderr(`${pairingPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
          return 1;
        }
        currentMintedAt = undefined;
      }
      if (currentMintedAt !== undefined && currentMintedAt !== mintedAtIso) {
        deps.stderr("pairing code was replaced by another pair run or a bridge restart; re-run pair");
        return 1;
      }
    }

    const paired = registry.list().find((device) => device.pairedAt >= mintedAtIso);
    if (paired !== undefined) {
      deps.stdout(`Paired device ${paired.deviceId} (${paired.deviceName})`);
      return 0;
    }

    if (!existsSync(pairingPath)) {
      // server.ts's /v1/pair handler burns pairing.json (PairingCodeStore.verify) before it
      // calls registry.register(record): a tick can land in the gap between those two writes and
      // see pairing.json already gone with the device not yet on disk. Re-check once more before
      // declaring the code used up, so that gap doesn't get reported as a failed pairing.
      // Known residual: if another pair run mints, pairs and burns a code within one tick, its
      // device is reported here. Display only; /v1/pair decides access. Run `devices` to confirm.
      const recheck = loadRegistry(deps);
      const recheckPaired = isRegistryError(recheck)
        ? undefined
        : recheck.list().find((device) => device.pairedAt >= mintedAtIso);
      if (recheckPaired !== undefined) {
        deps.stdout(`Paired device ${recheckPaired.deviceId} (${recheckPaired.deviceName})`);
        return 0;
      }
      deps.stderr("Pairing code was used up before a device paired.");
      return 1;
    }

    if (deps.now().getTime() - mintedAt.getTime() >= PAIRING_TTL_MS) {
      deps.stderr("Pairing code expired before a device paired.");
      return 1;
    }
  }
}

/** Every private IPv4/private-range-or-not address on a non-internal interface, in the order
 * `os.networkInterfaces()` reports them — good enough for "which address is my LAN address"
 * without a routing-table lookup, which Node/Bun have no portable API for. */
function nonInternalIPv4Addresses(): string[] {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (entries === undefined) {
      continue;
    }
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
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
    (record) => record !== undefined && record.allowedProjects.includes(projectId),
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

if (import.meta.main) {
  const port = process.env.PORT ?? String(DEFAULT_PORT);
  const deps: CliDeps = {
    stateDir: resolveStateDir(),
    now: () => new Date(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    health: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) {
          return null;
        }
        return (await response.json()) as CliHealth;
      } catch {
        return null;
      }
    },
    env: process.env,
    cwd: process.cwd(),
  };

  const exitCode = await runCli(process.argv.slice(2), deps);
  process.exit(exitCode);
}

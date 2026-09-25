// The Agent Remote bridge admin CLI: `bun run bridge pair|devices|revoke|projects ...`.
//
// This module deliberately does NOT import server.ts. It edits devices.json/pairing.json in the
// state dir directly, exactly the way the old AGENTREMOTE_PAIR/AGENTREMOTE_REVOKE/
// AGENTREMOTE_LIST_DEVICES one-shot env vars did: a running bridge notices the change on its next
// request via DeviceRegistry.reloadIfChanged / PairingCodeStore.verify's reload (see
// bridge/src/auth/devices.ts and bridge/src/auth/pairing.ts). Importing server.ts would pull in
// the HTTP server, the command journal and bridge.lock — none of which this CLI may touch, since
// it has to work correctly while a bridge process already holds the lock.
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";

import type { Project } from "@agentremote/protocol";

import { DeviceRegistry, resolveStateDir, type DeviceRecord } from "./auth/devices";
import { formatPairingCode, PairingCodeStore } from "./auth/pairing";
import { projectIdFor, resolveProjectIds } from "./projects";

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

async function runPair(args: string[], deps: CliDeps): Promise<number> {
  const { flags } = splitFlags(args, ["--no-wait"]);
  const noWait = flags.has("--no-wait");

  const store = new PairingCodeStore(pairingFilePath(deps.stateDir));
  const mintedAt = deps.now();
  const code = store.mint(mintedAt);
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

  const registry = new DeviceRegistry(devicesFilePath(deps.stateDir));
  const pairingPath = pairingFilePath(deps.stateDir);
  const mintedAtIso = mintedAt.toISOString();

  for (;;) {
    await deps.sleep(POLL_INTERVAL_MS);

    const paired = registry.list().find((device) => device.pairedAt >= mintedAtIso);
    if (paired !== undefined) {
      deps.stdout(`Paired device ${paired.deviceId} (${paired.deviceName})`);
      return 0;
    }

    if (!existsSync(pairingPath)) {
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

function runRevoke(args: string[], deps: CliDeps): number {
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

  registry.revoke(deviceId, deps.now());
  deps.stdout(`Revoked device: ${deviceId}`);
  return 0;
}

function runProjectsList(deps: CliDeps): number {
  let projects: Project[];
  try {
    projects = resolveProjectIds(deps.env, deps.cwd);
  } catch (cause) {
    deps.stderr(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }

  const registry = loadRegistry(deps);
  if (isRegistryError(registry)) {
    deps.stderr(registry.error);
    return 1;
  }

  deps.stdout("Current projects:");
  for (const project of projects) {
    deps.stdout(`  ${project.id}\t${project.path}`);
  }

  deps.stdout("Devices:");
  for (const device of registry.list()) {
    deps.stdout(`  ${device.deviceId}\t${device.allowedProjects.join(",") || "-"}`);
  }
  return 0;
}

function runProjectsAllow(args: string[], deps: CliDeps): number {
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
    let currentProjectIds: Set<string>;
    try {
      currentProjectIds = new Set(resolveProjectIds(deps.env, deps.cwd).map((project) => project.id));
    } catch (cause) {
      deps.stderr(cause instanceof Error ? cause.message : String(cause));
      return 1;
    }
    if (!currentProjectIds.has(projectId)) {
      deps.stderr(`${projectId} is not a current project. Pass --force to allow it anyway.`);
      return 1;
    }
  }

  registry.setAllowedProjects(deviceId, [...device.allowedProjects, projectId]);
  deps.stdout(`Allowed ${projectId} for ${deviceId}`);
  return 0;
}

function runProjectsDeny(args: string[], deps: CliDeps): number {
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

  registry.setAllowedProjects(
    deviceId,
    device.allowedProjects.filter((id) => id !== projectId),
  );
  deps.stdout(`Denied ${projectId} for ${deviceId}`);
  return 0;
}

function runProjects(args: string[], deps: CliDeps): number {
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
      return runRevoke(rest, deps);
    case "projects":
      return runProjects(rest, deps);
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

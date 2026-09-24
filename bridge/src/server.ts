import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  digest,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentEventPayloadMap,
  type AgentEventType,
  type AgentProvider,
  type Command,
  type CommandResponse,
  type EventsResponse,
  type Project,
  type ProjectsResponse,
  type ProviderHost,
  type Session,
  type SessionsResponse,
  SessionLimitError,
  TurnInProgressError,
  UnknownSessionError,
} from "@agentremote/protocol";
import { ClaudeProvider } from "@agentremote/provider-claude";

import { ApprovalBindingMismatchError, InteractionPendingError, MockProvider, type MockProviderOptions } from "./providers/mock";
// command.schema.json lives outside bridge's package boundary in protocol/, imported the same
// way protocol/typescript/src/index.test.ts does.
import commandSchema from "../../protocol/schema/command.schema.json";
import { deriveDeviceKey, formatPairingCode, keyIdFor, PairingCodeStore } from "./auth/pairing";
import { DeviceRegistry, resolveStateDir, type DeviceRecord } from "./auth/devices";
import { atomicWriteFileSync } from "./auth/persist";
import { NonceCache, verifyEnvelope } from "./auth/verify";
import { CommandJournal } from "./state/commands";
import { EventLog } from "./state/event-log";
import { InteractionRegistry } from "./state/interactions";
import { createNonceJournal } from "./state/nonces";
import { SessionIndex } from "./state/sessions";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
// Compiled once at module load, not per request: ajv.compile does schema analysis work that
// only needs to happen once for a schema that never changes at runtime.
// ajv infers the validated type from the JSON schema's own shape, which is far looser than
// the hand written Command union (e.g. it cannot express the oneOf-by-`type` discriminant).
// The explicit type parameter here is what index.test.ts relies on the schema doing implicitly;
// asserting Command afterwards mirrors that test's usage.
const validateCommand = ajv.compile<Command>(commandSchema);

/** Hard ceiling on how long a long poll may hold a connection open. */
const MAX_WAIT_SECONDS = 30;
const DEFAULT_PORT = 8787;

/** The bootstrap hook every provider offers so `createBridge` can seed a demo session without
 * going through `createSession` (which would emit `session.started` before anyone is
 * listening). Not part of the public `AgentProvider` contract. */
interface SeedableProvider extends AgentProvider {
  seedSession(session: Session): void;
}

export interface Bridge {
  /** The request handler, usable directly in tests or through `Bun.serve`. */
  fetch(request: Request): Promise<Response>;
  /** The seeded session, exposed so callers do not have to guess its identifier. */
  readonly session: Session;
  readonly provider: AgentProvider;
  /** `brg_` + 8 hex, stable for this process and persisted alongside the device registry so a
   * client can notice it is talking to a different bridge after a restart. */
  readonly bridgeId: string;
  /** The pairing code minted at startup, per docs/pairing-v0.md. Production only prints it (see
   * `import.meta.main` below); exposed here so tests can pair without scraping stdout. */
  readonly pairingCode: string;
  /** ISO timestamp the minted `pairingCode` expires at. */
  readonly pairingCodeExpiresAt: string;
  /** Releases the single-writer lock (see the "Single-writer lock" comment in `createBridge`)
   * so the same state dir can be reopened, e.g. by a test's `restart()` helper or a graceful
   * shutdown. Idempotent; safe to call when there was no state dir to lock. */
  close(): void;
}

/** Options accepted by `createBridge`. Only `createClaudeProvider` exists for tests: it lets a
 * test wire `AGENTREMOTE_PROVIDER=claude` without constructing a real `ClaudeProvider`, which
 * would spawn the Claude Agent SDK's subprocess. Production code never passes it, so the
 * default keeps building the real `ClaudeProvider` exactly as before. The auth-related options
 * below exist for the same reason: tests need to inject a registry/clock/auth-off flag without
 * ever touching the real `~/.agentremote`; production always uses the defaults. */
export interface CreateBridgeOptions {
  createClaudeProvider?: (host: ProviderHost, options: { projects: Project[] }) => SeedableProvider;
  /** Injects a `DeviceRegistry` instance directly, e.g. so a test can inspect registered
   * devices in memory. Production always builds its own from `devicesFilePath`. */
  registry?: DeviceRegistry;
  /** Explicit path for the persisted device registry (and the co-located bridge id file);
   * defaults to `resolveStateDir()/devices.json`. Tests point this at a temp dir. Ignored when
   * `registry` is supplied. */
  devicesFilePath?: string;
  /** Explicit path for the persisted live pairing code; defaults to alongside `devicesFilePath`
   * as `pairing.json`. Persisting it (rather than keeping it in the bridge process's memory
   * only) is what lets `AGENTREMOTE_PAIR=1` mint a code the already-running bridge can see. */
  pairingCodeFilePath?: string;
  /** Clock used for pairing TTL, signature skew, nonce TTL and device timestamps. Production
   * uses the real clock; tests pass a fixed one for determinism. */
  now?: () => Date;
  /** Overrides `AGENTREMOTE_AUTH` for tests. Production reads the environment variable. */
  authEnabled?: boolean;
  /** Passed straight through to `MockProvider` when it is the selected provider. Exists so tests
   * can exercise its approval/question expiry timers with a short `ttlMs` instead of waiting out
   * the production default. Ignored when `AGENTREMOTE_PROVIDER=claude`. */
  mockProviderOptions?: MockProviderOptions;
}

/** Every command type a newly paired device is granted, per the "Device registry" section of
 * docs/pairing-v0.md: a new device is granted every action. Kept in sync with `CommandType`. */
const ALL_COMMAND_ACTIONS = [
  "prompt.send",
  "approval.accept",
  "approval.reject",
  "session.cancel",
  "question.answer",
  "session.create",
] as const;

/** Loads a bridge id from `filePath`, minting and persisting a fresh one if the file is absent
 * or corrupt. `filePath === undefined` means "do not persist" (an in-memory-only registry in
 * tests), in which case a fresh id is minted every call. */
function loadOrCreateBridgeId(filePath: string | undefined): string {
  if (filePath !== undefined && existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      // JSON.parse is untyped by construction; validated below before anything is trusted.
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).bridgeId === "string") {
        return (parsed as { bridgeId: string }).bridgeId;
      }
    } catch {
      // Falls through to minting a fresh id: a corrupt bridge-id file must not crash startup.
    }
  }

  const bridgeId = `brg_${randomBytes(4).toString("hex")}`;
  if (filePath !== undefined) {
    atomicWriteFileSync(filePath, JSON.stringify({ bridgeId }));
  }
  return bridgeId;
}

const VALID_PROVIDER_IDS = ["mock", "claude"] as const;
type ValidProviderId = (typeof VALID_PROVIDER_IDS)[number];

function isValidProviderId(value: string): value is ValidProviderId {
  return (VALID_PROVIDER_IDS as readonly string[]).includes(value);
}

// Derives a stable project id from an absolute directory: the basename for readability, plus
// a digest suffix of the full path so two projects sharing a basename (e.g. two checkouts
// both named "app") never collide.
export function projectIdFor(dir: string): string {
  const base = dir.split("/").filter((part) => part.length > 0).at(-1) ?? "project";
  const slug = base.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const suffix = digest(dir).replace("sha256:", "").slice(0, 8);
  return `prj_${slug}_${suffix}`;
}

// `unknown` is genuinely the right type here: this helper serialises whatever a route hands
// it, including error shapes that are not part of the protocol, and it only ever passes the
// value to JSON.stringify.
function isAcceptedResponse(body: unknown): body is CommandResponse {
  return typeof body === "object" && body !== null && (body as Partial<CommandResponse>).accepted === true;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createBridge(options: CreateBridgeOptions = {}): Bridge {
  // Only an UNSET AGENTREMOTE_PROVIDER may default to "mock". A set-but-unrecognized value
  // (e.g. a typo) must fail startup loudly instead of silently running MockProvider, which
  // would look like a healthy real session to anyone watching the event log.
  const rawProviderId = process.env.AGENTREMOTE_PROVIDER;
  const providerId = rawProviderId === undefined ? "mock" : rawProviderId.trim();
  if (!isValidProviderId(providerId)) {
    throw new Error(
      `invalid AGENTREMOTE_PROVIDER: "${providerId}" (valid values: ${VALID_PROVIDER_IDS.join(", ")})`,
    );
  }
  console.log(`Agent Remote bridge selected provider: ${providerId}`);

  const now = options.now ?? ((): Date => new Date());
  const authEnabled = options.authEnabled ?? process.env.AGENTREMOTE_AUTH !== "off";

  const devicesFilePath = options.devicesFilePath ?? path.join(resolveStateDir(), "devices.json");
  const registry = options.registry ?? DeviceRegistry.load(devicesFilePath);
  const SKEW_MS = 120_000; // 120 seconds in either direction, per docs/pairing-v0.md.

  // Durable bridge state lives next to the device registry, per docs/durability-v0.md. The same
  // guard the bridge id and pairing code use applies: an injected in-memory registry with no
  // explicit devices path has no state dir to write into, so every journal stays in memory.
  const stateDirPath =
    options.registry !== undefined && options.devicesFilePath === undefined
      ? undefined
      : path.dirname(devicesFilePath);
  const journalPath = (name: string): string | undefined =>
    stateDirPath === undefined ? undefined : path.join(stateDirPath, name);

  // Single-writer lock: two bridges pointed at the same state dir would otherwise race on the
  // nonce/command/event journals and hand out duplicate event ids before EADDRINUSE ever fires
  // (docs/durability-v0.md). Only enforced when there is a real state dir to protect; an
  // injected in-memory registry (tests) has nothing to lock.
  let releaseLock: (() => void) | undefined;
  if (stateDirPath !== undefined) {
    const lockPath = path.join(stateDirPath, "bridge.lock");
    // The lock is the first thing written into the state dir, so on a fresh install the dir does
    // not exist yet and an exclusive create would fail ENOENT and refuse startup. Created with
    // the same 0700 mode atomicWriteFileSync uses for every other file under this dir.
    mkdirSync(stateDirPath, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const holderPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      let holderAlive = false;
      if (Number.isFinite(holderPid)) {
        try {
          process.kill(holderPid, 0);
          holderAlive = true;
        } catch {
          holderAlive = false;
        }
      }
      if (holderAlive) {
        throw new Error(
          `Another Agent Remote bridge (pid ${holderPid}) already holds the lock at ${lockPath}. ` +
            "Stop that process before starting a new one against the same state directory.",
        );
      }
      // Lock left behind by a process that died without cleaning up: take it over. Two
      // processes can observe the same stale lock at the same instant, so the takeover must
      // decide a single winner instead of both overwriting the file:
      //   1. rename() the stale lock out of the way. rename is atomic and consumes the name, so
      //      exactly one of the two renames can see the stale file; the loser gets ENOENT and
      //      refuses to boot rather than becoming a second writer.
      //   2. The winner may still have renamed away a lock the other process had *already*
      //      re-created (it got through step 1 and step 3 first), so the claimed file's content
      //      is checked against the stale pid we probed. A different pid means we took someone
      //      else's live lock: it is put back and this process refuses to boot.
      //   3. Re-create the lock with the exclusive `wx` flag, never a plain overwrite, so a
      //      third process that slipped in between wins and this one refuses (EEXIST).
      const claimPath = `${lockPath}.claim.${process.pid}.${randomBytes(4).toString("hex")}`;
      try {
        renameSync(lockPath, claimPath);
      } catch {
        throw new Error(
          `Another Agent Remote bridge took over the stale lock at ${lockPath} first. ` +
            "Retry once that process has settled.",
        );
      }
      const claimedPid = readFileSync(claimPath, "utf8").trim();
      if (claimedPid !== String(holderPid)) {
        // Not the stale lock we probed: restore it and leave the winner holding it.
        try {
          renameSync(claimPath, lockPath);
        } catch {
          // ignore: the winner has already re-created its own lock under that name.
        }
        throw new Error(
          `Another Agent Remote bridge (pid ${claimedPid}) claimed the lock at ${lockPath} ` +
            "while this one was taking it over. Stop that process before starting a new one " +
            "against the same state directory.",
        );
      }
      unlinkSync(claimPath);
      try {
        writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      } catch (takeoverError) {
        if ((takeoverError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw takeoverError;
        }
        throw new Error(
          `Another Agent Remote bridge acquired the lock at ${lockPath} during takeover. ` +
            "Stop that process before starting a new one against the same state directory.",
        );
      }
    }
    let lockReleased = false;
    releaseLock = (): void => {
      if (lockReleased) {
        return;
      }
      lockReleased = true;
      // Best effort: on process exit a failed unlink cannot be reported anywhere useful, and on
      // an explicit close() a stale lock is still recovered by the liveness probe above.
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    };
    process.on("exit", releaseLock);

    // Every journal is opened for append once now, so a state file the bridge cannot write (wrong
    // owner, read-only mode, a directory in its place) stops startup with the path in the error
    // instead of surfacing later as a failed request and a console.error per write.
    for (const name of ["nonces.jsonl", "events.jsonl", "sessions.jsonl", "commands.jsonl"]) {
      const filePath = path.join(stateDirPath, name);
      try {
        closeSync(openSync(filePath, "a", 0o600));
      } catch (error) {
        releaseLock();
        throw new Error(
          `Agent Remote bridge cannot write its state file ${filePath}: ${(error as NodeJS.ErrnoException).code ?? String(error)}. ` +
            "Fix its ownership or permissions, or point AGENTREMOTE_STATE_DIR at a writable directory.",
        );
      }
    }
    console.log(`Agent Remote bridge state dir: ${stateDirPath}`);
  }

  const nonces = new NonceCache({ journal: createNonceJournal(journalPath("nonces.jsonl")), now: now() });

  // An injected in-memory registry with no explicit devices path has nowhere durable to keep a
  // bridge id either, so it mints a fresh one every call; a real path (explicit or default)
  // persists it next to the registry.
  const bridgeIdFilePath = journalPath("bridge-id.json");
  const bridgeId = loadOrCreateBridgeId(bridgeIdFilePath);

  // Mirrors the bridgeIdFilePath guard just above: an injected in-memory registry with no
  // explicit devices path has no durable state dir to persist into either, so the pairing code
  // stays in-memory only (as it always has) rather than writing into the real ~/.agentremote.
  const pairingCodeFilePath = options.pairingCodeFilePath ?? journalPath("pairing.json");
  const pairingCodeStore = new PairingCodeStore(pairingCodeFilePath);
  const pairingMintedAt = now();
  const pairingCode = pairingCodeStore.mint(pairingMintedAt);
  const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes, per docs/pairing-v0.md.
  const pairingCodeExpiresAt = new Date(pairingMintedAt.getTime() + PAIRING_TTL_MS).toISOString();

  // The event log and the command journal are both durable (docs/durability-v0.md): a client
  // reconnecting after a bridge restart resolves its cursor against retained events, and a retry
  // of a command the previous process already applied still gets that command's recorded answer.
  const eventLog = new EventLog(journalPath("events.jsonl"), { now: now() });
  const sessionIndex = new SessionIndex(journalPath("sessions.jsonl"), { now: now() });
  const commands = new CommandJournal(journalPath("commands.jsonl"), { now: now() });

  // Approval/question lifecycle, per the interaction registry this slice adds. Not durable on
  // its own (see interactions.ts's class doc): it only reacts to events already appended to the
  // durable `eventLog` above, so a restart rebuilds it from that log instead of persisting a
  // second copy of the same state.
  const interactions = new InteractionRegistry();
  interactions.rebuild(eventLog.all());

  // Project of every session this process has started or seeded, which is what each emitted
  // event is stamped with. Separate from `sessionIndex`: that one survives restarts to authorize
  // events from a previous boot, this one is the current boot's truth about a live session.
  const liveProjectOf = new Map<string, string>();

  const waiters = new Set<() => void>();
  // Reserves a command id for the duration of its execution, so two retries that arrive at
  // the same time cannot both pass the journal check and run the command twice. A retry that
  // arrives while the original is still running waits on `outcome` and gets the original's
  // answer (docs/protocol-v0.md: same command identity, same eventual outcome), instead of a
  // placeholder that could disagree with what the original request finally reports.
  interface InFlightCommand {
    digest: string;
    deviceId: string | null;
    outcome: Promise<{ status: number; body: unknown }>;
  }
  const inFlight = new Map<string, InFlightCommand>();

  // Per-session serialization: two commands (or a command and the dedicated cancel route)
  // targeting the same session must not interleave between the interaction-pending check and the
  // provider call that acts on it, or two devices racing to decide the same approval could both
  // pass the check before either resolves it. `inFlight`/`CommandJournal` already dedupe a retried
  // commandId; this instead orders distinct commandIds against each other, and only within one
  // session — a different session's commands are never held up by this chain.
  const sessionLocks = new Map<string, Promise<void>>();

  async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = sessionLocks.get(sessionId) ?? Promise.resolve();
    // A prior turn's rejection must not wedge every later command for this session; only its
    // completion (success or failure) matters for ordering.
    const gate = prior.then(
      () => undefined,
      () => undefined,
    );
    let release: () => void;
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionLocks.set(sessionId, marker);
    await gate;
    try {
      return await fn();
    } finally {
      release!();
      // Only the last-enqueued caller for this session removes the entry, so the map never
      // retains a stale marker for a session that has since gone idle, but also never drops a
      // marker a still-waiting caller needs.
      if (sessionLocks.get(sessionId) === marker) {
        sessionLocks.delete(sessionId);
      }
    }
  }
  // Set once the provider instance exists (below); host.emit reads it lazily so an event's
  // `provider` tag always reflects what actually constructed/ran the session (provider.id),
  // never the raw env string, and so it can never diverge from session.provider.
  let emittedProviderId: string = providerId;

  const wake = (): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter();
    }
  };

  const host: ProviderHost = {
    emit<T extends AgentEventType>(
      sessionId: string,
      type: T,
      payload: AgentEventPayloadMap[T],
    ): AgentEvent {
      // The project an event belongs to is decided here, once, and travels with the event. A
      // reader must not have to re-resolve it: by then the session may be gone from the
      // provider, or its id handed out again for another project, and either would silently
      // change who may read events that were emitted long before. `session.started` carries the
      // binding in its own payload; every later event reads `liveProjectOf`, which this process
      // populated from that same payload. The durable `sessionIndex` is deliberately not
      // consulted here: it is first-bind-wins across restarts, so for a reused session id it
      // holds the *previous* boot's project and would stamp new events with a stale one. An
      // event whose session has no binding in this process leaves the field unset, which the
      // read path fails closed on for a project-narrowed device.
      if (type === "session.started") {
        liveProjectOf.set(sessionId, (payload as AgentEventPayloadMap["session.started"]).projectId);
      }
      const projectId = liveProjectOf.get(sessionId);

      // An AgentEventEnvelope<T> is structurally one member of the AgentEvent union, but
      // TypeScript cannot verify that while T is still an unresolved type parameter, so the
      // envelope is asserted once here instead of weakening the public types.
      const event = {
        eventId: eventLog.takeEventId(),
        sessionId,
        ...(projectId === undefined ? {} : { projectId }),
        provider: emittedProviderId,
        type,
        timestamp: new Date().toISOString(),
        payload,
      } as AgentEventEnvelope<T> as AgentEvent;
      try {
        eventLog.append(event);
      } catch (error) {
        // journal.ts now throws on a real fs failure instead of swallowing it. An event that
        // could not be persisted must not be reported as delivered (durability contract), but a
        // single append failure also must not take down the whole bridge process, so it is
        // surfaced loudly here and then the request path continues to fail below.
        console.error(
          `Failed to persist event ${event.eventId} (session ${sessionId}, type ${type}) to the event log:`,
          error,
        );
        throw error;
      }
      // The registry only ever reacts to events that made it durably into the log above, so a
      // process that crashed between the append and this call rebuilds the same state from the
      // log on its next start instead of ever observing a half-persisted event.
      interactions.observe(event);
      if (type === "session.started") {
        try {
          sessionIndex.record(sessionId, (payload as AgentEventPayloadMap["session.started"]).projectId, now());
        } catch (error) {
          // The event itself is already durably appended above; this binding only backs the
          // per-device project filter for retained events after a restart, so a failure here must
          // not undo the emit or crash the caller — it is logged loudly instead of buried.
          console.error(
            `Failed to durably record project binding for session ${sessionId} (event ${event.eventId}):`,
            error,
          );
        }
      }
      wake();
      return event;
    },
    eventsAfter(after: number): AgentEvent[] {
      return eventLog.after(after);
    },
    waitForChange(timeoutMs: number): Promise<void> {
      return new Promise((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };

  let provider: SeedableProvider;
  let seedProjectId: string;
  if (providerId === "claude") {
    // A blank or whitespace-only value is treated the same as unset, so a stray
    // `AGENTREMOTE_PROJECT_DIRS=` in the environment falls back to cwd instead of leaving
    // projects empty and crashing seedSession's later "unknown projectId" lookup. The same
    // fallback applies when the value parses to zero usable directories (e.g. all commas or
    // whitespace-only entries), so that case cannot crash startup either.
    const rawDirs = process.env.AGENTREMOTE_PROJECT_DIRS;
    const parsedDirs =
      rawDirs === undefined
        ? []
        : rawDirs
            .split(",")
            .map((dir) => dir.trim())
            .filter((dir) => dir.length > 0);
    for (const dir of parsedDirs) {
      if (!path.isAbsolute(dir)) {
        throw new Error(`AGENTREMOTE_PROJECT_DIRS must contain only absolute paths, got: "${dir}"`);
      }
    }
    const dirs = parsedDirs.length > 0 ? parsedDirs : [process.cwd()];
    const projects: Project[] = dirs.map((dir) => ({ id: projectIdFor(dir), name: dir.split("/").filter((p) => p.length > 0).at(-1) ?? dir, path: dir }));
    const createClaudeProvider = options.createClaudeProvider ?? ((h, o) => new ClaudeProvider(h, o));
    provider = createClaudeProvider(host, { projects });
    seedProjectId = projects[0]?.id ?? projectIdFor(process.cwd());
  } else {
    provider = new MockProvider(host, options.mockProviderOptions);
    seedProjectId = "prj_demo";
  }
  emittedProviderId = provider.id;

  const seedTimestamp = now().toISOString();
  const session: Session = {
    id: "ses_seed",
    projectId: seedProjectId,
    provider: provider.id,
    state: "idle",
    createdAt: seedTimestamp,
    updatedAt: seedTimestamp,
    title: "demo",
  };
  provider.seedSession(session);
  // The seeded session never emits `session.started`, so its binding is registered directly;
  // without it every event the seeded session emits would be unstamped and invisible to a
  // project-narrowed device.
  liveProjectOf.set(session.id, session.projectId);
  try {
    sessionIndex.record(session.id, session.projectId, now());
  } catch (error) {
    // Same rationale as the emit-path guard above: the seeded session itself already exists in
    // the provider, so a failure here must not crash startup, only be surfaced loudly.
    console.error(`Failed to durably record project binding for seeded session ${session.id}:`, error);
  }

  /** Runs one command. Returns the new session id when the command created a session. */
  async function execute(command: Command): Promise<string | undefined> {
    switch (command.type) {
      case "prompt.send":
        await provider.sendPrompt(command.sessionId, command.payload.text);
        return undefined;
      case "approval.accept":
        await provider.approve(command.sessionId, command.payload.binding);
        return undefined;
      case "approval.reject":
        await provider.reject(command.sessionId, command.payload.binding, command.payload.reason);
        return undefined;
      case "session.cancel":
        await provider.cancel(command.sessionId);
        return undefined;
      case "question.answer":
        await provider.answerQuestion(command.sessionId, command.payload);
        return undefined;
      case "session.create": {
        // createSession emits session.started itself, so the bridge must not emit it again.
        const created = await provider.createSession(command.payload.projectId);
        // A provider that emits session.started has already bound this id (emit binds it from
        // that payload). One that does not still needs the binding recorded, or every event it
        // emits under this session is unstamped and therefore invisible to a project-narrowed
        // device. Overwriting is intentional: a provider that hands out a session id it used
        // before, under a different project, has genuinely rebound it for this process, and the
        // events already emitted under the old project keep the stamp they were given.
        liveProjectOf.set(created.id, created.projectId);
        return created.id;
      }
    }
  }

  async function sessionExists(sessionId: string): Promise<boolean> {
    const sessions = await provider.listSessions();
    return sessions.some((session) => session.id === sessionId);
  }

  /** The approval/question id a decision command targets, or undefined for a command that does
   * not target one. */
  function interactionIdFor(command: Command): string | undefined {
    switch (command.type) {
      case "approval.accept":
      case "approval.reject":
        return command.payload.binding.approvalId;
      case "question.answer":
        return command.payload.questionId;
      default:
        return undefined;
    }
  }

  // Maps the protocol error types a provider call can throw to the HTTP response both
  // handleCommand and the cancel route return for them, so the two call sites stay in sync.
  // Returns undefined for anything else, which the caller should rethrow.
  // `unknown`: this narrows a caught value (a catch clause's type), not an unchecked passthrough.
  function mapProviderError(error: unknown): Response | undefined {
    if (
      error instanceof ApprovalBindingMismatchError ||
      error instanceof InteractionPendingError ||
      error instanceof TurnInProgressError
    ) {
      return json({ error: error.message }, 409);
    }
    if (error instanceof UnknownSessionError) {
      return json({ error: error.message }, 404);
    }
    // Capacity, not a bad request: 429 tells the client to retry later (after cancelling a
    // session) rather than to change what it sent.
    if (error instanceof SessionLimitError) {
      return json({ error: error.message, code: "session_limit" }, 429);
    }
    return undefined;
  }

  async function handleCommand(rawBody: string, device: DeviceRecord | undefined): Promise<Response> {
    // The body is untrusted network input: parse it as unknown JSON first (never asserted as
    // Command) and let the ajv schema validator, not a type cast, decide whether it is one.
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "invalid_command", details: [{ instancePath: "", message: "malformed JSON" }] }, 400);
    }

    if (!validateCommand(body)) {
      const details = (validateCommand.errors ?? []).map((error) => ({
        instancePath: error.instancePath,
        message: error.message ?? "invalid",
      }));
      return json({ error: "invalid_command", details }, 400);
    }
    const command = body;

    // Command authorization, per the "Command authorization" section of docs/pairing-v0.md.
    // Runs only when the envelope was actually verified (`device` set); the AGENTREMOTE_AUTH=off
    // bypass skips it entirely, exactly as it skipped envelope verification.
    if (device !== undefined) {
      // 1. Allowed action.
      if (!device.allowedActions.includes(command.type)) {
        return json({ error: "action_not_allowed" }, 403);
      }

      // 2. Project. session.create checks payload.projectId directly; every other command type
      // resolves the session's project from the provider, so revoking a project also cuts off
      // sessions already running in it. An unresolvable session falls through to the "Session"
      // check below, which already reports it as invalid_command.
      const commandProjectId =
        command.type === "session.create"
          ? command.payload.projectId
          : (await provider.listSessions()).find((session) => session.id === command.sessionId)?.projectId;
      if (commandProjectId !== undefined && !device.allowedProjects.includes(commandProjectId)) {
        return json({ error: "project_not_allowed" }, 403);
      }
    }

    // session.create's envelope sessionId is a client generated placeholder the bridge does
    // not route on (see the comment on SessionCreatePayload in protocol/typescript/src/index.ts);
    // every other command type must reference a session that actually exists, otherwise a typo
    // session id would emit orphan events no one is listening for.
    if (command.type !== "session.create") {
      if (!(await sessionExists(command.sessionId))) {
        return json({ error: "invalid_command", details: [{ instancePath: "/sessionId", message: `unknown sessionId: ${command.sessionId}` }] }, 400);
      }
    }

    if (command.type === "session.create") {
      if (command.payload.provider !== provider.id) {
        return json({ error: `unknown provider: ${command.payload.provider}` }, 400);
      }
      const projects = await provider.listProjects();
      if (!projects.some((project) => project.id === command.payload.projectId)) {
        return json(
          {
            error: "invalid_command",
            details: [{ instancePath: "/payload/projectId", message: `unknown projectId: ${command.payload.projectId}` }],
          },
          400,
        );
      }
    }

    // Request identity and idempotency, now durable (docs/durability-v0.md). commandId stays the
    // idempotency key; the journal stores the SHA-256 of the exact body and the issuing device
    // with it, and survives a restart. A repeat with a different digest or from a different
    // device is a conflict, not a replay, and must not execute. This whole check-then-set stays
    // unlocked and runs synchronously with no `await` in between, exactly as before: that is what
    // makes it atomic against a truly concurrent retry of the same commandId (two requests racing
    // for the same commandId still only ever see one winner, whichever's synchronous turn runs
    // first), and is a separate concern from the per-session lock below, which instead orders
    // *different* commandIds against each other.
    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
    const deviceId = device?.deviceId ?? null;
    commands.prune(now());

    const entry = commands.get(command.commandId);
    if (entry !== undefined) {
      if (entry.digest !== bodyDigest || entry.deviceId !== deviceId) {
        return json({ error: "command_id_conflict" }, 409);
      }
      if (entry.status === "completed" && entry.response !== undefined) {
        return json({ ...entry.response, duplicate: true } satisfies CommandResponse);
      }
      // Whether the provider applied this command is unknown: either the previous process died
      // mid-execution (`indeterminate` on load), or this process threw an unmapped error out of
      // `execute` and the entry is still `in_flight` with nothing executing it. Replaying it
      // could apply a decision twice; the client is told to reconcile against the event log
      // instead of being handed a made-up answer.
      if (entry.status === "indeterminate" || (entry.status === "in_flight" && !inFlight.has(command.commandId))) {
        return json({ error: "command_indeterminate", commandId: command.commandId }, 409);
      }
      // "abandoned" means the provider refused it without applying anything, so the same
      // command id may be retried and falls through to execution below.
    }

    const running = inFlight.get(command.commandId);
    if (running !== undefined) {
      // No journal entry is written until `commands.begin` inside the gate, so the identity check
      // the journal branch above does has to be repeated against the in-flight claim itself.
      if (running.digest !== bodyDigest || running.deviceId !== deviceId) {
        return json({ error: "command_id_conflict" }, 409);
      }
      let original: { status: number; body: unknown };
      try {
        original = await running.outcome;
      } catch (error) {
        // The original threw an unmapped error: whether the provider applied it is unknown, which
        // is exactly what a later retry is told once the journal entry is left `in_flight`.
        console.error(
          `Retry of command ${command.commandId} waited on an original that threw; reporting indeterminate`,
          error,
        );
        return json({ error: "command_indeterminate", commandId: command.commandId }, 409);
      }
      if (isAcceptedResponse(original.body)) {
        return json({ ...original.body, duplicate: true } satisfies CommandResponse, original.status);
      }
      return json(original.body, original.status);
    }

    // From here on this request holds an exclusive claim on `command.commandId` (below), but a
    // *different* commandId for the same session — a second device's decision, or a cancel — can
    // still race it up to this point. The interaction gate and the provider call itself run
    // inside the per-session lock so two such commands serialize: the loser sees the winner's
    // effect on the interaction registry and the command journal instead of both passing the
    // pending check before either resolves it. `session.create` has no real session yet — its
    // envelope sessionId is a client generated placeholder (see the comment on
    // SessionCreatePayload) — so it never enters the lock.
    const runGatedCommand = async (): Promise<Response> => {
      // Interaction gate. A decision command (approval.accept/reject, question.answer) names the
      // interaction it targets; refuse it unless that interaction is still pending for THIS
      // session. A record belonging to another session is reported as "not_found" rather than
      // its real state, and an id with no record at all gets the same "not_found" body, so a
      // device probing ids cannot tell "exists in another session" from "never existed". No
      // record is safe to refuse: every provider event passes through `observe` in `host.emit`,
      // the cap never evicts a pending record, and provider sessions do not survive a restart,
      // so an id the registry has not seen cannot be pending in the provider either.
      // Neither check below ever calls `commands.begin`, so neither leaves a journal entry
      // behind; the in-flight claim is released by the caller once this settles, and a retry
      // that arrived meanwhile gets the same refusal.
      // Expiry. approval.accept/reject carry payload.binding.expiresAt; a binding whose deadline
      // already passed is rejected here, before the provider's own (live-binding) check ever
      // runs. It runs before the interaction gate because it reads only the caller's own binding,
      // so a 410 reveals nothing about any registry record. Checked regardless of auth: the deadline is carried in the signed/unsigned command
      // body either way, and a decision past it must never reach the provider.
      if (
        (command.type === "approval.accept" || command.type === "approval.reject") &&
        Date.parse(command.payload.binding.expiresAt) < now().getTime()
      ) {
        return json({ error: "decision_expired" }, 410);
      }
      const interactionId = interactionIdFor(command);
      if (interactionId !== undefined) {
        const record = interactions.get(interactionId);
        if (record === undefined || record.sessionId !== command.sessionId) {
          return json({ error: "interaction_not_pending", interactionId, state: "not_found" }, 409);
        }
        if (record.state !== "pending") {
          return json({ error: "interaction_not_pending", interactionId, state: record.state }, 409);
        }
      }

      // question.answer carries no binding of its own, so its deadline is whatever the registry
      // recorded from the matching question.requested (undefined means no TTL was offered, so
      // this never rejects on expiry for it).
      if (command.type === "question.answer") {
        const deadline = interactions.get(command.payload.questionId)?.expiresAt;
        if (deadline !== undefined && Date.parse(deadline) < now().getTime()) {
          return json({ error: "decision_expired" }, 410);
        }
      }

      try {
        commands.begin(command.commandId, deviceId, bodyDigest, now());
      } catch (error) {
        // begin runs BEFORE the provider call: without a durable in_flight record, a client retry
        // after a crash could re-execute this command, so a failure here must abort before
        // execution rather than proceed and only warn.
        console.error(`Failed to durably record command ${command.commandId} as in_flight before execution:`, error);
        return json({ error: "command_journal_unavailable" }, 503);
      }
      let createdSessionId: string | undefined;
      try {
        createdSessionId = await execute(command);
      } catch (error) {
        const mapped = mapProviderError(error);
        if (mapped !== undefined) {
          // A mapped provider error is a refusal before anything was applied, so the command id is
          // released for a retry rather than left looking indeterminate after a restart. The
          // refusal already happened, so it is reported either way; a failure to record it durably
          // is only logged, since silently dropping a real 409/404/429 response would be worse.
          try {
            commands.abandon(command.commandId, now());
          } catch (abandonError) {
            console.error(`Failed to durably record command ${command.commandId} as abandoned:`, abandonError);
          }
          return mapped;
        }
        // An unmapped throw is exactly the indeterminate case: the entry stays `in_flight`, and a
        // later process reading the journal will treat it as indeterminate.
        throw error;
      }

      const response: CommandResponse = {
        accepted: true,
        commandId: command.commandId,
        duplicate: false,
        ...(createdSessionId === undefined ? {} : { sessionId: createdSessionId }),
      };
      // The provider already applied this command, so `response` is reported either way; a
      // failure to durably record the outcome (or the session's project binding) below is only
      // logged, never converted into a failure response for work that already succeeded.
      try {
        commands.complete(command.commandId, response, now());
        if (createdSessionId !== undefined && command.type === "session.create") {
          sessionIndex.record(createdSessionId, command.payload.projectId, now());
        }
      } catch (error) {
        console.error(`Failed to durably record completion of command ${command.commandId}:`, error);
      }
      return json(response);
    };

    // The claim is registered synchronously, in the same turn as the journal and in-flight checks
    // above, so a concurrent retry can never slip between them. It is released once the command
    // settles however it settles; after that the journal entry answers any retry.
    const execution =
      command.type === "session.create" ? runGatedCommand() : withSessionLock(command.sessionId, runGatedCommand);
    const outcome = execution.then(async (response) => ({
      status: response.status,
      body: (await response.clone().json()) as unknown,
    }));
    inFlight.set(command.commandId, { digest: bodyDigest, deviceId, outcome });
    // A rejected outcome is reported to the caller below and to any waiting retry above; this
    // handler only keeps the rejection from surfacing as unhandled when no retry is waiting.
    outcome.then(
      () => inFlight.delete(command.commandId),
      () => inFlight.delete(command.commandId),
    );
    return await execution;
  }

  interface PairRequestBody {
    deviceId: string;
    deviceName: string;
    nonce: string;
    proof: string;
  }

  function isPairRequestBody(value: unknown): value is PairRequestBody {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record.deviceId === "string" &&
      typeof record.deviceName === "string" &&
      typeof record.nonce === "string" &&
      typeof record.proof === "string"
    );
  }

  /** `POST /v1/pair`, per the "Enrollment" section of docs/pairing-v0.md. Every failure reason
   * — malformed body, wrong code, expired code, exhausted code, malformed proof — answers the
   * same 401, so the response never tells an attacker which one it was. */
  async function handlePair(rawBody: string): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "pairing_rejected" }, 401);
    }
    if (!isPairRequestBody(body)) {
      return json({ error: "pairing_rejected" }, 401);
    }

    const result = pairingCodeStore.verify(body.proof, body.deviceId, body.deviceName, body.nonce, now());
    if (!result.ok) {
      return json({ error: "pairing_rejected" }, 401);
    }

    const deviceKey = deriveDeviceKey(result.code, body.deviceId, body.nonce);
    const keyId = keyIdFor(deviceKey);
    const pairedAt = now().toISOString();
    const projects = await provider.listProjects();

    const record: DeviceRecord = {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      keyId,
      deviceKeyHex: deviceKey.toString("hex"),
      pairedAt,
      allowedProjects: projects.map((project) => project.id),
      allowedActions: [...ALL_COMMAND_ACTIONS],
      revokedAt: null,
      lastSeenAt: null,
    };
    registry.register(record);

    return json({
      deviceId: record.deviceId,
      keyId: record.keyId,
      pairedAt: record.pairedAt,
      bridgeId,
      allowedProjects: record.allowedProjects,
      allowedActions: record.allowedActions,
    });
  }

  async function handleEvents(url: URL, device: DeviceRecord | undefined): Promise<Response> {
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const cursor = Number.isFinite(after) && after > 0 ? after : 0;
    const requested = Number.parseInt(url.searchParams.get("wait") ?? "0", 10);
    const waitSeconds = Math.min(Number.isFinite(requested) ? Math.max(requested, 0) : 0, MAX_WAIT_SECONDS);

    let events = host.eventsAfter(cursor);
    if (events.length === 0 && waitSeconds > 0) {
      await host.waitForChange(waitSeconds * 1000);
      events = host.eventsAfter(cursor);
    }

    // `lastEventId` is always the bridge's global maximum (from `log`, never from the
    // project-filtered `events` below), even for a device narrowed to one project. If it
    // reported the highest id the device could *see* instead, a device whose only newer events
    // all belong to a filtered-out project would see an empty page with a cursor that never
    // moves, and would re-poll the same "after" value forever. Reporting the true global max
    // lets its next request's `after` skip straight past those filtered events instead.
    const lastEventId = eventLog.lastEventId;
    if (device !== undefined) {
      // AGENTREMOTE_AUTH=off has no device, so nothing is filtered (today's behavior). A newly
      // paired device is granted every project, so this is a no-op until a project is narrowed.
      const projectOf = new Map((await provider.listSessions()).map((session) => [session.id, session.projectId]));
      events = events.filter((event) => {
        // The event's own stamp is the authorization record: it was decided when the event was
        // emitted, so nothing that happens to the session afterwards (the provider forgetting
        // it across a restart, the id being reused for another project) can move an old event
        // into a project this device is allowed to read. Only an event persisted before the
        // field existed has no stamp; for those the session's binding is still the best record
        // available, live value first and the persisted index for a session the provider forgot.
        const projectId =
          event.projectId ?? projectOf.get(event.sessionId) ?? sessionIndex.projectOf(event.sessionId);
        if (event.projectId === undefined) {
          // Legacy events only. The index's binding is first-bind-wins and immutable
          // (SessionIndex.record), so a live provider reporting a different project for the same
          // id means the id was reused or reassigned and these retained events belong to some
          // other project: fail closed rather than trust the live value for old events.
          const recordedProjectId = sessionIndex.projectOf(event.sessionId);
          if (recordedProjectId !== undefined && projectId !== recordedProjectId) {
            return false;
          }
        }
        // Fail closed: an event that cannot be resolved to a project at all is dropped for a
        // narrowed device rather than shown, since there is no allowedProjects check to pass.
        return projectId !== undefined && device.allowedProjects.includes(projectId);
      });
    }
    // `firstEventId` and `truncated` are how a reconnecting client learns its cursor points
    // below the retained window (docs/durability-v0.md): polling can never recover those events,
    // so the client must resync from the page it is given instead of assuming continuity.
    const firstEventId = eventLog.firstEventId;
    const floor = firstEventId > 0 ? firstEventId : eventLog.nextEventId;
    const truncated = cursor < floor - 1;
    return json({ events, lastEventId, firstEventId, truncated, bridgeId } satisfies EventsResponse);
  }

  return {
    session,
    provider,
    bridgeId,
    pairingCode,
    pairingCodeExpiresAt,
    close(): void {
      releaseLock?.();
    },
    async fetch(request: Request): Promise<Response> {
      // Catch-all around the whole route table: mapProviderError only translates the protocol's
      // known error classes, so anything else thrown by a provider or by route logic itself
      // (an unmapped provider error, a bug in a handler) must not reach Bun's default error
      // handling, which can render the error's message/stack to the client. Every route,
      // including the GET routes that call the provider with no try/catch of their own, is
      // covered by this one wrapper so a future route is covered too.
      try {
        const url = new URL(request.url);
        const path = url.pathname;

        // The only two unauthenticated routes, per docs/pairing-v0.md.
        if (request.method === "GET" && path === "/v1/health") {
          return json({ ok: true, bridgeId });
        }

        // Read the body once as text and reuse it everywhere below: the envelope signature
        // covers the raw bytes, and handleCommand/handlePair parse this same string, so the
        // Request is never consumed twice.
        const rawBody = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();

        if (request.method === "POST" && path === "/v1/pair") {
          return await handlePair(rawBody);
        }

        let device: DeviceRecord | undefined;
        if (authEnabled) {
          let result: ReturnType<typeof verifyEnvelope>;
          try {
            result = verifyEnvelope({
              headers: request.headers,
              method: request.method,
              pathWithQuery: url.pathname + url.search,
              rawBody,
              registry,
              nonces,
              now: now(),
              skewMs: SKEW_MS,
            });
          } catch (error) {
            // verifyEnvelope now throws when the nonce could not be durably recorded (fail
            // closed): the signature may be genuine, but without a durable nonce record a replay
            // of this exact envelope would verify again after a restart. Treated as "not
            // verified", never as authorized, and answered the same way every other rejection
            // reason is, without leaking that it was a storage failure rather than a bad request.
            console.error("Failed to durably record nonce during envelope verification:", error);
            return json({ error: "unauthenticated" }, 401);
          }
          if (!result.ok) {
            return json({ error: result.code }, result.status);
          }
          device = result.device;
          registry.touch(device.deviceId, now());
        }

        if (request.method === "POST" && path === "/v1/commands") {
          return await handleCommand(rawBody, device);
        }
        if (request.method === "GET" && path === "/v1/events") {
          return await handleEvents(url, device);
        }
        if (request.method === "GET" && path === "/v1/sessions") {
          const sessions = await provider.listSessions();
          // Same no-device/no-filter and newly-paired/no-narrowing notes as handleEvents above.
          const visible =
            device === undefined ? sessions : sessions.filter((session) => device.allowedProjects.includes(session.projectId));
          return json({ sessions: visible } satisfies SessionsResponse);
        }
        if (request.method === "GET" && path === "/v1/projects") {
          const projects = await provider.listProjects();
          // Same no-device/no-filter and newly-paired/no-narrowing notes as handleEvents above.
          const visible =
            device === undefined ? projects : projects.filter((project) => device.allowedProjects.includes(project.id));
          return json({ projects: visible } satisfies ProjectsResponse);
        }

        const cancelMatch = /^\/v1\/sessions\/([^/]+)\/cancel$/.exec(path);
        if (request.method === "POST" && cancelMatch !== null) {
          const sessionId = decodeURIComponent(cancelMatch[1] ?? "");

          // This route is authenticated (the envelope check already ran above) but was not
          // authorized: it must apply the same two checks POST /v1/commands applies to the
          // equivalent session.cancel command, per "Command authorization" in
          // docs/pairing-v0.md. Ordering choice: the action check runs first because it never
          // depends on sessionId, so a device lacking session.cancel learns nothing about
          // whether sessionId exists (403 either way). The project check needs the target
          // session's own projectId, so it can only run once the session is found; when the
          // session can't be found, that check is skipped and control falls through to the same
          // 404 unknown_session an authorized device would get for the same id. So an
          // unauthorized device probing session ids sees exactly what an authorized one would
          // see for a nonexistent id — the 404 never distinguishes "unauthorized" from
          // "doesn't exist".
          if (device !== undefined && !device.allowedActions.includes("session.cancel")) {
            return json({ error: "action_not_allowed" }, 403);
          }

          const targetSession = (await provider.listSessions()).find((session) => session.id === sessionId);
          if (device !== undefined && targetSession !== undefined && !device.allowedProjects.includes(targetSession.projectId)) {
            return json({ error: "project_not_allowed" }, 403);
          }

          if (targetSession === undefined) {
            return json({ error: "unknown_session" }, 404);
          }
          // Shares the per-session lock POST /v1/commands uses, so a cancel racing a decision
          // command for the same session (or another cancel) serializes with it rather than
          // running concurrently with it.
          try {
            return await withSessionLock(sessionId, async () => {
              await provider.cancel(sessionId);
              return json({ cancelled: true, sessionId });
            });
          } catch (error) {
            // The listSessions lookup above and cancel are two separate provider calls, so a
            // session that existed a moment ago can still disappear (or otherwise fail to
            // cancel) before this runs.
            const mapped = mapProviderError(error);
            if (mapped !== undefined) {
              return mapped;
            }
            throw error;
          }
        }

        return json({ error: "not found" }, 404);
      } catch (error) {
        console.error(`Agent Remote bridge: unhandled error on ${request.method} ${request.url}`, error);
        return json({ error: "internal" }, 500);
      }
    },
  };
}

/** Picks the hostname `Bun.serve` binds to, and whether that choice needs a no-auth warning.
 * Exported for testing; `import.meta.main` below is the only production caller.
 *
 * `AGENTREMOTE_HOST` unset: the claude provider (which executes real host tool calls) defaults
 * to loopback-only; the mock provider is left on Bun's own default (binds all interfaces),
 * matching its pre-existing behavior. `AGENTREMOTE_HOST` set explicitly always wins, and a
 * non-loopback value with the claude provider is flagged since this bridge has no auth. */
export function resolveBindHost(
  providerId: string,
  envHost: string | undefined,
): { hostname: string | undefined; warnNoAuth: boolean } {
  const explicit = envHost?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { hostname: explicit, warnNoAuth: providerId === "claude" && !isLoopbackHost(explicit) };
  }
  if (providerId === "claude") {
    return { hostname: "127.0.0.1", warnNoAuth: false };
  }
  return { hostname: undefined, warnNoAuth: false };
}

/** `undefined` (Bun's own default, which binds every interface) is never loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** The "Development bypass" refusal from docs/pairing-v0.md: `AGENTREMOTE_AUTH=off` must not
 * start with the claude provider (which executes real host tool calls) on a bind host other
 * than loopback, since that combination is an unauthenticated endpoint reachable off the box.
 * Throws to refuse startup; does nothing when auth is enabled or the combination is safe. */
export function assertAuthBypassAllowed(params: {
  authEnabled: boolean;
  providerId: string;
  hostname: string | undefined;
}): void {
  if (params.authEnabled || params.providerId !== "claude" || isLoopbackHost(params.hostname)) {
    return;
  }
  throw new Error(
    `AGENTREMOTE_AUTH=off refuses to start with the claude provider bound to ${params.hostname ?? "all interfaces"}: ` +
      "that combination is an unauthenticated endpoint that can execute real tool calls on a reachable address. " +
      "Set AGENTREMOTE_HOST=127.0.0.1 or leave AGENTREMOTE_AUTH enabled.",
  );
}

/** Prints a fresh pairing code and its expiry, per the "Operator commands" section of
 * docs/pairing-v0.md. The code is persisted to `<stateDir>/pairing.json` (the same path
 * `createBridge` uses), so this one-shot process's mint reaches an already-running bridge —
 * re-pairing a device no longer requires restarting the bridge and killing live sessions. */
export function runPairOperatorCommand(stateDir: string = resolveStateDir(), now: Date = new Date()): void {
  const store = new PairingCodeStore(path.join(stateDir, "pairing.json"));
  const code = store.mint(now);
  const PAIRING_TTL_MS = 5 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
  console.log(`Pairing code: ${formatPairingCode(code)} (expires ${expiresAt})`);
}

/** `AGENTREMOTE_REVOKE=<deviceId>`: marks a device revoked in the persisted registry and exits. */
export function runRevokeOperatorCommand(deviceId: string, stateDir: string = resolveStateDir(), now: Date = new Date()): void {
  const registry = DeviceRegistry.load(path.join(stateDir, "devices.json"));
  if (registry.get(deviceId) === undefined) {
    console.log(`No such device: ${deviceId}`);
    return;
  }
  registry.revoke(deviceId, now);
  console.log(`Revoked device: ${deviceId}`);
}

/** `AGENTREMOTE_LIST_DEVICES=1`: prints the registry, deliberately never printing key material. */
export function runListDevicesOperatorCommand(stateDir: string = resolveStateDir()): void {
  const registry = DeviceRegistry.load(path.join(stateDir, "devices.json"));
  const devices = registry.list().map((record) => ({
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    keyId: record.keyId,
    pairedAt: record.pairedAt,
    allowedProjects: record.allowedProjects,
    allowedActions: record.allowedActions,
    revokedAt: record.revokedAt,
    lastSeenAt: record.lastSeenAt,
  }));
  console.log(JSON.stringify(devices, null, 2));
}

if (import.meta.main) {
  // Operator commands are one-shot: read the env var, act, exit. They never start the server.
  if (process.env.AGENTREMOTE_PAIR === "1") {
    runPairOperatorCommand();
  } else if (process.env.AGENTREMOTE_REVOKE !== undefined && process.env.AGENTREMOTE_REVOKE.length > 0) {
    runRevokeOperatorCommand(process.env.AGENTREMOTE_REVOKE);
  } else if (process.env.AGENTREMOTE_LIST_DEVICES === "1") {
    runListDevicesOperatorCommand();
  } else {
    const authEnabled = process.env.AGENTREMOTE_AUTH !== "off";
    const bridge = createBridge();
    const { hostname, warnNoAuth } = resolveBindHost(bridge.provider.id, process.env.AGENTREMOTE_HOST);

    try {
      assertAuthBypassAllowed({ authEnabled, providerId: bridge.provider.id, hostname });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (!authEnabled) {
      console.warn(
        "Agent Remote bridge is starting with AGENTREMOTE_AUTH=off: every request is accepted " +
          "without pairing or a signed envelope. Only use this for local development.",
      );
    } else if (warnNoAuth) {
      console.warn(
        `Agent Remote bridge is binding to ${hostname} with the claude provider: this endpoint ` +
          "can execute real tool calls on this host. Set AGENTREMOTE_HOST=127.0.0.1 (or run it " +
          "behind a trusted network/proxy) unless this is intentional.",
      );
    }

    console.log(`Pairing code: ${formatPairingCode(bridge.pairingCode)} (expires ${bridge.pairingCodeExpiresAt})`);

    const server = Bun.serve({
      port: Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10),
      ...(hostname === undefined ? {} : { hostname }),
      idleTimeout: 0,
      fetch: bridge.fetch,
    });
    console.log(`Agent Remote bridge listening on http://localhost:${server.port}`);
  }
}

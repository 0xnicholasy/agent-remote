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
  TurnInProgressError,
  UnknownSessionError,
} from "@agentremote/protocol";
import { ClaudeProvider } from "@agentremote/provider-claude";

import { ApprovalBindingMismatchError, InteractionPendingError, MockProvider } from "./providers/mock";
// command.schema.json lives outside bridge's package boundary in protocol/, imported the same
// way protocol/typescript/src/index.test.ts does.
import commandSchema from "../../protocol/schema/command.schema.json";

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
}

/** Options accepted by `createBridge`. Only `createClaudeProvider` exists for tests: it lets a
 * test wire `AGENTREMOTE_PROVIDER=claude` without constructing a real `ClaudeProvider`, which
 * would spawn the Claude Agent SDK's subprocess. Production code never passes it, so the
 * default keeps building the real `ClaudeProvider` exactly as before. */
export interface CreateBridgeOptions {
  createClaudeProvider?: (host: ProviderHost, options: { projects: Project[] }) => SeedableProvider;
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

  const log: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  const processed = new Map<string, CommandResponse>();
  // Reserves a command id for the duration of its execution, so two retries that arrive at
  // the same time cannot both pass the `processed` check and run the command twice.
  const inFlight = new Set<string>();
  let nextEventId = 1;
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
      // An AgentEventEnvelope<T> is structurally one member of the AgentEvent union, but
      // TypeScript cannot verify that while T is still an unresolved type parameter, so the
      // envelope is asserted once here instead of weakening the public types.
      const event = {
        eventId: nextEventId++,
        sessionId,
        provider: emittedProviderId,
        type,
        timestamp: new Date().toISOString(),
        payload,
      } as AgentEventEnvelope<T> as AgentEvent;
      log.push(event);
      wake();
      return event;
    },
    eventsAfter(after: number): AgentEvent[] {
      return log.filter((event) => event.eventId > after);
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
    // projects empty and crashing seedSession's later "unknown projectId" lookup.
    const rawDirs = process.env.AGENTREMOTE_PROJECT_DIRS;
    const dirsSource = rawDirs === undefined || rawDirs.trim().length === 0 ? process.cwd() : rawDirs;
    const dirs = dirsSource
      .split(",")
      .map((dir) => dir.trim())
      .filter((dir) => dir.length > 0);
    const projects: Project[] = dirs.map((dir) => ({ id: projectIdFor(dir), name: dir.split("/").filter((p) => p.length > 0).at(-1) ?? dir, path: dir }));
    const createClaudeProvider = options.createClaudeProvider ?? ((h, o) => new ClaudeProvider(h, o));
    provider = createClaudeProvider(host, { projects });
    seedProjectId = projects[0]?.id ?? projectIdFor(process.cwd());
  } else {
    provider = new MockProvider(host);
    seedProjectId = "prj_demo";
  }
  emittedProviderId = provider.id;

  const now = new Date().toISOString();
  const session: Session = {
    id: "ses_seed",
    projectId: seedProjectId,
    provider: provider.id,
    state: "idle",
    createdAt: now,
    updatedAt: now,
    title: "demo",
  };
  provider.seedSession(session);

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
        return created.id;
      }
    }
  }

  async function sessionExists(sessionId: string): Promise<boolean> {
    const sessions = await provider.listSessions();
    return sessions.some((session) => session.id === sessionId);
  }

  // Maps the protocol error types a provider call can throw to the HTTP response both
  // handleCommand and the cancel route return for them, so the two call sites stay in sync.
  // Returns undefined for anything else, which the caller should rethrow.
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
    return undefined;
  }

  async function handleCommand(request: Request): Promise<Response> {
    // The body is untrusted network input: parse it as unknown JSON first (never asserted as
    // Command) and let the ajv schema validator, not a type cast, decide whether it is one.
    let body: unknown;
    try {
      body = await request.json();
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

    const previous = processed.get(command.commandId);
    if (previous !== undefined) {
      return json({ ...previous, duplicate: true } satisfies CommandResponse);
    }
    if (inFlight.has(command.commandId)) {
      return json(
        { accepted: false, commandId: command.commandId, duplicate: true } satisfies CommandResponse,
      );
    }

    inFlight.add(command.commandId);
    let createdSessionId: string | undefined;
    try {
      createdSessionId = await execute(command);
    } catch (error) {
      inFlight.delete(command.commandId);
      const mapped = mapProviderError(error);
      if (mapped !== undefined) {
        return mapped;
      }
      throw error;
    }

    const response: CommandResponse = {
      accepted: true,
      commandId: command.commandId,
      duplicate: false,
      ...(createdSessionId === undefined ? {} : { sessionId: createdSessionId }),
    };
    processed.set(command.commandId, response);
    inFlight.delete(command.commandId);
    return json(response);
  }

  async function handleEvents(url: URL): Promise<Response> {
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const cursor = Number.isFinite(after) && after > 0 ? after : 0;
    const requested = Number.parseInt(url.searchParams.get("wait") ?? "0", 10);
    const waitSeconds = Math.min(Number.isFinite(requested) ? Math.max(requested, 0) : 0, MAX_WAIT_SECONDS);

    let events = host.eventsAfter(cursor);
    if (events.length === 0 && waitSeconds > 0) {
      await host.waitForChange(waitSeconds * 1000);
      events = host.eventsAfter(cursor);
    }

    const last = log.at(-1);
    return json({ events, lastEventId: last?.eventId ?? 0 } satisfies EventsResponse);
  }

  return {
    session,
    provider,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "POST" && path === "/v1/commands") {
        return handleCommand(request);
      }
      if (request.method === "GET" && path === "/v1/events") {
        return handleEvents(url);
      }
      if (request.method === "GET" && path === "/v1/sessions") {
        return json({ sessions: await provider.listSessions() } satisfies SessionsResponse);
      }
      if (request.method === "GET" && path === "/v1/projects") {
        return json({ projects: await provider.listProjects() } satisfies ProjectsResponse);
      }

      const cancelMatch = /^\/v1\/sessions\/([^/]+)\/cancel$/.exec(path);
      if (request.method === "POST" && cancelMatch !== null) {
        const sessionId = decodeURIComponent(cancelMatch[1] ?? "");
        if (!(await sessionExists(sessionId))) {
          return json({ error: "unknown_session" }, 404);
        }
        try {
          await provider.cancel(sessionId);
        } catch (error) {
          // sessionExists and cancel are two separate provider calls, so a session that existed
          // a moment ago can still disappear (or otherwise fail to cancel) before this runs.
          const mapped = mapProviderError(error);
          if (mapped !== undefined) {
            return mapped;
          }
          throw error;
        }
        return json({ cancelled: true, sessionId });
      }

      return json({ error: "not found" }, 404);
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
    const isLoopback = explicit === "127.0.0.1" || explicit === "localhost" || explicit === "::1";
    return { hostname: explicit, warnNoAuth: providerId === "claude" && !isLoopback };
  }
  if (providerId === "claude") {
    return { hostname: "127.0.0.1", warnNoAuth: false };
  }
  return { hostname: undefined, warnNoAuth: false };
}

if (import.meta.main) {
  const bridge = createBridge();
  const { hostname, warnNoAuth } = resolveBindHost(bridge.provider.id, process.env.AGENTREMOTE_HOST);
  if (warnNoAuth) {
    console.warn(
      `Agent Remote bridge is binding to ${hostname} with the claude provider: this endpoint ` +
        "has no authentication and can execute real tool calls on this host. Set " +
        "AGENTREMOTE_HOST=127.0.0.1 (or run it behind a trusted network/proxy) unless this is intentional.",
    );
  }
  const server = Bun.serve({
    port: Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10),
    ...(hostname === undefined ? {} : { hostname }),
    idleTimeout: 0,
    fetch: bridge.fetch,
  });
  console.log(`Agent Remote bridge listening on http://localhost:${server.port}`);
}

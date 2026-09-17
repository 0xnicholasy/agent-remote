import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentEventPayloadMap,
  AgentEventType,
  Command,
  CommandResponse,
  EventsResponse,
  ProjectsResponse,
  Session,
  SessionsResponse,
} from "@agentremote/protocol";

import { ApprovalBindingMismatchError, MockProvider, type ProviderHost } from "./providers/mock";
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

export interface Bridge {
  /** The request handler, usable directly in tests or through `Bun.serve`. */
  fetch(request: Request): Promise<Response>;
  /** The seeded session, exposed so callers do not have to guess its identifier. */
  readonly session: Session;
  readonly provider: MockProvider;
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

export function createBridge(): Bridge {
  const log: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  const processed = new Map<string, CommandResponse>();
  // Reserves a command id for the duration of its execution, so two retries that arrive at
  // the same time cannot both pass the `processed` check and run the command twice.
  const inFlight = new Set<string>();
  let nextEventId = 1;

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
        provider: "mock",
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

  const provider = new MockProvider(host);
  const now = new Date().toISOString();
  const session: Session = {
    id: "ses_seed",
    projectId: "prj_demo",
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

    if (command.type === "session.create" && command.payload.provider !== provider.id) {
      return json({ error: `unknown provider: ${command.payload.provider}` }, 400);
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
      if (error instanceof ApprovalBindingMismatchError) {
        return json({ error: error.message }, 409);
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
        await provider.cancel(sessionId);
        return json({ cancelled: true, sessionId });
      }

      return json({ error: "not found" }, 404);
    },
  };
}

if (import.meta.main) {
  const bridge = createBridge();
  const server = Bun.serve({
    port: Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10),
    idleTimeout: 0,
    fetch: bridge.fetch,
  });
  console.log(`Agent Remote bridge listening on http://localhost:${server.port}`);
}

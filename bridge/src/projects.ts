import { readFileSync } from "node:fs";
import path from "node:path";

import { digest, type Project } from "@agentremote/protocol";

/** File name the bridge writes its resolved project list under, inside its state dir. */
export const bridgeProjectsFileName = "projects.json";

// Derives a stable project id from an absolute directory: the basename for readability, plus
// a digest suffix of the full path so two projects sharing a basename (e.g. two checkouts
// both named "app") never collide. The path is normalized first (collapsing "..", "." and
// repeated slashes, and dropping a trailing slash) so equivalent paths like "/a/b/",
// "/a/x/../b" and "/a//b" all yield the same id; symlinked paths are not resolved, so a
// symlink and its target still get distinct ids.
export function projectIdFor(dir: string): string {
  const normalized = path.normalize(dir).replace(/(?<=.)\/+$/, "");
  const base = normalized.split("/").filter((part) => part.length > 0).at(-1) ?? "project";
  const slug = base.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const suffix = digest(normalized).replace("sha256:", "").slice(0, 8);
  return `prj_${slug}_${suffix}`;
}

/**
 * The projects a bridge process would seed from the current environment: `AGENTREMOTE_PROJECT_DIRS`
 * (or `cwd`) for the claude provider, and the single `prj_demo` project for the mock provider (or
 * an unset `AGENTREMOTE_PROVIDER`). Shared by `createBridge` (server.ts) and the CLI's
 * `projects list`, so both agree on what a running bridge would seed without the CLI importing
 * server.ts (which would pull in the HTTP server and journal/lock machinery the CLI must not touch).
 */
export function resolveProjectIds(env: NodeJS.ProcessEnv, cwd: string): Project[] {
  if (env.AGENTREMOTE_PROVIDER === "claude") {
    // A blank or whitespace-only value is treated the same as unset, so a stray
    // `AGENTREMOTE_PROJECT_DIRS=` in the environment falls back to cwd instead of leaving
    // projects empty. The same fallback applies when the value parses to zero usable
    // directories (e.g. all commas or whitespace-only entries).
    const rawDirs = env.AGENTREMOTE_PROJECT_DIRS;
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
    const dirs = parsedDirs.length > 0 ? parsedDirs : [cwd];
    return dirs.map((dir) => {
      const normalized = path.normalize(dir).replace(/(?<=.)\/+$/, "");
      return {
        id: projectIdFor(normalized),
        name: normalized.split("/").filter((p) => p.length > 0).at(-1) ?? normalized,
        path: normalized,
      };
    });
  }
  return [{ id: "prj_demo", name: "demo", path: cwd }];
}

/**
 * Reads the RUNNING bridge's project list from `<stateDir>/projects.json`, written by
 * `createBridge` (server.ts) as the sole writer. The CLI uses this instead of
 * `resolveProjectIds` so it sees what the bridge actually served, not what the CLI's own
 * (possibly different) environment would resolve.
 *
 * Returns `undefined` when the file does not exist (e.g. an in-memory bridge, or one that has
 * not started yet). Throws when the file exists but is not valid JSON or not an array of
 * `{id, name, path}` strings, naming the file path in the error so a corrupt state dir is easy
 * to locate.
 */
export function readBridgeProjects(stateDir: string): Project[] | undefined {
  const filePath = path.join(stateDir, bridgeProjectsFileName);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt bridge projects file (invalid JSON): ${filePath}`);
  }

  if (!Array.isArray(parsed) || !parsed.every((entry) => isValidProject(entry))) {
    throw new Error(`corrupt bridge projects file (expected an array of {id, name, path}): ${filePath}`);
  }
  return parsed;
}

function isValidProject(value: unknown): value is Project {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}

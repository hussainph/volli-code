/**
 * Path/env rules for the `.volli` per-project convention (global-artifacts
 * decisions #1/#9): a self-gitignored directory at the project root holding a
 * single, project-scoped `artifacts/` tier — filesystem-as-truth, no artifacts
 * DB table. The ticket tier (`.volli/tickets/`) is gone. Pure string ops only —
 * no Node imports (`path`/`fs`); this lives in the shared package and must stay
 * usable from main, preload, and (later) the volli CLI alike. `projectPath` is
 * always the MAIN repo's absolute path — never a worktree's — see
 * {@link ticketSessionEnv}.
 */

export const VOLLI_DIR_NAME = ".volli";

/** Strips a single trailing slash from `path`, if present. */
function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The project's `.volli` directory: `<projectPath>/.volli`. */
export function volliDir(projectPath: string): string {
  return `${stripTrailingSlash(projectPath)}/${VOLLI_DIR_NAME}`;
}

/** The project's single artifacts directory: `<volliDir>/artifacts`. */
export function projectArtifactsDir(projectPath: string): string {
  return `${volliDir(projectPath)}/artifacts`;
}

/**
 * Self-gitignore content written to `<volliDir>/.gitignore` so `.volli` is
 * never committed. This is `.volli`'s own gitignore file — the user's root
 * `.gitignore` is never touched.
 */
export const VOLLI_GITIGNORE_CONTENT = "*\n";

export const VOLLI_TICKET_ENV = "VOLLI_TICKET";
export const VOLLI_ARTIFACTS_DIR_ENV = "VOLLI_ARTIFACTS_DIR";
export const VOLLI_SESSION_ENV = "VOLLI_SESSION";
export const VOLLI_SOCKET_ENV = "VOLLI_SOCKET";

/**
 * Env vars injected at PTY creation for a ticket-linked session (decision #9):
 * {@link VOLLI_TICKET_ENV} (the display id) and {@link VOLLI_ARTIFACTS_DIR_ENV}
 * (the absolute main-repo `.volli/artifacts` path). `projectPath` must always
 * be the MAIN repo's path, never derived from the session's `cwd` — a worktree
 * is a separate checkout that won't contain the (gitignored, main-repo-only)
 * `.volli` directory, which is exactly why this is injected rather than
 * computed relative to `cwd` at PTY-spawn time.
 */
export function ticketSessionEnv(projectPath: string, displayId: string): Record<string, string> {
  return {
    [VOLLI_TICKET_ENV]: displayId,
    [VOLLI_ARTIFACTS_DIR_ENV]: projectArtifactsDir(projectPath),
  };
}

/**
 * Env vars injected at PTY creation for a project-scoped scratch session
 * (decision #9): just {@link VOLLI_ARTIFACTS_DIR_ENV}, so an agent in a scratch
 * terminal can write project artifacts the same way a ticket session can.
 * `projectPath` must always be the MAIN repo's path (see {@link
 * ticketSessionEnv}).
 */
export function projectSessionEnv(projectPath: string): Record<string, string> {
  return {
    [VOLLI_ARTIFACTS_DIR_ENV]: projectArtifactsDir(projectPath),
  };
}

export interface AgentSessionEnvironmentInput {
  sessionId: string;
  socketPath: string;
  binDir: string;
  inheritedPath: string;
}

/** Adds the agent-facing runtime contract to a ticket or scratch session environment. */
export function agentSessionEnv(
  scopeEnv: Readonly<Record<string, string>>,
  input: AgentSessionEnvironmentInput,
): Record<string, string> {
  return {
    ...scopeEnv,
    [VOLLI_SESSION_ENV]: input.sessionId,
    [VOLLI_SOCKET_ENV]: input.socketPath,
    PATH: input.inheritedPath ? `${input.binDir}:${input.inheritedPath}` : input.binDir,
  };
}

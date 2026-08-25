/**
 * Path/env rules for the `.volli` per-project convention (global-artifacts
 * decisions #1/#9): a self-gitignored directory at the project root holding a
 * single, project-scoped `artifacts/` tier — filesystem-as-truth, no artifacts
 * DB table. The ticket tier (`.volli/tickets/`) is gone. Pure string ops only —
 * no Node imports (`path`/`fs`); this lives in the shared package and must stay
 * usable from main, preload, and (later) the volli CLI alike. `projectPath` is
 * always the MAIN repo's absolute path — never a worktree's — see
 * {@link ticketSessionEnv}.
 *
 * IMPORTANT boundary: `.volli/artifacts` (via {@link projectArtifactsDir})
 * stays main-repo-keyed as above — but `.volli/attachments` (via {@link
 * sessionAttachmentsDir}, CONCEPT decision #19) is the ONE ticket-scoped,
 * session-root-LOCAL exception. Its `rootPath` is the SESSION's checkout root
 * — the worktree for a worktree ticket, the main checkout otherwise — never
 * forced to the main repo the way every other `.volli/**` path is.
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
 * The project's prompt-template directory: `<volliDir>/commands`, holding the
 * `.md` files the composer's `/` picker lists.
 *
 * MAIN-repo-keyed like {@link projectArtifactsDir}, and for the same reason
 * rather than by analogy: `.volli` is self-gitignored, so a ticket's worktree
 * gets an empty one. Keying a ticket session's commands to its worktree would
 * mean the templates the project author wrote are exactly the ones a ticket
 * session cannot see. These are authored project assets, not per-session
 * materialized state — {@link sessionAttachmentsDir} remains the one
 * session-local exception.
 */
export function projectCommandsDir(projectPath: string): string {
  return `${volliDir(projectPath)}/commands`;
}

/**
 * The SESSION-local materialized-attachments directory: `<rootPath>/.volli/attachments`
 * (CONCEPT decision #19). `rootPath` is the session's own checkout root — the
 * ticket's worktree when it has one, the main checkout for a worktree-opt-out
 * ticket — NEVER forced to the main repo path the way {@link
 * projectArtifactsDir} is. See this module's header for the boundary.
 */
export function sessionAttachmentsDir(rootPath: string): string {
  return `${volliDir(rootPath)}/attachments`;
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
/**
 * The per-attachment secret that turns `VOLLI_SESSION`'s CLAIM into an
 * authenticated session actor (VC-92 §6, built in VC-163).
 *
 * `VOLLI_SESSION` names WHICH Session a caller says it is; this proves the
 * caller was handed that name by Volli. Minted when a PTY or an attachment is
 * spawned, exported here, and verified at the socket door — a caller with the
 * id and no valid token is not that Session, and is not the user either.
 *
 * **Scope the claim honestly.** This defeats two things and no more: an
 * injected string that names someone else's Session, and cross-session
 * confusion where an inherited environment makes one Session speak as another.
 * It does NOT defeat a hostile process running as the same user — that process
 * can read this variable out of any environment it can see, exactly as it can
 * read the socket path. That limit is not a gap to be closed here; it is the
 * reason VC-92 put the control tier on the Agent Tool Surface instead, where a
 * call is bound to its attachment and never crosses a socket at all.
 */
export const VOLLI_SESSION_TOKEN_ENV = "VOLLI_SESSION_TOKEN";
export const VOLLI_SOCKET_ENV = "VOLLI_SOCKET";
/**
 * The MAIN checkout's absolute path (worktree-support §8) — injected so an
 * agent in a ticket worktree can locate the main repo without ever inferring
 * it from `cwd` (which IS the worktree there). Present for every ticket
 * session; for a non-worktree ticket it simply equals the cwd.
 */
export const VOLLI_PROJECT_DIR_ENV = "VOLLI_PROJECT_DIR";

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
    [VOLLI_PROJECT_DIR_ENV]: stripTrailingSlash(projectPath),
  };
}

/**
 * Env vars injected at PTY creation for a Project Session (decision #9): just
 * {@link VOLLI_ARTIFACTS_DIR_ENV}, so an agent in a Project Session's terminal
 * can write project artifacts the same way a Ticket Session can.
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
  /**
   * This attachment's {@link VOLLI_SESSION_TOKEN_ENV} value, or absent when the
   * launch minted none.
   *
   * Optional rather than required so a caller that cannot mint one says so by
   * omission, and the variable is then absent from the child's environment
   * rather than present and empty. The door must be able to tell "Volli issued
   * nothing" from "a caller supplied a blank string", and an exported
   * `VOLLI_SESSION_TOKEN=""` collapses the two.
   */
  sessionToken?: string;
  socketPath: string;
  binDir: string;
  inheritedPath: string;
}

/** Adds the agent-facing runtime contract to a ticket or Project Session environment. */
export function agentSessionEnv(
  scopeEnv: Readonly<Record<string, string>>,
  input: AgentSessionEnvironmentInput,
): Record<string, string> {
  return {
    ...scopeEnv,
    [VOLLI_SESSION_ENV]: input.sessionId,
    ...(input.sessionToken === undefined ? {} : { [VOLLI_SESSION_TOKEN_ENV]: input.sessionToken }),
    [VOLLI_SOCKET_ENV]: input.socketPath,
    PATH: input.inheritedPath ? `${input.binDir}:${input.inheritedPath}` : input.binDir,
  };
}

/**
 * Path/env rules for the `.volli` per-project convention (ticket-detail-mvp
 * decisions #13–16): a self-gitignored directory at the project root holding
 * project- and ticket-scoped artifacts, filesystem-as-truth, no artifacts DB
 * table. Pure string ops only — no Node imports (`path`/`fs`); this lives in
 * the shared package and must stay usable from main, preload, and (later)
 * the volli CLI alike. `projectPath` is always the MAIN repo's absolute
 * path — never a worktree's — see {@link ticketSessionEnv}.
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

/** Project-level artifacts directory: `<volliDir>/artifacts`. */
export function projectArtifactsDir(projectPath: string): string {
  return `${volliDir(projectPath)}/artifacts`;
}

/**
 * A ticket's `.volli` directory: `<volliDir>/tickets/<displayId>`.
 * `displayId` is the ticket's presentation id (e.g. `"VC-12"`, from
 * `displayTicketId` in `ticket.ts`), not its opaque UUID.
 */
export function ticketDir(projectPath: string, displayId: string): string {
  return `${volliDir(projectPath)}/tickets/${displayId}`;
}

/** A ticket's artifacts directory: `<ticketDir>/artifacts`. */
export function ticketArtifactsDir(projectPath: string, displayId: string): string {
  return `${ticketDir(projectPath, displayId)}/artifacts`;
}

/**
 * Self-gitignore content written to `<volliDir>/.gitignore` so `.volli` is
 * never committed. This is `.volli`'s own gitignore file — the user's root
 * `.gitignore` is never touched.
 */
export const VOLLI_GITIGNORE_CONTENT = "*\n";

export const VOLLI_TICKET_ENV = "VOLLI_TICKET";
export const VOLLI_TICKET_DIR_ENV = "VOLLI_TICKET_DIR";

/**
 * Env vars injected at PTY creation for a ticket-linked session:
 * {@link VOLLI_TICKET_ENV} (the display id) and {@link VOLLI_TICKET_DIR_ENV}
 * (that ticket's `.volli` dir). `projectPath` must always be the MAIN repo's
 * path, never derived from the session's `cwd` — a worktree is a separate
 * checkout that won't contain the (gitignored, main-repo-only) `.volli`
 * directory, which is exactly why this is injected rather than computed
 * relative to `cwd` at PTY-spawn time.
 */
export function ticketSessionEnv(projectPath: string, displayId: string): Record<string, string> {
  return {
    [VOLLI_TICKET_ENV]: displayId,
    [VOLLI_TICKET_DIR_ENV]: ticketDir(projectPath, displayId),
  };
}

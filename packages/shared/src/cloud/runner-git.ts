/**
 * Git on a runner that has no folder of the person's: the remote a box clones
 * a project from, and the `/runner/github-token` wire.
 *
 * **The remote.** A Mac's checkout reports its `origin` (`projectCheckouts.report`),
 * and the backend records it on the project's repository. A GitHub project
 * derives it from `owner/name` instead ({@link githubRemoteUrl}). Both pass
 * {@link normalizeGitRemoteUrl}:
 * - it never keeps a secret: an `https` URL loses its whole userinfo, an
 *   `ssh` URL its password;
 * - it accepts only network remotes git fetches over a transport (`https`,
 *   `http`, `ssh`, `git`, and scp-like `user@host:path`). A local path, a
 *   `file://` URL or git's `ext::` command transport is refused, because a
 *   box clones whatever the backend names;
 * - a GitHub remote, in any of those spellings, becomes
 *   `https://<host>/<owner>/<repo>.git`, so a box can push with the GitHub
 *   token below instead of an SSH key.
 *
 * **The token.** `POST /runner/github-token`, with the runner's own token as
 * `Authorization: Bearer …`, names one claim the runner holds (a Session or a
 * leased job) and the repository it is for. The backend answers the runner
 * owner's short-lived GitHub user token, the host it is for, and the git
 * identity to commit as. A refresh token never leaves the backend.
 */

import { readId, type JobId, type ProjectRepoId, type SessionId } from "./ids";
import { RunnerWireError } from "./runners";

/** The HTTP route on the deployment's site URL. */
export const RUNNER_GITHUB_TOKEN_PATH = "/runner/github-token";

/** The longest remote URL the backend records. */
export const GIT_REMOTE_URL_MAX_LENGTH = 1024;

/** The host GitHub remotes are canonicalized for when the deployment names no other. */
export const DEFAULT_GITHUB_HOST = "github.com";

const TRANSPORTS = new Map([
  ["https", "https"],
  ["http", "http"],
  ["ssh", "ssh"],
  ["git+ssh", "ssh"],
  ["ssh+git", "ssh"],
  ["git", "git"],
]);

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const GITHUB_PATH =
  /^\/?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/u;
const SCP_LIKE = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(?!\/\/)(.+)$/u;
/** Whether `text` holds whitespace or a control character: a remote is one git argument. */
function unsafe(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return /\s/u.test(text);
}

function canonicalHost(host: string): string | null {
  const lowered = host.toLowerCase();
  return HOST.test(lowered) ? lowered : null;
}

function githubForm(host: string, path: string, githubHosts: readonly string[]): string | null {
  if (!githubHosts.includes(host)) return null;
  const match = GITHUB_PATH.exec(path);
  if (match === null) return null;
  const repo = match[2]!;
  if (repo === "." || repo === "..") return null;
  return `https://${host}/${match[1]}/${repo}.git`;
}

/**
 * The remote as the backend records it, or `null` when it is not a network
 * remote a box may clone (see the module comment). Idempotent.
 *
 * `githubHosts` are the hosts (with any port) whose remotes take the
 * canonical `https` form: `github.com`, or the host of `GITHUB_WEB_URL`.
 */
export function normalizeGitRemoteUrl(
  raw: string,
  githubHosts: readonly string[] = [DEFAULT_GITHUB_HOST],
): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > GIT_REMOTE_URL_MAX_LENGTH || unsafe(text)) {
    return null;
  }
  // `-…` would read as an option; `<transport>::<address>` is git's remote-helper
  // syntax (`ext::` runs a command).
  if (text.startsWith("-") || /^[A-Za-z][A-Za-z0-9+.-]*::/u.test(text)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(text);
  if (scheme !== null) {
    const transport = TRANSPORTS.get(scheme[1]!.toLowerCase());
    if (transport === undefined) return null;
    let url: URL;
    try {
      url = new URL(`${transport}://${text.slice(scheme[0].length)}`);
    } catch {
      return null;
    }
    const hostname = canonicalHost(url.hostname);
    if (hostname === null) return null;
    const host = url.port === "" ? hostname : `${hostname}:${url.port}`;
    const path = url.pathname;
    if (path === "" || path === "/") return null;
    const github = githubForm(host, path, githubHosts);
    if (github !== null) return github;
    // An https/http username is as often a token as a login: neither is kept.
    const user = transport === "ssh" && url.username !== "" ? `${url.username}@` : "";
    return `${transport}://${user}${host}${path}`;
  }
  const scp = SCP_LIKE.exec(text);
  // `C:\…` and `C:/…` are Windows paths, not a host called `C`.
  if (scp === null || scp[2]!.length === 1) return null;
  const host = canonicalHost(scp[2]!);
  if (host === null) return null;
  const path = scp[3]!;
  const github = githubForm(host, `/${path}`, githubHosts);
  if (github !== null) return github;
  return `${scp[1] === undefined ? "" : `${scp[1]}@`}${host}:${path}`;
}

/** The host (with any port) of a GitHub web URL such as `GITHUB_WEB_URL`, or `null`. */
export function githubHostOf(webUrl: string): string | null {
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.host;
  } catch {
    return null;
  }
}

/**
 * A GitHub repository's clone URL: `<webUrl>/<owner>/<name>.git`, or `null`
 * when the owner or name could not be a GitHub repository.
 */
export function githubRemoteUrl(webUrl: string, owner: string, name: string): string | null {
  const host = githubHostOf(webUrl);
  if (host === null) return null;
  const scheme = webUrl.trim().toLowerCase().startsWith("http://") ? "http" : "https";
  const canonical = githubForm(host, `/${owner}/${name}`, [host]);
  return canonical === null ? null : canonical.replace(/^https:/u, `${scheme}:`);
}

/**
 * The commit email GitHub attributes to a user without exposing their real
 * address: `<id>+<login>@users.noreply.github.com`.
 */
export function githubNoreplyEmail(githubUserId: string, login: string): string {
  return `${githubUserId}+${login}@users.noreply.github.com`;
}

// ── the `/runner/github-token` wire ──────────────────────────────────────────

/** Which of the runner's claims the token is for: a Session it holds, or a leased job. */
export type RunnerGithubTokenClaim =
  | { kind: "session"; sessionId: SessionId }
  | { kind: "job"; jobId: JobId };

export interface RunnerGithubTokenRequest {
  claim: RunnerGithubTokenClaim;
  projectRepoId: ProjectRepoId;
}

function fieldsOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerWireError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** The body the runner sends: exactly one of `sessionId` and `jobId`, plus `projectRepoId`. */
export function runnerGithubTokenBody(request: RunnerGithubTokenRequest): Record<string, string> {
  return request.claim.kind === "session"
    ? { sessionId: request.claim.sessionId, projectRepoId: request.projectRepoId }
    : { jobId: request.claim.jobId, projectRepoId: request.projectRepoId };
}

/** Strict on write: the route refuses anything but {@link runnerGithubTokenBody}'s shape. */
export function parseRunnerGithubTokenRequest(value: unknown): RunnerGithubTokenRequest {
  const fields = fieldsOf(value, "body");
  const projectRepoId = readId("projectRepo", fields.projectRepoId);
  if (projectRepoId === null) throw new RunnerWireError("body.projectRepoId must be a UUID.");
  const hasSession = fields.sessionId !== undefined;
  if (hasSession === (fields.jobId !== undefined)) {
    throw new RunnerWireError("Name exactly one of body.sessionId and body.jobId.");
  }
  if (hasSession) {
    const sessionId = readId("session", fields.sessionId);
    if (sessionId === null) throw new RunnerWireError("body.sessionId must be a UUID.");
    return { claim: { kind: "session", sessionId }, projectRepoId };
  }
  const jobId = readId("job", fields.jobId);
  if (jobId === null) throw new RunnerWireError("body.jobId must be a UUID.");
  return { claim: { kind: "job", jobId }, projectRepoId };
}

/** Who a runner's commits are by: the owner's GitHub name and no-reply email. */
export interface RunnerGitIdentity {
  name: string;
  email: string;
}

/** The 200 reply. Kept in the runner's memory only. */
export interface RunnerGithubTokenGrant {
  /** A GitHub user access token (`ghu_…`). */
  token: string;
  /** Stop using it at this moment; ask again after. */
  useUntil: number;
  /** The git host (with any port) the token is for: `github.com`, or the deployment's GitHub. */
  host: string;
  login: string;
  identity: RunnerGitIdentity;
}

function oneLine(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\r\n]/u.test(value) ||
    value.includes("\0")
  ) {
    throw new RunnerWireError(`reply.${key} must be one line of text.`);
  }
  return value;
}

/** The runner's read of a 200 reply. Strict: a token that cannot be used is not used. */
export function parseRunnerGithubTokenGrant(value: unknown): RunnerGithubTokenGrant {
  const fields = fieldsOf(value, "reply");
  const useUntil = fields.useUntil;
  if (typeof useUntil !== "number" || !Number.isFinite(useUntil)) {
    throw new RunnerWireError("reply.useUntil must be a time.");
  }
  const identity = fieldsOf(fields.identity, "reply.identity");
  return {
    token: oneLine(fields, "token"),
    useUntil,
    host: oneLine(fields, "host"),
    login: oneLine(fields, "login"),
    identity: { name: oneLine(identity, "name"), email: oneLine(identity, "email") },
  };
}

/**
 * Why the route refused. `github_not_connected` means the runner's owner has
 * no GitHub connection: a box then uses its own git credentials, if any.
 * `github_needs_reconnect` asks the person to connect GitHub again.
 */
export const RUNNER_GITHUB_TOKEN_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "not_a_runner",
  "revoked",
  "preview_access_required",
  "not_claimed",
  "not_your_runner",
  "not_found",
  "not_a_member",
  "invalid_repo",
  "github_not_connected",
  "github_needs_reconnect",
  "github_unavailable",
  "github_rate_limited",
] as const;
export type RunnerGithubTokenErrorCode = (typeof RUNNER_GITHUB_TOKEN_ERROR_CODES)[number];

/** A refusal's body: `{ error: { code, message, resetAt } }`. */
export interface RunnerGithubTokenError {
  code: RunnerGithubTokenErrorCode;
  message: string;
  /** When a rate limit lifts, if GitHub said. */
  resetAt: number | null;
}

/**
 * The runner's read of a refusal. Tolerant: a code this build does not know
 * reads as `github_unavailable` (try again later), never as a crash.
 */
export function readRunnerGithubTokenError(value: unknown): RunnerGithubTokenError {
  const error =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { error?: unknown }).error
      : undefined;
  const fields =
    error !== null && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {};
  const code = (RUNNER_GITHUB_TOKEN_ERROR_CODES as readonly unknown[]).includes(fields.code)
    ? (fields.code as RunnerGithubTokenErrorCode)
    : "github_unavailable";
  const message =
    typeof fields.message === "string" ? fields.message.slice(0, 1024) : "GitHub is unavailable.";
  const resetAt =
    typeof fields.resetAt === "number" && Number.isFinite(fields.resetAt) ? fields.resetAt : null;
  return { code, message, resetAt };
}

/**
 * Git credentials for a runner's Sessions: `volli-runner git-credential`
 * (git's credential helper) asks the running runner, and the runner answers
 * with its owner's GitHub token for that Session.
 *
 * - **The environment.** Every Session command gets Volli's helper as
 *   command-scope `credential.helper`, appended after the box's own helpers
 *   (git asks them in order, so a user install's `gh auth setup-git` or SSH
 *   setup still answers first), git's terminal prompt off, and the owner's
 *   commit identity ({@link runnerSessionGitEnv}).
 * - **The helper → runner hop.** The helper sends git's request, the action,
 *   and the Session's `VOLLI_SESSION` / `VOLLI_SESSION_TOKEN` over a Unix
 *   socket only this account can open (0600, in the runner's runtime
 *   directory): one JSON line each way ({@link askGitCredentialDaemon},
 *   {@link serveGitCredentials}).
 * - **The answer.** {@link createGitCredentialBroker} verifies the Session
 *   token, asks `/runner/github-token` for that Session's repository, and
 *   answers `x-access-token` and the token only for the host the token is for.
 *   Anything else, including `github_not_connected`, is the empty answer, so
 *   git moves on to the box's own credentials or fails without a prompt.
 *   The answer carries `password_expiry_utc`, so a box's own `store` or
 *   `cache` helper (git 2.41 and later) never keeps the token; older git's
 *   `store` helper would write it to `~/.git-credentials`.
 * - **Why a socket of its own**, beside the agent socket: the helper speaks no
 *   agent verb, and keeping it off the verb registry keeps the agent surface
 *   unchanged. Same directory, same 0600, same account.
 *
 * Not a sandbox: the same account can read any Session's environment, so it
 * can read the token (VC-163's honest limit, `session-tokens.ts`). What the
 * Session token buys is that a string a model is told to export names no
 * other Session.
 */
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { ProjectRepoId, RunnerGitIdentity, SessionId } from "@volli/shared/cloud";

import { appendGitConfig, parseGitCredentialRequest } from "../host-sign-ins/git-credentials";
import type { RunnerGithubTokens } from "./github-tokens";

/** The user git sends GitHub with an App user token. */
export const GITHUB_TOKEN_USERNAME = "x-access-token";

const MAX_MESSAGE_BYTES = 64 * 1024;
const SOCKET_TIMEOUT_MS = 20_000;

/** One helper call, as the helper sends it. */
export interface GitCredentialQuery {
  v: 1;
  action: string;
  /** git's request, verbatim from the helper's stdin. */
  request: string;
  session: string | null;
  token: string | null;
}

export interface GitCredentialBrokerOptions {
  /** The Session a `VOLLI_SESSION_TOKEN` authenticates, or `null` (`SessionTokenRegistry.verify`). */
  verifySession(token: string | undefined): string | null;
  /** The repository a Session works in (its location's primary repository), or `null`. */
  repositoryOf(sessionId: string): Promise<string | null>;
  tokens: Pick<RunnerGithubTokens, "get">;
  /** Each grant's identity, for {@link runnerSessionGitEnv} on later commands. */
  onIdentity?(identity: RunnerGitIdentity): void;
  /**
   * Answer plain-`http` requests too. Off: a token is sent over TLS only. A
   * local fake GitHub (an acceptance lane's `git http-backend`) turns it on.
   */
  allowHttp?: boolean;
}

/** git's answer for one helper call: what the helper writes on stdout. */
export function createGitCredentialBroker(options: GitCredentialBrokerOptions) {
  // The deployment's GitHub host, once a grant has named it: a request for any
  // other host is answered without asking the backend.
  let githubHost: string | null = null;
  return {
    async answer(query: GitCredentialQuery): Promise<string> {
      if (query.action !== "get") return "";
      const sessionId = options.verifySession(query.token ?? undefined);
      if (sessionId === null || sessionId !== query.session) return "";
      const fields = parseGitCredentialRequest(query.request);
      const protocol = fields.get("protocol");
      const host = fields.get("host");
      const transportOk =
        protocol === "https" || (protocol === "http" && options.allowHttp === true);
      if (!transportOk || host === undefined) return "";
      const asked = fields.get("username");
      if (asked !== undefined && asked !== GITHUB_TOKEN_USERNAME) return "";
      if (githubHost !== null && githubHost !== host.toLowerCase()) return "";
      const projectRepoId = await options.repositoryOf(sessionId);
      if (projectRepoId === null) return "";
      const answer = await options.tokens.get({
        claim: { kind: "session", sessionId: sessionId as SessionId },
        projectRepoId: projectRepoId as ProjectRepoId,
      });
      if (!answer.ok) return "";
      githubHost = answer.grant.host;
      options.onIdentity?.(answer.grant.identity);
      // The token is for the deployment's GitHub only.
      if (answer.grant.host !== host.toLowerCase()) return "";
      // The expiry keeps a box's own `store`/`cache` helper (git ≥ 2.41) from
      // saving a short-lived token that would later answer first, expired.
      const expiry = Math.floor(answer.grant.useUntil / 1000);
      return `username=${GITHUB_TOKEN_USERNAME}\npassword=${answer.grant.token}\npassword_expiry_utc=${expiry}\n`;
    },
  };
}

export type GitCredentialBroker = ReturnType<typeof createGitCredentialBroker>;

function parseQuery(line: string): GitCredentialQuery | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
  if (fields.v !== 1 || text("action") === null || text("request") === null) return null;
  return {
    v: 1,
    action: text("action")!,
    request: text("request")!,
    session: text("session"),
    token: text("token"),
  };
}

/** Reads one newline-terminated message, at most {@link MAX_MESSAGE_BYTES}. */
function readLine(socket: Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buffered = "";
    const done = (value: string | null) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\n");
      if (end >= 0) done(buffered.slice(0, end));
      else if (buffered.length > MAX_MESSAGE_BYTES) done(null);
    };
    const onEnd = () => done(buffered.length > 0 ? buffered : null);
    socket.on("data", onData);
    socket.on("end", onEnd);
  });
}

/** Removes a stale socket at `path`; refuses to delete anything that is not a socket. */
async function clearStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket.`);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Serves {@link GitCredentialBroker} on a Unix socket, mode 0600. One request
 * and one answer per connection; a malformed request gets the empty answer.
 */
export async function serveGitCredentials(input: {
  socketPath: string;
  broker: Pick<GitCredentialBroker, "answer">;
  onError?(error: unknown): void;
}): Promise<{ close(): Promise<void> }> {
  await clearStaleSocket(input.socketPath);
  const server: Server = createServer((socket) => {
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    void (async () => {
      const line = await readLine(socket);
      const query = line === null ? null : parseQuery(line);
      let answer = "";
      if (query !== null) {
        try {
          answer = await input.broker.answer(query);
        } catch (error) {
          input.onError?.(error);
        }
      }
      socket.end(`${JSON.stringify({ v: 1, answer })}\n`);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Created owner-only from the first instant, then pinned there.
    const previous = process.umask(0o177);
    try {
      server.listen(input.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    } finally {
      process.umask(previous);
    }
  });
  await chmod(input.socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }).then(() => clearStaleSocket(input.socketPath).catch(() => undefined)),
  };
}

/**
 * The helper's side: asks the runner at `socketPath` and returns what to
 * write on stdout. Never throws: a runner that is down, slow or confused
 * answers nothing, and git moves on.
 */
export function askGitCredentialDaemon(input: {
  socketPath: string;
  action: string;
  request: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection(input.socketPath);
    socket.setTimeout(input.timeoutMs ?? SOCKET_TIMEOUT_MS, () => settle(""));
    socket.on("error", () => settle(""));
    socket.on("connect", () => {
      const query: GitCredentialQuery = {
        v: 1,
        action: input.action,
        request: input.request,
        session: input.env.VOLLI_SESSION ?? null,
        token: input.env.VOLLI_SESSION_TOKEN ?? null,
      };
      socket.write(`${JSON.stringify(query)}\n`);
    });
    void readLine(socket).then((line) => {
      if (line === null) return settle("");
      try {
        const reply = JSON.parse(line) as { v?: unknown; answer?: unknown };
        settle(reply.v === 1 && typeof reply.answer === "string" ? reply.answer : "");
      } catch {
        settle("");
      }
    });
  });
}

/**
 * The git part of a runner Session command's environment: Volli's helper
 * appended after every helper the box configures, git's terminal prompt off,
 * and, once known, the owner's commit identity (unless `base` names one).
 */
export function runnerSessionGitEnv(
  base: Readonly<Record<string, string>>,
  input: { helperCommand: string; identity: RunnerGitIdentity | null },
): Record<string, string> {
  const env = appendGitConfig(base, [["credential.helper", input.helperCommand]]);
  env.GIT_TERMINAL_PROMPT = "0";
  if (input.identity !== null) {
    for (const role of ["AUTHOR", "COMMITTER"] as const) {
      env[`GIT_${role}_NAME`] ??= input.identity.name;
      env[`GIT_${role}_EMAIL`] ??= input.identity.email;
    }
  }
  return env;
}

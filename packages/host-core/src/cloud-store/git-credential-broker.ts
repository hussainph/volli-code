/**
 * Git credentials for a runner's Sessions: `volli-runner git-credential`
 * (git's credential helper) asks the running runner, and the runner answers
 * with its owner's GitHub token for that Session.
 *
 * - **The environment** ({@link runnerSessionGitEnv}). Whenever Volli's
 *   helper could answer, it is the ONLY helper git asks for the GitHub host:
 *   command-scope `credential.<scheme>://<host>.helper` is reset to empty,
 *   then set to Volli's helper. Command-scope configuration is read after
 *   every configuration file, so this clears every helper the box configures
 *   for that host (host- or path-scoped, with or without `useHttpPath`), and
 *   no box `store`, `cache` or keyring helper sees the token, on get or on
 *   approve. Other hosts keep the box's chain. That holds connected (the
 *   token's host) and before any answer (`github.com`). Only when the owner is
 *   known to be disconnected is the box's chain left whole, with no Volli
 *   helper at all, so a connection made later cannot leak through it either;
 *   the next materialization's token request learns it. So that the person
 *   still learns why git failed, Volli's helper is then appended after the
 *   box's chain in explain-only mode ({@link GIT_CREDENTIAL_EXPLAIN_ONLY_ENV}):
 *   git asks it only when the box's own helpers answered nothing, and it
 *   never answers a token, whatever the runner has learned since. Git's
 *   terminal prompt is off, and the owner's commit identity is set when
 *   known. Command-scope
 *   configuration needs git 2.31; older git ignores it, so the box's own
 *   chain answers and no token is ever offered.
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
 *   A refusal the person can fix (not connected, needs reconnecting, Volli not
 *   installed on the repository's account, rate limited) also comes back as
 *   one line for the helper's stderr (`runnerGithubRefusalLine`), which git
 *   shows whoever ran it, agent or person. That line never names a token.
 *   The answer also carries `password_expiry_utc`, so a helper that did see
 *   it (`store` on git 2.41 and later) would not keep it.
 * - **Why a socket of its own**, beside the agent socket: the helper speaks no
 *   agent verb, and keeping it off the verb registry keeps the agent surface
 *   unchanged. Same directory, same 0600, same account.
 *
 * Not a sandbox: the same account can read any Session's environment, so it
 * can read the token (VC-163's honest limit, `session-tokens.ts`), and an
 * agent that runs `git -c credential.helper=…` adds a helper after Volli's,
 * which git then hands the token on approve. What the Session token buys is
 * that a string a model is told to export names no other Session.
 */
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import {
  DEFAULT_GITHUB_HOST,
  runnerGithubRefusalLine,
  type ProjectRepoId,
  type SessionId,
} from "@volli/shared/cloud";

import { appendGitConfig, parseGitCredentialRequest } from "../host-sign-ins/git-credentials";
import type { RunnerGithub, RunnerGithubTokens } from "./github-tokens";

/** The user git sends GitHub with an App user token. */
export const GITHUB_TOKEN_USERNAME = "x-access-token";

const MAX_MESSAGE_BYTES = 64 * 1024;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Set to `1` in a Session command's environment when Volli's helper sits after
 * the box's own chain ({@link runnerSessionGitEnv}, known disconnected): the
 * helper then only explains a refusal and never answers a token.
 */
export const GIT_CREDENTIAL_EXPLAIN_ONLY_ENV = "VOLLI_GIT_CREDENTIAL_EXPLAIN_ONLY";

/** One helper call, as the helper sends it. */
export interface GitCredentialQuery {
  v: 1;
  action: string;
  /** git's request, verbatim from the helper's stdin. */
  request: string;
  session: string | null;
  token: string | null;
  /** Explain a refusal only; never answer a token. Absent reads as `false`. */
  explainOnly?: boolean;
}

/** The runner's reply to one helper call. */
export interface GitCredentialReply {
  /** What the helper writes on stdout: git's answer, or nothing. */
  answer: string;
  /** What the helper writes on stderr: one line saying why there is no token, or nothing. */
  stderr: string;
}

const NO_REPLY: GitCredentialReply = { answer: "", stderr: "" };

export interface GitCredentialBrokerOptions {
  /** The Session a `VOLLI_SESSION_TOKEN` authenticates, or `null` (`SessionTokenRegistry.verify`). */
  verifySession(token: string | undefined): string | null;
  /** The repository a Session works in (its location's primary repository), or `null`. */
  repositoryOf(sessionId: string): Promise<string | null>;
  tokens: Pick<RunnerGithubTokens, "get" | "github">;
  /**
   * Answer plain-`http` requests too. Off: a token is sent over TLS only. A
   * local fake GitHub (an acceptance lane's `git http-backend`) turns it on.
   */
  allowHttp?: boolean;
  now?: () => number;
}

/** git's answer for one helper call, and why there is none when the person can fix that. */
export function createGitCredentialBroker(options: GitCredentialBrokerOptions) {
  const now = options.now ?? Date.now;
  return {
    async answer(query: GitCredentialQuery): Promise<GitCredentialReply> {
      if (query.action !== "get") return NO_REPLY;
      const sessionId = options.verifySession(query.token ?? undefined);
      if (sessionId === null || sessionId !== query.session) return NO_REPLY;
      const fields = parseGitCredentialRequest(query.request);
      const protocol = fields.get("protocol");
      const host = fields.get("host");
      const transportOk =
        protocol === "https" || (protocol === "http" && options.allowHttp === true);
      if (!transportOk || host === undefined) return NO_REPLY;
      const asked = fields.get("username");
      if (asked !== undefined && asked !== GITHUB_TOKEN_USERNAME) return NO_REPLY;
      // Once a grant has named GitHub's host, any other host costs no backend call.
      const known = options.tokens.github();
      if (known.state === "connected" && known.host !== host.toLowerCase()) return NO_REPLY;
      const projectRepoId = await options.repositoryOf(sessionId);
      if (projectRepoId === null) return NO_REPLY;
      const answer = await options.tokens.get({
        claim: { kind: "session", sessionId: sessionId as SessionId },
        projectRepoId: projectRepoId as ProjectRepoId,
      });
      if (!answer.ok) {
        const line = runnerGithubRefusalLine(answer.error, now());
        return line === null ? NO_REPLY : { answer: "", stderr: `${line}\n` };
      }
      // Behind the box's own chain, a token would reach its helpers on approve.
      if (query.explainOnly === true) return NO_REPLY;
      // The token is for the deployment's GitHub only.
      if (answer.grant.host !== host.toLowerCase()) return NO_REPLY;
      // The expiry keeps a box's own `store`/`cache` helper (git ≥ 2.41) from
      // saving a short-lived token that would later answer first, expired.
      const expiry = Math.floor(answer.grant.useUntil / 1000);
      return {
        answer: `username=${GITHUB_TOKEN_USERNAME}\npassword=${answer.grant.token}\npassword_expiry_utc=${expiry}\n`,
        stderr: "",
      };
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
    explainOnly: fields.explainOnly === true,
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
 * and one reply (`{ v: 1, answer, stderr }`) per connection; a malformed
 * request gets the empty reply.
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
      let reply = NO_REPLY;
      if (query !== null) {
        try {
          reply = await input.broker.answer(query);
        } catch (error) {
          input.onError?.(error);
        }
      }
      socket.end(`${JSON.stringify({ v: 1, answer: reply.answer, stderr: reply.stderr })}\n`);
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
 * write on stdout and stderr. Never throws: a runner that is down, slow or
 * confused answers nothing, and git moves on.
 */
export function askGitCredentialDaemon(input: {
  socketPath: string;
  action: string;
  request: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}): Promise<GitCredentialReply> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: GitCredentialReply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection(input.socketPath);
    socket.setTimeout(input.timeoutMs ?? SOCKET_TIMEOUT_MS, () => settle(NO_REPLY));
    socket.on("error", () => settle(NO_REPLY));
    socket.on("connect", () => {
      const query: GitCredentialQuery = {
        v: 1,
        action: input.action,
        request: input.request,
        session: input.env.VOLLI_SESSION ?? null,
        token: input.env.VOLLI_SESSION_TOKEN ?? null,
        explainOnly: input.env[GIT_CREDENTIAL_EXPLAIN_ONLY_ENV] === "1",
      };
      socket.write(`${JSON.stringify(query)}\n`);
    });
    void readLine(socket).then((line) => {
      if (line === null) return settle(NO_REPLY);
      try {
        const reply = JSON.parse(line) as { v?: unknown; answer?: unknown; stderr?: unknown };
        if (reply.v !== 1 || typeof reply.answer !== "string") return settle(NO_REPLY);
        settle({
          answer: reply.answer,
          // One line at most, of the runner's own wording.
          stderr: typeof reply.stderr === "string" ? oneStderrLine(reply.stderr) : "",
        });
      } catch {
        settle(NO_REPLY);
      }
    });
  });
}

/** The first line of `text`, without control characters, newline-terminated; or "". */
function oneStderrLine(text: string): string {
  const line = (text.split("\n", 1)[0] ?? "").replace(/\p{Cc}/gu, "").slice(0, 512);
  return line === "" ? "" : `${line}\n`;
}

/**
 * The git part of a runner Session command's environment (see the module
 * comment): unless the owner is known to be disconnected, the GitHub host's
 * helper chain is reset to Volli's helper alone (`http://` too, which the
 * broker answers only when `allowHttp` is on); disconnected, the box's chain
 * is left as it is and Volli's helper follows it, explain-only. Git's
 * terminal prompt is off either way, and the owner's commit identity is set
 * when known (unless `base` names one). Rebuild it for every command: the
 * state moves as answers arrive.
 */
export function runnerSessionGitEnv(
  base: Readonly<Record<string, string>>,
  input: { helperCommand: string; github: RunnerGithub },
): Record<string, string> {
  const github = input.github;
  const host = github.state === "connected" ? github.host : DEFAULT_GITHUB_HOST;
  const exclusive = github.state !== "disconnected";
  const entries = ["https", "http"].flatMap((scheme): [string, string][] => {
    const scope = `credential.${scheme}://${host}.helper`;
    return exclusive
      ? [
          [scope, ""],
          [scope, input.helperCommand],
        ]
      : [[scope, input.helperCommand]];
  });
  const env = appendGitConfig(base, entries);
  if (exclusive) delete env[GIT_CREDENTIAL_EXPLAIN_ONLY_ENV];
  else env[GIT_CREDENTIAL_EXPLAIN_ONLY_ENV] = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  if (github.state === "connected") {
    for (const role of ["AUTHOR", "COMMITTER"] as const) {
      env[`GIT_${role}_NAME`] ??= github.identity.name;
      env[`GIT_${role}_EMAIL`] ??= github.identity.email;
    }
  }
  return env;
}

/**
 * The runner's GitHub tokens: `POST /runner/github-token` on the deployment's
 * site, with the runner's own token, kept in memory only.
 *
 * A grant is cached per claim and repository until the backend's `useUntil`
 * (already well before GitHub expires it); concurrent askers share one
 * request. `github_not_connected` is remembered for a minute, so a box whose
 * owner never connected GitHub does not ask on every git command. Nothing is
 * written to disk, and a refresh token never reaches the runner.
 */
import type { ManagedCloneCredentials } from "./managed-clone";
import {
  parseRunnerGithubTokenGrant,
  readRunnerGithubTokenError,
  RUNNER_GITHUB_TOKEN_PATH,
  runnerGithubTokenBody,
  type RunnerGitIdentity,
  type RunnerGithubTokenError,
  type RunnerGithubTokenGrant,
  type RunnerGithubTokenRequest,
  type ProjectRepoId,
} from "@volli/shared/cloud";

export type RunnerGithubTokenAnswer =
  | { ok: true; grant: RunnerGithubTokenGrant }
  | { ok: false; error: RunnerGithubTokenError };

/** How long "this owner hasn't connected GitHub" is believed without asking again. */
export const GITHUB_NOT_CONNECTED_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface RunnerGithubTokensOptions {
  /** The deployment's site URL (`https://<deployment>.convex.site`). */
  siteUrl: string;
  /** The runner's current token, or `null` while it has none (unlinked, offline). */
  runnerToken(): Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

const keyOf = (request: RunnerGithubTokenRequest) =>
  `${request.claim.kind === "session" ? `s:${request.claim.sessionId}` : `j:${request.claim.jobId}`}:${request.projectRepoId}`;

function failure(code: RunnerGithubTokenError["code"], message: string): RunnerGithubTokenAnswer {
  return { ok: false, error: { code, message, resetAt: null } };
}

export function createRunnerGithubTokens(options: RunnerGithubTokensOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const url = `${options.siteUrl.replace(/\/+$/u, "")}${RUNNER_GITHUB_TOKEN_PATH}`;
  const cached = new Map<string, { answer: RunnerGithubTokenAnswer; until: number }>();
  const flights = new Map<string, Promise<RunnerGithubTokenAnswer>>();

  async function ask(request: RunnerGithubTokenRequest): Promise<RunnerGithubTokenAnswer> {
    const token = await options.runnerToken();
    if (token === null)
      return failure("unauthenticated", "This runner is not linked or not online.");
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(runnerGithubTokenBody(request)),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      return failure("github_unavailable", "Volli Cloud is unreachable.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) return { ok: false, error: readRunnerGithubTokenError(body) };
    try {
      return { ok: true, grant: parseRunnerGithubTokenGrant(body) };
    } catch {
      return failure("github_unavailable", "Volli Cloud answered with an unusable token.");
    }
  }

  return {
    /** The owner's GitHub token for this claim and repository, or why there is none. */
    get(request: RunnerGithubTokenRequest): Promise<RunnerGithubTokenAnswer> {
      const key = keyOf(request);
      const hit = cached.get(key);
      if (hit !== undefined && now() < hit.until) return Promise.resolve(hit.answer);
      cached.delete(key);
      const existing = flights.get(key);
      if (existing !== undefined) return existing;
      const flight = ask(request)
        .then((answer) => {
          if (answer.ok) cached.set(key, { answer, until: answer.grant.useUntil });
          else if (answer.error.code === "github_not_connected")
            cached.set(key, { answer, until: now() + GITHUB_NOT_CONNECTED_TTL_MS });
          return answer;
        })
        .finally(() => flights.delete(key));
      flights.set(key, flight);
      return flight;
    },
    /** Drops every cached answer for a Session or job (its attachment closed, its lease ended). */
    forget(id: string): void {
      for (const key of cached.keys()) {
        if (key.startsWith(`s:${id}:`) || key.startsWith(`j:${id}:`)) cached.delete(key);
      }
    },
  };
}

export type RunnerGithubTokens = ReturnType<typeof createRunnerGithubTokens>;

/**
 * A managed clone's credentials over these tokens: its own fetch uses the
 * owner's token for the claim it runs under, and each grant's identity is
 * handed on, so a Session's commits take the owner's identity from its very
 * first command, before any of its own git asks for a token.
 */
export function managedCloneCredentials(
  tokens: Pick<RunnerGithubTokens, "get">,
  onIdentity?: (identity: RunnerGitIdentity) => void,
): ManagedCloneCredentials {
  return {
    async forRemote({ projectRepoId, claim }) {
      const answer = await tokens.get({ claim, projectRepoId: projectRepoId as ProjectRepoId });
      if (!answer.ok) return null;
      onIdentity?.(answer.grant.identity);
      return { host: answer.grant.host, token: answer.grant.token };
    },
  };
}

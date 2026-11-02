/**
 * `/runner/*`: the HTTP doors a box uses before it has a runner token.
 *
 * - `POST /runner/link` — an install token becomes a runner and its first
 *   refresh credential.
 * - `POST /runner/link/start` and `/runner/link/poll` — the device-code link:
 *   the box prints a code, the person approves it in Settings, the poll that
 *   follows returns the credential once.
 * - `POST /runner/token` — the refresh credential becomes a 15-minute runner
 *   token and its own successor (rotation with reuse detection,
 *   `runners.rotateCredential`).
 * - `POST /runner/github-token` — the one door here a runner calls WITH its
 *   runner token (`Authorization: Bearer …`): its owner's GitHub user token
 *   for a Session or job it holds (`runnerGithub.ts`). Its refusals use
 *   `RUNNER_GITHUB_TOKEN_ERROR_CODES`.
 *
 * The three linking doors are rate-limited before they do any work
 * (`runnerLinkRateLimit.ts`): per network, per code, and for device-code
 * starts deployment-wide. A refusal is a 429 `rate_limited` with
 * `Retry-After` in seconds.
 *
 * Every secret is minted here (an action) and only its hash reaches a
 * mutation. Bodies and replies are the shared wire in `@volli/shared/cloud`;
 * failures are `{ error: { code, message } }` with a code from
 * `RUNNER_HTTP_ERROR_CODES`. No CORS headers: a browser page has no business
 * reading these replies.
 */

import { ConvexError } from "convex/values";

import {
  RUNNER_GITHUB_TOKEN_ERROR_CODES,
  RUNNER_LINK_POLL_INTERVAL_MS,
  RUNNER_SECRET_PREFIXES,
  RUNNER_TOKEN_TTL_MS,
  RunnerWireError,
  formatUserCode,
  githubInstalledOn,
  githubNoreplyEmail,
  githubRepoOfRemote,
  parseRunnerGithubTokenRequest,
  parseRunnerDeviceLinkPollRequest,
  parseRunnerDeviceLinkStartRequest,
  parseRunnerLinkRequest,
  parseRunnerTokenRequest,
  secretHash,
  type RunnerDeviceLinkPoll,
  type RunnerDeviceLinkStart,
  type RunnerGithubTokenErrorCode,
  type RunnerGithubTokenGrant,
  type RunnerHttpErrorBody,
  type RunnerHttpErrorCode,
  type RunnerLinkGrant,
  type RunnerTokenGrant,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { mintGithubToken, type GithubMint } from "./githubTokens";
import { githubClient } from "./lib/github/client";
import { readGithubConfig } from "./lib/github/config";
import { githubRemoteHost } from "./lib/runnerContext";
import { mintSecret, mintUserCode, runnerSigningKey, signRunnerToken } from "./lib/runnerSecrets";

const STATUS_OF: Record<RunnerHttpErrorCode, number> = {
  invalid_request: 400,
  invalid_install_token: 401,
  invalid_link_request: 404,
  invalid_credential: 401,
  revoked: 403,
  issuer_unconfigured: 503,
  preview_access_required: 403,
  rate_limited: 429,
};

const MESSAGE_OF: Record<RunnerHttpErrorCode, string> = {
  invalid_request: "The request is malformed.",
  invalid_install_token:
    "This install token is unknown, used or expired. Make a new one in Settings → Runners.",
  invalid_link_request: "This link request is unknown or already used. Start linking again.",
  invalid_credential: "This runner's credential is not valid. Link it again.",
  revoked: "This runner was removed from its account. Link it again.",
  issuer_unconfigured: "This deployment cannot issue runner tokens yet.",
  preview_access_required: "This account needs preview access and the current Preview Agreement.",
  rate_limited: "Too many linking requests.",
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function failure(code: RunnerHttpErrorCode, message = MESSAGE_OF[code]): Response {
  const body: RunnerHttpErrorBody = { error: { code, message } };
  return reply(STATUS_OF[code], body);
}

/** The 429 a refused admission answers with; `Retry-After` is whole seconds, at least one. */
function rateLimited(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const message = `${MESSAGE_OF.rate_limited} Try again in ${seconds} s.`;
  const body: RunnerHttpErrorBody = { error: { code: "rate_limited", message } };
  return reply(STATUS_OF.rate_limited, body, { "retry-after": String(seconds) });
}

/**
 * The caller's address as Convex saw the request, never a header the caller
 * could set. What the rate limits key on, and, cut to 64 characters
 * ({@link shownIp}), a hint for the approval sheet and the audit trail.
 */
async function requestIp(ctx: ActionCtx): Promise<string | null> {
  const { ip } = await ctx.meta.getRequestMetadata();
  return ip;
}

function shownIp(ip: string | null): string | null {
  return ip === null ? null : ip.slice(0, 64);
}

/**
 * The parsed body, or the `invalid_request` reply. JSON only: a browser page
 * can send a form or `text/plain` POST without a preflight, but not this.
 */
async function bodyOf<T>(request: Request, parse: (value: unknown) => T): Promise<T | Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return failure("invalid_request", "Send the body as application/json.");
  }
  try {
    return parse(await request.json());
  } catch (error) {
    if (error instanceof RunnerWireError || error instanceof SyntaxError) {
      return failure("invalid_request", error.message);
    }
    throw error;
  }
}

export const link = httpAction(async (ctx, request) => {
  const body = await bodyOf(request, parseRunnerLinkRequest);
  if (body instanceof Response) return body;
  const tokenHash = secretHash(body.installToken);
  const admitted = await ctx.runMutation(internal.runnerLinkRateLimit.admitLink, {
    ip: await requestIp(ctx),
    tokenHash,
  });
  if (!admitted.ok) return rateLimited(admitted.retryAfterMs);
  const credential = mintSecret(RUNNER_SECRET_PREFIXES.credential);
  const result = await ctx.runMutation(internal.runners.linkWithInstallToken, {
    tokenHash,
    credentialHash: secretHash(credential),
    host: body.host,
    name: body.name,
  });
  if (!result.ok) return failure(result.code);
  const grant: RunnerLinkGrant = {
    runnerId: result.runnerId,
    name: result.name,
    credential,
    generation: result.generation,
  };
  return reply(200, grant);
});

/** Code collisions are rare (20^8 codes); a few retries make them invisible. */
const START_ATTEMPTS = 4;

export const linkStart = httpAction(async (ctx, request) => {
  const body = await bodyOf(request, parseRunnerDeviceLinkStartRequest);
  if (body instanceof Response) return body;
  const ip = await requestIp(ctx);
  const admitted = await ctx.runMutation(internal.runnerLinkRateLimit.admitLinkStart, { ip });
  if (!admitted.ok) return rateLimited(admitted.retryAfterMs);
  const pollSecret = mintSecret(RUNNER_SECRET_PREFIXES.pollSecret);
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const requestId = crypto.randomUUID();
    const userCode = mintUserCode();
    const result = await ctx.runMutation(internal.runners.startDeviceLink, {
      requestId,
      userCodeHash: secretHash(userCode),
      pollSecretHash: secretHash(pollSecret),
      host: body.host,
      ip: shownIp(ip),
    });
    if (result.ok) {
      const started: RunnerDeviceLinkStart = {
        requestId,
        userCode: formatUserCode(userCode),
        pollSecret,
        intervalMs: RUNNER_LINK_POLL_INTERVAL_MS,
        expiresAt: result.expiresAt,
      };
      return reply(200, started);
    }
  }
  throw new Error("Could not allocate a free device code");
});

export const linkPoll = httpAction(async (ctx, request) => {
  const body = await bodyOf(request, parseRunnerDeviceLinkPollRequest);
  if (body instanceof Response) return body;
  const admitted = await ctx.runMutation(internal.runnerLinkRateLimit.admitLinkPoll, {
    ip: await requestIp(ctx),
    requestId: body.requestId,
  });
  if (!admitted.ok) return rateLimited(admitted.retryAfterMs);
  const credential = mintSecret(RUNNER_SECRET_PREFIXES.credential);
  const result = await ctx.runMutation(internal.runners.pollDeviceLink, {
    requestId: body.requestId,
    pollSecretHash: secretHash(body.pollSecret),
    credentialHash: secretHash(credential),
  });
  if (!result.ok) return failure(result.code);
  const poll: RunnerDeviceLinkPoll =
    result.status === "linked"
      ? {
          status: "linked",
          grant: {
            runnerId: result.runnerId,
            name: result.name,
            credential,
            generation: result.generation,
          },
        }
      : { status: result.status };
  return reply(200, poll);
});

export const token = httpAction(async (ctx, request) => {
  const body = await bodyOf(request, parseRunnerTokenRequest);
  if (body instanceof Response) return body;
  // Checked before rotating: a credential is never spent on a token that cannot be signed.
  const signing = await runnerSigningKey();
  if (signing === null) return failure("issuer_unconfigured");
  const credential = mintSecret(RUNNER_SECRET_PREFIXES.credential);
  const result = await ctx.runMutation(internal.runners.rotateCredential, {
    runnerId: body.runnerId,
    presentedHash: secretHash(body.credential),
    nextHash: secretHash(credential),
    ip: shownIp(await requestIp(ctx)),
  });
  if (!result.ok) return failure(result.code);
  const serverTime = Date.now();
  const expiresAt = serverTime + RUNNER_TOKEN_TTL_MS;
  const jwt = await signRunnerToken(
    signing,
    body.runnerId,
    { own: result.ownerUserId, gen: result.generation, kind: result.kind },
    serverTime,
    expiresAt,
  );
  const grant: RunnerTokenGrant = {
    token: jwt,
    expiresAt,
    serverTime,
    credential,
    generation: result.generation,
  };
  return reply(200, grant);
});

const GITHUB_TOKEN_STATUS_OF: Record<RunnerGithubTokenErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  not_a_runner: 403,
  revoked: 403,
  preview_access_required: 403,
  not_claimed: 403,
  not_your_runner: 403,
  not_found: 404,
  not_a_member: 403,
  invalid_repo: 400,
  github_not_connected: 409,
  github_needs_reconnect: 409,
  github_unavailable: 503,
  github_rate_limited: 429,
  github_not_installed: 409,
};

const GITHUB_MINT_REFUSAL: Record<
  Extract<GithubMint, { ok: false }>["code"],
  { code: RunnerGithubTokenErrorCode; message: string }
> = {
  not_connected: {
    code: "github_not_connected",
    message: "This runner's owner hasn't connected GitHub to Volli.",
  },
  needs_reconnect: {
    code: "github_needs_reconnect",
    message: "Connect GitHub to Volli again in Settings.",
  },
  github_unavailable: { code: "github_unavailable", message: "GitHub is unavailable." },
  github_rate_limited: { code: "github_rate_limited", message: "GitHub is rate limiting Volli." },
};

function githubTokenFailure(
  code: RunnerGithubTokenErrorCode,
  message: string,
  resetAt: number | null = null,
  account?: string,
): Response {
  const seconds = resetAt === null ? null : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return reply(
    GITHUB_TOKEN_STATUS_OF[code],
    { error: { code, message, resetAt, ...(account === undefined ? {} : { account }) } },
    seconds === null ? {} : { "retry-after": String(seconds) },
  );
}

/** How long the installation check may add to a grant before it is skipped. */
const INSTALLATION_CHECK_MS = 3_000;

/**
 * The GitHub account a repository needs Volli installed on, when the person's
 * token reaches no installation there; `null` when it does, when the remote is
 * not a GitHub repository, or when GitHub could not say in time. Only a
 * definite "not installed" refuses: any doubt hands the token out, and GitHub
 * decides. A recorded remote may name an old owner (GitHub redirects git after
 * a rename or transfer), so before refusing, the repository's current owner is
 * asked for and checked too.
 */
async function missingInstallation(
  remoteUrl: string | null,
  userToken: string,
): Promise<string | null> {
  const app = readGithubConfig();
  const repo = remoteUrl === null ? null : githubRepoOfRemote(remoteUrl, githubRemoteHost());
  if (app === null || repo === null) return null;
  const client = githubClient(app);
  const check = async (): Promise<string | null> => {
    const listed = await client.userInstallationList(userToken);
    if (!listed.complete || githubInstalledOn(listed.installations, repo.owner)) return null;
    const current = await client.userRepository(userToken, repo.owner, repo.name);
    const owner = current?.owner ?? repo.owner;
    return githubInstalledOn(listed.installations, owner) ? null : owner;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), INSTALLATION_CHECK_MS);
      }),
    ]);
  } catch (error) {
    console.warn("runner github-token: installation check failed; granting", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A refusal thrown by the authorization read, if it is one of this route's codes. */
function knownRefusal(
  error: unknown,
): { code: RunnerGithubTokenErrorCode; message: string } | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (data === null || typeof data !== "object") return null;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (!(RUNNER_GITHUB_TOKEN_ERROR_CODES as readonly unknown[]).includes(code)) return null;
  return {
    code: code as RunnerGithubTokenErrorCode,
    message: typeof message === "string" ? message : String(code),
  };
}

export const githubToken = httpAction(async (ctx, request) => {
  const body = await bodyOf(request, parseRunnerGithubTokenRequest);
  if (body instanceof Response) return body;
  // An expired or foreign token is as good as none: the runner refreshes and retries.
  const identity = await ctx.auth.getUserIdentity().catch(() => null);
  if (identity === null) {
    return githubTokenFailure("unauthenticated", "Send this runner's token as a Bearer token.");
  }
  let authorized: {
    ownerUserId: string;
    identity: { name: string; email: string } | null;
    remoteUrl: string | null;
  };
  try {
    authorized = await ctx.runQuery(internal.runnerGithub.authorizeToken, body);
  } catch (error) {
    const refusal = knownRefusal(error);
    if (refusal === null) throw error;
    return githubTokenFailure(refusal.code, refusal.message);
  }
  let mint: GithubMint;
  try {
    mint = await mintGithubToken(ctx, authorized.ownerUserId);
  } catch (error) {
    // A refresh with the App's configuration gone (`github_not_configured`).
    if (!(error instanceof ConvexError)) throw error;
    return githubTokenFailure("github_unavailable", GITHUB_MINT_REFUSAL.github_unavailable.message);
  }
  if (!mint.ok) {
    const refusal = GITHUB_MINT_REFUSAL[mint.code];
    return githubTokenFailure(refusal.code, refusal.message, mint.resetAt);
  }
  const account = await missingInstallation(authorized.remoteUrl, mint.token);
  if (account !== null) {
    return githubTokenFailure(
      "github_not_installed",
      `Install Volli on ${account} on GitHub.`,
      null,
      account,
    );
  }
  const grant: RunnerGithubTokenGrant = {
    token: mint.token,
    useUntil: mint.useUntil,
    host: githubRemoteHost(),
    login: mint.login,
    identity: authorized.identity ?? {
      name: mint.login,
      email: githubNoreplyEmail(mint.githubUserId, mint.login),
    },
  };
  return reply(200, grant);
});

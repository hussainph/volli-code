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
 *
 * Every secret is minted here (an action) and only its hash reaches a
 * mutation. Bodies and replies are the shared wire in `@volli/shared/cloud`;
 * failures are `{ error: { code, message } }` with a code from
 * `RUNNER_HTTP_ERROR_CODES`. No CORS headers: a browser page has no business
 * reading these replies.
 */

import {
  RUNNER_LINK_POLL_INTERVAL_MS,
  RUNNER_SECRET_PREFIXES,
  RUNNER_TOKEN_TTL_MS,
  RunnerWireError,
  formatUserCode,
  parseRunnerDeviceLinkPollRequest,
  parseRunnerDeviceLinkStartRequest,
  parseRunnerLinkRequest,
  parseRunnerTokenRequest,
  secretHash,
  type RunnerDeviceLinkPoll,
  type RunnerDeviceLinkStart,
  type RunnerHttpErrorBody,
  type RunnerHttpErrorCode,
  type RunnerLinkGrant,
  type RunnerTokenGrant,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { mintSecret, mintUserCode, runnerSigningKey, signRunnerToken } from "./lib/runnerSecrets";

const STATUS_OF: Record<RunnerHttpErrorCode, number> = {
  invalid_request: 400,
  invalid_install_token: 401,
  invalid_link_request: 404,
  invalid_credential: 401,
  revoked: 403,
  issuer_unconfigured: 503,
};

const MESSAGE_OF: Record<RunnerHttpErrorCode, string> = {
  invalid_request: "The request is malformed.",
  invalid_install_token:
    "This install token is unknown, used or expired. Make a new one in Settings → Runners.",
  invalid_link_request: "This link request is unknown or already used. Start linking again.",
  invalid_credential: "This runner's credential is not valid. Link it again.",
  revoked: "This runner was removed from its account. Link it again.",
  issuer_unconfigured: "This deployment cannot issue runner tokens yet.",
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function failure(code: RunnerHttpErrorCode, message = MESSAGE_OF[code]): Response {
  const body: RunnerHttpErrorBody = { error: { code, message } };
  return reply(STATUS_OF[code], body);
}

/**
 * The caller's address as Convex saw the request, never a header the caller
 * could set. A hint for the approval sheet and the audit trail, never a
 * security decision.
 */
async function callerIp(ctx: ActionCtx): Promise<string | null> {
  const { ip } = await ctx.meta.getRequestMetadata();
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
  const credential = mintSecret(RUNNER_SECRET_PREFIXES.credential);
  const result = await ctx.runMutation(internal.runners.linkWithInstallToken, {
    tokenHash: secretHash(body.installToken),
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
  const pollSecret = mintSecret(RUNNER_SECRET_PREFIXES.pollSecret);
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const requestId = crypto.randomUUID();
    const userCode = mintUserCode();
    const result = await ctx.runMutation(internal.runners.startDeviceLink, {
      requestId,
      userCodeHash: secretHash(userCode),
      pollSecretHash: secretHash(pollSecret),
      host: body.host,
      ip: await callerIp(ctx),
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
    ip: await callerIp(ctx),
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

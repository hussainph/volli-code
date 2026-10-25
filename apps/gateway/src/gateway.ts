/**
 * The relay: one request from a runner, checked against its grant, forwarded
 * to the provider with the connection's real key, streamed back unchanged and
 * metered from the provider's own usage report.
 *
 *   runner ──grant──▶ /v1/c/<connection>/<provider path> ──real key──▶ <route.up>/<provider path>
 *
 * What the gateway keeps is metadata only (ids, model, token counts, status,
 * timing). It never logs or stores a request body, a response body or a key.
 *
 * Every refusal happens before anything is forwarded, so a refused call was
 * never produced or billed and the runner may retry it once with a fresh grant.
 * There is no fallback to another connection: another connection is another
 * payer, and switching is the person's explicit choice.
 */
import {
  GATEWAY_CALL_ID_HEADER,
  GATEWAY_CONNECTION_PATH_PREFIX,
  type GatewayErrorCode,
  type GatewayGrantClaims,
  type GatewayGrantRoute,
  type GatewayUsageRecord,
  type GatewayUsageStatus,
  gatewayGrantSessionId,
  isUuid,
} from "@volli/shared/cloud";

import { DEFAULT_MAX_BODY_BYTES, type GatewayEnv, type UsageBatch, type WaitUntil } from "./env.ts";
import { gatewayError } from "./errors.ts";
import { IssuerKeys, verifyGrant } from "./grant.ts";
import { meteredBody } from "./metered-body.ts";
import { PROVIDER_ADAPTERS } from "./providers.ts";
import { SealingKeyring } from "./sealed-key.ts";
import {
  forwardedRequestHeaders,
  parseUpstreamBase,
  relayedResponseHeaders,
  upstreamUrl,
} from "./upstream.ts";
import { consumeUsage } from "./usage-consumer.ts";

type FetchFn = (input: string | Request, init?: RequestInit) => Promise<Response>;

export interface GatewayDeps {
  /** Outbound fetch: the provider, the issuer's JWKS, the usage ingest endpoint. */
  fetch: FetchFn;
  now(): number;
}

export interface Gateway {
  fetch(request: Request, env: GatewayEnv, ctx: WaitUntil): Promise<Response>;
  queue(batch: UsageBatch, env: GatewayEnv): Promise<void>;
}

const RELAYED_METHODS = new Set(["GET", "POST"]);

/** Where a runner's SDK may put the grant: it sends it as the provider "API key". */
function presentedGrant(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    return match ? match[1]! : null;
  }
  return headers.get("x-api-key") ?? headers.get("x-goog-api-key");
}

class Refusal {
  readonly code: GatewayErrorCode;
  constructor(code: GatewayErrorCode) {
    this.code = code;
  }
}

/** Builds the Worker's handlers. The deployed Worker passes the global fetch and clock. */
export function createGateway(deps: GatewayDeps): Gateway {
  // Isolate-lifetime caches, keyed by the configuration they were built from.
  const issuerKeys = new Map<string, IssuerKeys>();
  const keyrings = new Map<string, SealingKeyring | null>();

  function keysFor(env: GatewayEnv): IssuerKeys | null {
    const source = env.GATEWAY_JWKS
      ? { inline: env.GATEWAY_JWKS }
      : env.GATEWAY_JWKS_URL
        ? { url: env.GATEWAY_JWKS_URL }
        : null;
    if (!source) return null;
    const cacheKey = JSON.stringify(source);
    let keys = issuerKeys.get(cacheKey);
    if (!keys) {
      keys = new IssuerKeys(source, deps.fetch, deps.now);
      issuerKeys.set(cacheKey, keys);
    }
    return keys;
  }

  function keyringFor(env: GatewayEnv): SealingKeyring | null {
    const raw = env.GATEWAY_SEALING_KEYS ?? "";
    if (!keyrings.has(raw)) keyrings.set(raw, SealingKeyring.parse(raw));
    return keyrings.get(raw)!;
  }

  async function authorize(request: Request, env: GatewayEnv): Promise<GatewayGrantClaims> {
    const token = presentedGrant(request.headers);
    if (!token) throw new Refusal("volli_grant_missing");
    const keys = keysFor(env);
    if (!env.GATEWAY_ISSUER || !keys) throw new Refusal("volli_gateway_misconfigured");
    const verification = await verifyGrant(token, {
      issuer: env.GATEWAY_ISSUER,
      keys,
      nowMs: deps.now(),
    });
    if (!verification.ok) throw new Refusal(verification.code);
    return verification.claims;
  }

  async function assertNotRevoked(
    env: GatewayEnv,
    claims: GatewayGrantClaims,
    route: GatewayGrantRoute,
  ) {
    if (!env.REVOCATIONS) return;
    const keys = [`grant:${claims.jti}`, `conn:${route.conn}`, `conn:${route.conn}:kv:${route.kv}`];
    const hits = await Promise.all(keys.map((key) => env.REVOCATIONS!.get(key)));
    if (hits.some((hit) => hit !== null)) throw new Refusal("volli_grant_revoked");
  }

  async function relay(request: Request, env: GatewayEnv, ctx: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true });
    }
    if (!url.pathname.startsWith(GATEWAY_CONNECTION_PATH_PREFIX))
      throw new Refusal("volli_route_not_found");
    const tail = url.pathname.slice(GATEWAY_CONNECTION_PATH_PREFIX.length);
    const slash = tail.indexOf("/");
    const connectionId = slash === -1 ? tail : tail.slice(0, slash);
    const rest = slash === -1 ? "" : tail.slice(slash);
    if (!isUuid(connectionId)) throw new Refusal("volli_route_not_found");
    if (!RELAYED_METHODS.has(request.method)) throw new Refusal("volli_method_not_allowed");

    const claims = await authorize(request, env);
    const callId = request.headers.get(GATEWAY_CALL_ID_HEADER);
    if (!isUuid(callId)) throw new Refusal("volli_call_id_missing");
    const granted = Object.entries(claims.routes).find(([, route]) => route.conn === connectionId);
    if (!granted) throw new Refusal("volli_route_not_granted");
    const [providerId, route] = granted;
    await assertNotRevoked(env, claims, route);

    const base = parseUpstreamBase(route.up);
    if (!base) throw new Refusal("volli_upstream_forbidden");
    const target = upstreamUrl(base, rest, url.search);
    // The incoming URL is already normalized, so `rest` holds no dot segment
    // that could climb out of the base; the check stays as the last word.
    /* v8 ignore next -- unreachable through a parsed request URL; upstream.test.ts covers the check. */
    if (!target) throw new Refusal("volli_route_not_found");

    const maxBody = Number(env.GATEWAY_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES;
    if (Number(request.headers.get("content-length") ?? 0) > maxBody)
      throw new Refusal("volli_body_too_large");

    const keyring = keyringFor(env);
    if (!keyring) throw new Refusal("volli_gateway_misconfigured");
    const opened = await keyring.open(route.sk, route.conn, route.kv);
    if (!opened.ok) throw new Refusal(opened.code);

    const adapter = PROVIDER_ADAPTERS[route.api];
    let body: ArrayBuffer | string | undefined;
    let requestedModel: string | undefined;
    if (request.method === "POST") {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > maxBody) throw new Refusal("volli_body_too_large");
      body = bytes;
      if (
        route.api === "openai-completions" &&
        request.headers.get("content-type")?.includes("json")
      ) {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
          const model = (parsed as { model?: unknown } | null)?.model;
          if (typeof model === "string") requestedModel = model;
          const edited = adapter.editBody(parsed);
          if (edited !== null) body = JSON.stringify(edited);
        } catch {
          // Not JSON: forward it as it came and let the provider say so.
        }
      }
    }

    const headers = forwardedRequestHeaders(request.headers);
    for (const [name, value] of forwardedRequestHeaders(new Headers(route.hdr)))
      headers.set(name, value);
    for (const [name, value] of Object.entries(adapter.authHeaders(opened.key)))
      headers.set(name, value);

    const startedAt = deps.now();
    let upstream: Response;
    try {
      upstream = await deps.fetch(target.toString(), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
      });
    } catch {
      throw new Refusal("volli_upstream_unreachable");
    }

    const meter = adapter.meter();
    const usageRecord = (
      status: GatewayUsageStatus,
      durationMs: number,
      ttftMs?: number,
    ): GatewayUsageRecord => {
      const modelId = meter.modelId ?? requestedModel;
      return {
        callId,
        grantJti: claims.jti,
        workspaceId: claims.ws,
        ...(claims.prj === undefined ? {} : { projectId: claims.prj }),
        userId: claims.act.user,
        sessionId: gatewayGrantSessionId(claims.sub)!,
        runnerId: claims.act.runner,
        connectionId: route.conn,
        keyVersion: route.kv,
        providerId,
        api: route.api,
        ...(modelId === undefined ? {} : { modelId }),
        usage: meter.usage,
        status,
        upstreamStatus: upstream.status,
        startedAt,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        durationMs,
      };
    };
    const emit = (record: Promise<GatewayUsageRecord>) =>
      ctx.waitUntil(record.then((value) => sendUsage(env, value)));

    const redirected = upstream.status >= 300 && upstream.status < 400;
    const rejectedKey = upstream.status === 401 || upstream.status === 403;
    if (redirected || rejectedKey || !upstream.body) {
      await upstream.body?.cancel();
      const status = upstream.ok && !redirected ? "partial" : "upstream-error";
      emit(Promise.resolve(usageRecord(status, deps.now() - startedAt)));
      if (redirected) return gatewayError("volli_upstream_redirect", callId);
      if (rejectedKey) return gatewayError("volli_upstream_auth", callId);
      return new Response(null, {
        status: upstream.status,
        headers: relayedResponseHeaders(upstream.headers),
      });
    }

    const metered = meteredBody(upstream.body, upstream.headers.get("content-type") ?? "", meter, {
      startedAt,
      now: deps.now,
    });
    emit(
      metered.outcome.then(({ finished, ttftMs }) => {
        const status: GatewayUsageStatus = !upstream.ok
          ? "upstream-error"
          : finished && meter.complete
            ? "completed"
            : "partial";
        return usageRecord(status, deps.now() - startedAt, ttftMs);
      }),
    );
    const responseHeaders = relayedResponseHeaders(upstream.headers);
    responseHeaders.set(GATEWAY_CALL_ID_HEADER, callId);
    return new Response(metered.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  return {
    async fetch(request, env, ctx) {
      try {
        return await relay(request, env, ctx);
      } catch (error) {
        const callId = request.headers.get(GATEWAY_CALL_ID_HEADER);
        const echo = isUuid(callId) ? callId : undefined;
        if (error instanceof Refusal) return gatewayError(error.code, echo);
        console.error(
          `[volli-gateway] unexpected failure: ${error instanceof Error ? error.name : "unknown"}`,
        );
        return gatewayError("volli_gateway_misconfigured", echo);
      }
    },
    queue(batch, env) {
      return consumeUsage(batch, env, deps.fetch);
    },
  };
}

async function sendUsage(env: GatewayEnv, record: GatewayUsageRecord): Promise<void> {
  if (!env.USAGE_QUEUE) {
    console.error(`[volli-gateway] no usage queue bound; call ${record.callId} is unmetered`);
    return;
  }
  try {
    await env.USAGE_QUEUE.send(record);
  } catch (error) {
    console.error(
      `[volli-gateway] usage for call ${record.callId} not queued: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

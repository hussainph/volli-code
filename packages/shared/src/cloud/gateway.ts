/**
 * The Volli model gateway's wire vocabulary: the grant a runner presents, the
 * typed errors the gateway answers with, and the usage record it meters.
 *
 * The gateway relays model calls for backend-held connections only: uploaded
 * personal API keys, project and workspace keys, and OpenAI/Anthropic
 * compatible gateways. Subscriptions and keys kept on a person's own machine
 * never pass through it; they call the provider directly from the runner.
 *
 * Three parties share this file. The backend mints grants and ingests usage
 * records, the gateway (`apps/gateway`) verifies grants and writes records, and
 * the runner presents grants and maps errors onto its recovery classes. Each
 * reads the same constants, so none of them can drift from the others.
 *
 * A grant is an ES256 JWT from the Volli issuer with `aud` = {@link GATEWAY_AUDIENCE}.
 * Its signature and time claims are the verifier's job; {@link parseGatewayGrantClaims}
 * checks only the shape of what the signature covers.
 */
import { isUuid } from "./ids";

/** The `aud` every gateway grant carries, and the only one the gateway accepts. */
export const GATEWAY_AUDIENCE = "volli-gateway";

/** How long a grant lives. The runner refreshes at about two thirds of it. */
export const GATEWAY_GRANT_LIFETIME_SECONDS = 600;

/**
 * The per-call id a runner sends with every relayed request. The same id is on
 * the runner's own `usage.recorded` fact, which is how metered usage joins the
 * Session's attribution.
 */
export const GATEWAY_CALL_ID_HEADER = "x-volli-call-id";

/** Carries the `volli_*` code on every error the gateway itself produces. */
export const GATEWAY_ERROR_HEADER = "x-volli-error";

/**
 * A relayed request's path is this prefix, the connection id, then the
 * provider SDK's own path (`/v1/messages`, `/responses`, `/chat/completions`),
 * which is appended unchanged to the route's upstream base URL.
 */
export const GATEWAY_CONNECTION_PATH_PREFIX = "/v1/c/";

/**
 * The provider API families the gateway can relay and meter. The names match
 * Pi's `api` ids, so a runner can route a model by its own `model.api`.
 * OpenRouter and other OpenAI-compatible endpoints use `openai-completions`.
 */
export const GATEWAY_APIS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
] as const;

export type GatewayApi = (typeof GATEWAY_APIS)[number];

/** One connection a grant allows, keyed in the grant by Pi provider id. */
export interface GatewayGrantRoute {
  /** The connection's UUID: the second path segment after the prefix. */
  conn: string;
  /** Key version; a rotation issues `kv + 1`. Bound into the sealed key. */
  kv: number;
  /** Upstream base URL, https on a public host. */
  up: string;
  api: GatewayApi;
  /** The provider key sealed to the gateway. Only the gateway can open it. */
  sk: string;
  /** Non-secret extra headers the connection sends upstream (OpenRouter's attribution headers, say). */
  hdr?: Record<string, string>;
}

/** Who is acting: the runner, on behalf of the Session owner. */
export interface GatewayGrantActor {
  runner: string;
  user: string;
}

/** The claims of a gateway grant, after its signature has been verified. */
export interface GatewayGrantClaims {
  iss: string;
  aud: typeof GATEWAY_AUDIENCE;
  /** `session:<uuid>`: grants are per Session, never per runner. */
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  act: GatewayGrantActor;
  ws: string;
  prj?: string;
  routes: Record<string, GatewayGrantRoute>;
}

const SESSION_SUBJECT = /^session:([0-9a-f-]{36})$/;

/** The Session a grant was minted for, or `null` when `sub` is not a Session subject. */
export function gatewayGrantSessionId(sub: string): string | null {
  const match = SESSION_SUBJECT.exec(sub);
  return match && isUuid(match[1]) ? match[1] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatewayApi(value: unknown): value is GatewayApi {
  return (GATEWAY_APIS as readonly unknown[]).includes(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseRoute(value: unknown): GatewayGrantRoute | null {
  if (!isRecord(value)) return null;
  const { conn, kv, up, api, sk, hdr } = value;
  if (!isUuid(conn) || !Number.isSafeInteger(kv) || (kv as number) < 0) return null;
  if (typeof up !== "string" || typeof sk !== "string" || sk === "" || !isGatewayApi(api)) {
    return null;
  }
  if (hdr !== undefined && !isStringMap(hdr)) return null;
  return { conn, kv: kv as number, up, api, sk, ...(hdr === undefined ? {} : { hdr }) };
}

/**
 * The grant's claims when every field has the right shape, else `null`.
 * A grant with no routes is malformed: it could authorize nothing.
 */
export function parseGatewayGrantClaims(value: unknown): GatewayGrantClaims | null {
  if (!isRecord(value)) return null;
  const { iss, aud, sub, jti, iat, exp, act, ws, prj, routes } = value;
  if (typeof iss !== "string" || aud !== GATEWAY_AUDIENCE) return null;
  if (typeof sub !== "string" || gatewayGrantSessionId(sub) === null || !isUuid(jti)) return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  if (!isRecord(act) || !isUuid(act.runner) || !isUuid(act.user)) return null;
  if (!isUuid(ws) || (prj !== undefined && !isUuid(prj))) return null;
  if (!isRecord(routes)) return null;
  const parsed: Record<string, GatewayGrantRoute> = {};
  for (const [providerId, raw] of Object.entries(routes)) {
    const route = parseRoute(raw);
    if (!route) return null;
    parsed[providerId] = route;
  }
  if (Object.keys(parsed).length === 0) return null;
  return {
    iss,
    aud,
    sub,
    jti,
    iat: iat as number,
    exp: exp as number,
    act: { runner: act.runner, user: act.user },
    ws,
    ...(prj === undefined ? {} : { prj }),
    routes: parsed,
  };
}

/**
 * How a runner recovers from a gateway error, in AGENTS.md's classes:
 * - `transient`: retry with backoff, without duplicating accepted work;
 * - `refresh-grant`: fetch a fresh grant and retry the call once (the gateway
 *   rejected it before forwarding, so nothing was produced or billed);
 * - `auth` / `config` / `quota`: explicit user recovery, never retried.
 *
 * No class ever means "use another connection": another connection is another
 * payer, so switching is always the person's explicit choice.
 */
export type GatewayErrorRecovery = "transient" | "refresh-grant" | "auth" | "config" | "quota";

/** Every error the gateway produces itself, with its HTTP status and recovery class. */
export const GATEWAY_ERRORS = {
  /** The path is not `/v1/c/<connection>/…` (or a known gateway endpoint). */
  volli_route_not_found: { status: 404, recovery: "config" },
  volli_method_not_allowed: { status: 405, recovery: "config" },
  /** No grant in `authorization`, `x-api-key` or `x-goog-api-key`. */
  volli_grant_missing: { status: 401, recovery: "refresh-grant" },
  /** Malformed, wrongly signed, or for another issuer or audience. */
  volli_grant_invalid: { status: 401, recovery: "refresh-grant" },
  volli_grant_expired: { status: 401, recovery: "refresh-grant" },
  /** Sealed under a gateway key this deployment no longer holds. */
  volli_grant_stale: { status: 401, recovery: "refresh-grant" },
  /** The grant or its connection key version was revoked (kill switch). */
  volli_grant_revoked: { status: 403, recovery: "auth" },
  /** The grant does not name the connection in the path. */
  volli_route_not_granted: { status: 403, recovery: "auth" },
  /** The request has no valid {@link GATEWAY_CALL_ID_HEADER}. */
  volli_call_id_missing: { status: 400, recovery: "config" },
  volli_body_too_large: { status: 413, recovery: "config" },
  /** The route's upstream is not https on a public host. */
  volli_upstream_forbidden: { status: 400, recovery: "config" },
  /** The provider rejected the connection's key. Ask whoever owns the key to update it. */
  volli_upstream_auth: { status: 401, recovery: "config" },
  /** The provider answered with a redirect; the gateway never follows one. */
  volli_upstream_redirect: { status: 502, recovery: "transient" },
  volli_upstream_unreachable: { status: 502, recovery: "transient" },
  /** The gateway itself is misconfigured: no issuer keys, or none of its sealing keys open the grant. */
  volli_gateway_misconfigured: { status: 500, recovery: "transient" },
} as const satisfies Record<string, { status: number; recovery: GatewayErrorRecovery }>;

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

/** Token counts read from the provider's own usage report. Absent means it did not say. */
export interface GatewayUsageTokens {
  /** Uncached input tokens. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Already included in `output`; reported for display. */
  reasoning?: number;
  /** The provider's own cost figure, when it reports one (OpenRouter does). */
  upstreamCostUsd?: number;
}

/**
 * - `completed`: the provider's final usage report arrived;
 * - `partial`: the stream ended before it (client disconnect, upstream drop),
 *   so the counts are whatever had been reported by then;
 * - `upstream-error`: the provider answered with an error status.
 */
export const GATEWAY_USAGE_STATUSES = ["completed", "partial", "upstream-error"] as const;

export type GatewayUsageStatus = (typeof GATEWAY_USAGE_STATUSES)[number];

/**
 * One relayed call, metered by the gateway. The backend ingests these
 * idempotently on `callId`. Only metadata: never a prompt, a response or a key.
 */
export interface GatewayUsageRecord {
  callId: string;
  grantJti: string;
  workspaceId: string;
  projectId?: string;
  /** The Session owner, on whose behalf the runner acted. */
  userId: string;
  sessionId: string;
  runnerId: string;
  connectionId: string;
  keyVersion: number;
  /** The grant's route key: Pi's provider id. */
  providerId: string;
  api: GatewayApi;
  /** The model the provider says answered, else the requested one. */
  modelId?: string;
  usage: GatewayUsageTokens;
  status: GatewayUsageStatus;
  upstreamStatus: number;
  /** Epoch milliseconds when the gateway started the upstream request. */
  startedAt: number;
  /** Start to the first response body byte. */
  ttftMs?: number;
  durationMs: number;
}

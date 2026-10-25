/**
 * Verifies a gateway grant: an ES256 JWS from the Volli issuer, checked
 * offline against the issuer's JWKS. Convex is not on the request path; a
 * Convex outage only stops new grants, and grants already issued keep working
 * until they expire.
 *
 * The grant is checked once, when a request starts. A stream that started
 * with a valid grant runs to completion however long it takes.
 */
import {
  GATEWAY_GRANT_LIFETIME_SECONDS,
  type GatewayErrorCode,
  type GatewayGrantClaims,
  parseGatewayGrantClaims,
} from "@volli/shared/cloud";

import { fromBase64Url, utf8 } from "./bytes.ts";
import type { FetchFn, WaitUntil } from "./env.ts";

/** Clock skew tolerated on `exp` and `iat`, either way. */
export const CLOCK_SKEW_SECONDS = 60;

/** How long a fetched JWKS is trusted before it is fetched again. */
export const JWKS_TTL_MS = 10 * 60_000;

/** The shortest gap between two fetches prompted by an unknown `kid`. */
export const JWKS_REFETCH_INTERVAL_MS = 30_000;

/** How long a JWKS fetch may take before it is abandoned. */
export const JWKS_FETCH_TIMEOUT_MS = 5_000;

/** A grant may not claim to live longer than this, whatever the issuer signed. */
const MAX_LIFETIME_SECONDS = 2 * GATEWAY_GRANT_LIFETIME_SECONDS;

export type KeyLookup = { ok: true; key: CryptoKey } | { ok: false; code: GatewayErrorCode };

interface Jwk {
  kty?: unknown;
  crv?: unknown;
  kid?: unknown;
  x?: unknown;
  y?: unknown;
}

async function importJwks(jwks: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  const entries = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) throw new Error("JWKS has no keys array");
  for (const entry of entries as Jwk[]) {
    if (entry?.kty !== "EC" || entry.crv !== "P-256" || typeof entry.kid !== "string") continue;
    if (typeof entry.x !== "string" || typeof entry.y !== "string") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: entry.x, y: entry.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    keys.set(entry.kid, key);
  }
  return keys;
}

/**
 * The issuer's verification keys by `kid`. Either inline (a JWKS JSON string,
 * for local development and tests) or fetched from the issuer's JWKS URL and
 * cached.
 *
 * Requests are never held up by a routine refresh: once keys are held, an
 * expired cache is refreshed in the background (through the request's
 * `waitUntil`) while the held keys keep answering. A request waits on a fetch
 * only when no keys are held yet, or for an unknown `kid` (at a bounded rate),
 * so a signing-key rotation is picked up without a deploy. No request ever
 * awaits a fetch another request started: on workerd, I/O belongs to the
 * request that began it.
 */
export class IssuerKeys {
  private keys: Map<string, CryptoKey> | null = null;
  /** When the held keys were fetched. */
  private fetchedAt = Number.NEGATIVE_INFINITY;
  /** When a fetch was last started or finished, successful or not. */
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private readonly source: { inline: string } | { url: string };
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  constructor(source: { inline: string } | { url: string }, fetchFn: FetchFn, now: () => number) {
    this.source = source;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  async lookup(kid: string, ctx: WaitUntil): Promise<KeyLookup> {
    const mayFetch = this.now() - this.attemptedAt >= JWKS_REFETCH_INTERVAL_MS;
    if (!this.keys) {
      if (mayFetch) await this.load();
    } else if (mayFetch && this.now() - this.fetchedAt >= JWKS_TTL_MS) {
      ctx.waitUntil(this.load());
    }
    let key = this.keys?.get(kid);
    if (
      !key &&
      this.keys &&
      "url" in this.source &&
      this.now() - this.attemptedAt >= JWKS_REFETCH_INTERVAL_MS
    ) {
      await this.load();
      key = this.keys?.get(kid);
    }
    if (key) return { ok: true, key };
    // No keys at all is the gateway's fault; an unknown kid is the grant's.
    return {
      ok: false,
      code: this.keys?.size ? "volli_grant_invalid" : "volli_gateway_misconfigured",
    };
  }

  private async load(): Promise<void> {
    this.attemptedAt = this.now();
    try {
      const keys = await this.fetchKeys();
      this.keys = keys;
      this.fetchedAt = this.now();
    } catch (error) {
      // Keep serving keys already held; try again after the refetch interval.
      console.error(`[volli-gateway] issuer JWKS unavailable: ${String(error)}`);
    }
    this.attemptedAt = this.now();
  }

  private async fetchKeys(): Promise<Map<string, CryptoKey>> {
    if ("inline" in this.source) return importJwks(JSON.parse(this.source.inline));
    const response = await this.fetchFn(this.source.url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
    return importJwks(await response.json());
  }
}

export type GrantVerification =
  | { ok: true; claims: GatewayGrantClaims }
  | { ok: false; code: GatewayErrorCode };

function decodeJson(segment: string): unknown {
  const bytes = fromBase64Url(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Verifies `token` as a grant from `issuer`. The signature is checked before
 * any claim is believed; `nowMs` is the gateway's clock.
 */
export async function verifyGrant(
  token: string,
  options: { issuer: string; keys: IssuerKeys; nowMs: number; waitUntil: WaitUntil },
): Promise<GrantVerification> {
  const invalid = { ok: false, code: "volli_grant_invalid" } as const;
  const parts = token.split(".");
  if (parts.length !== 3) return invalid;
  const [headerText, payloadText, signatureText] = parts as [string, string, string];
  const header = decodeJson(headerText) as { alg?: unknown; kid?: unknown; crit?: unknown } | null;
  if (header?.alg !== "ES256" || typeof header.kid !== "string" || header.crit !== undefined)
    return invalid;
  const signature = fromBase64Url(signatureText);
  if (signature?.length !== 64) return invalid;

  const lookup = await options.keys.lookup(header.kid, options.waitUntil);
  if (!lookup.ok) return lookup;
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    lookup.key,
    signature,
    utf8(`${headerText}.${payloadText}`),
  );
  if (!verified) return invalid;

  const claims = parseGatewayGrantClaims(decodeJson(payloadText));
  if (!claims || claims.iss !== options.issuer) return invalid;
  const now = Math.floor(options.nowMs / 1000);
  const lifetime = claims.exp - claims.iat;
  if (claims.iat > now + CLOCK_SKEW_SECONDS || lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS)
    return invalid;
  if (now - CLOCK_SKEW_SECONDS >= claims.exp) return { ok: false, code: "volli_grant_expired" };
  return { ok: true, claims };
}

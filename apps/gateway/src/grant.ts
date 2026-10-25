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

/** Clock skew tolerated on `exp` and `iat`, either way. */
export const CLOCK_SKEW_SECONDS = 60;

/** How long a fetched JWKS is trusted before it is fetched again. */
export const JWKS_TTL_MS = 10 * 60_000;

/** The shortest gap between two fetches prompted by an unknown `kid`. */
export const JWKS_REFETCH_INTERVAL_MS = 30_000;

/** A grant may not claim to live longer than this, whatever the issuer signed. */
const MAX_LIFETIME_SECONDS = 2 * GATEWAY_GRANT_LIFETIME_SECONDS;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

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
 * cached, refetched on expiry and, at a bounded rate, on an unknown `kid` so a
 * signing key rotation is picked up without a deploy.
 */
export class IssuerKeys {
  private keys: Map<string, CryptoKey> | null = null;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | null = null;
  private readonly source: { inline: string } | { url: string };
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  constructor(source: { inline: string } | { url: string }, fetchFn: FetchFn, now: () => number) {
    this.source = source;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  async lookup(kid: string): Promise<KeyLookup> {
    if (this.now() - this.fetchedAt >= JWKS_TTL_MS) await this.load();
    let key = this.keys?.get(kid);
    if (!key && "url" in this.source && this.now() - this.fetchedAt >= JWKS_REFETCH_INTERVAL_MS) {
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

  private load(): Promise<void> {
    this.loading ??= this.fetchKeys()
      .then(
        (keys) => {
          this.keys = keys;
          this.fetchedAt = this.now();
        },
        (error: unknown) => {
          // Keep serving keys already held; try again after the refetch interval.
          console.error(`[volli-gateway] issuer JWKS unavailable: ${String(error)}`);
          this.fetchedAt = this.now() - JWKS_TTL_MS + JWKS_REFETCH_INTERVAL_MS;
        },
      )
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async fetchKeys(): Promise<Map<string, CryptoKey>> {
    if ("inline" in this.source) return importJwks(JSON.parse(this.source.inline));
    const response = await this.fetchFn(this.source.url, {
      headers: { accept: "application/json" },
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
  options: { issuer: string; keys: IssuerKeys; nowMs: number },
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

  const lookup = await options.keys.lookup(header.kid);
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
  if (claims.iat > now + CLOCK_SKEW_SECONDS || claims.exp - claims.iat > MAX_LIFETIME_SECONDS)
    return invalid;
  if (now - CLOCK_SKEW_SECONDS >= claims.exp) return { ok: false, code: "volli_grant_expired" };
  return { ok: true, claims };
}

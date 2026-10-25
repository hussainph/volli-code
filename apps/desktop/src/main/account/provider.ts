/**
 * The sign-in provider seam: an OAuth 2.0 authorization-code flow with PKCE
 * for a public client (no secret ships in the app), as desktop main drives
 * it. Two adapters implement it: WorkOS AuthKit (`./workos`) and the local
 * dev issuer (`./dev-issuer`). The account service (`./service`) owns the
 * flow around them: the loopback callback, `state`, the sealed refresh
 * token, refresh and sign-out.
 */
import type { AccountConnection, AccountProviderKind } from "@volli/shared";

import { jwtExpiry, readJwtClaims } from "./jwt";

export interface AuthorizationRequest {
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  /** Which upstream identity provider the button named: skip the provider's chooser. */
  readonly connection: AccountConnection;
}

/** What a sign-in or a refresh answers. */
export interface ProviderTokens {
  /** A JWT the backend verifies; held in main's memory only. */
  readonly accessToken: string;
  /** Sealed at rest; rotated by every refresh. */
  readonly refreshToken: string;
  /** Milliseconds since the epoch. */
  readonly accessExpiresAt: number;
  /** The provider's session id (WorkOS `sid`), to end it at sign-out; `null` when it names none. */
  readonly sessionId: string | null;
  /** Best effort, for the window until the backend answers. */
  readonly profile: { readonly displayName: string | null; readonly email: string | null };
}

export interface AccountProvider {
  readonly kind: AccountProviderKind;
  /** Where the browser goes to sign in. */
  authorizationUrl(request: AuthorizationRequest): Promise<string>;
  /** Trades the callback's code for tokens, proving the PKCE verifier. */
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderTokens>;
  /** Trades a refresh token for new tokens (and a new refresh token). */
  refresh(refreshToken: string): Promise<ProviderTokens>;
  /** A page that ends the provider's browser session, or `null` when it keeps none. */
  logoutUrl(sessionId: string): string | null;
  /** Releases what the adapter holds (the dev issuer's listener). */
  dispose?(): void;
}

/**
 * The provider refused the grant (a used, revoked or expired code or refresh
 * token): the saved sign-in is dead and the person must sign in again. Any
 * other failure (offline, a 5xx) is transient and keeps the sign-in.
 */
export class ProviderRefusedError extends Error {
  readonly code = "provider-refused";
  constructor(message: string) {
    super(message);
    this.name = "ProviderRefusedError";
  }
}

export function isProviderRefused(error: unknown): error is ProviderRefusedError {
  return error instanceof ProviderRefusedError;
}

/** How long an access token lasts when it names no `exp` and the answer no `expires_in`. */
const FALLBACK_ACCESS_TTL_MS = 5 * 60 * 1000;

/** Reads the fields every adapter's token answer shares. */
export function tokensFrom(
  body: Record<string, unknown>,
  now: number,
  profile: ProviderTokens["profile"] = { displayName: null, email: null },
): ProviderTokens {
  const accessToken = body["access_token"];
  const refreshToken = body["refresh_token"];
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error("The sign-in provider answered without an access token.");
  }
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new Error("The sign-in provider answered without a refresh token.");
  }
  const expiresIn = body["expires_in"];
  const claims = readJwtClaims(accessToken);
  const sid = claims?.["sid"];
  const claimName = claims?.["name"];
  const claimEmail = claims?.["email"];
  return {
    accessToken,
    refreshToken,
    accessExpiresAt:
      jwtExpiry(accessToken) ??
      (typeof expiresIn === "number" && expiresIn > 0
        ? now + expiresIn * 1000
        : now + FALLBACK_ACCESS_TTL_MS),
    sessionId: typeof sid === "string" && sid !== "" ? sid : null,
    profile: {
      displayName: profile.displayName ?? (typeof claimName === "string" ? claimName : null),
      email: profile.email ?? (typeof claimEmail === "string" ? claimEmail : null),
    },
  };
}

/**
 * Posts a token request and reads its JSON answer. A 400 or 401 is the
 * provider refusing the grant ({@link ProviderRefusedError}); anything else
 * that is not a 2xx is transient.
 */
export async function postTokenRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: { body: string; contentType: string },
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": init.contentType, accept: "application/json" },
    body: init.body,
    signal: AbortSignal.timeout(30_000),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (response.status === 400 || response.status === 401) {
    const described = record["error_description"] ?? record["message"] ?? record["error"];
    throw new ProviderRefusedError(
      typeof described === "string" && described !== ""
        ? `The sign-in provider refused: ${described.slice(0, 200)}`
        : "The sign-in provider refused the sign-in.",
    );
  }
  if (!response.ok) {
    throw new Error(`The sign-in provider answered ${response.status}.`);
  }
  return record;
}

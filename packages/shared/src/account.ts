/**
 * The Volli Cloud account as the desktop window sees it (VC-884): the wire
 * types of the desktop-only `account.*` entries (`./desktop-entries`).
 *
 * Desktop main owns the sign-in: the browser flow, the sealed refresh token
 * and the in-memory access token. The window gets this snapshot and nothing
 * else: no token, no provider subject, never a secret. It exists only with
 * the `cloud` experiment on; with it off every `account.*` entry answers
 * unavailable.
 */

/** The sign-in buttons: one per upstream identity provider. */
export const ACCOUNT_CONNECTIONS = ["github", "google"] as const;
export type AccountConnection = (typeof ACCOUNT_CONNECTIONS)[number];

/**
 * Which sign-in provider this build talks to: WorkOS AuthKit, or the local
 * dev issuer an unpackaged build may run against the Convex fixture.
 */
export const ACCOUNT_PROVIDERS = ["workos", "dev"] as const;
export type AccountProviderKind = (typeof ACCOUNT_PROVIDERS)[number];

/**
 * Where the account stands on this Mac.
 *
 * - `unconfigured`: this build names no sign-in provider.
 * - `signed-out`: no account; `failure` says why the last attempt ended, if it failed.
 * - `restoring`: a saved sign-in is being read and refreshed.
 * - `signing-in`: the browser is open on the provider's page.
 * - `signed-in`: an account, with what the backend said about it.
 */
export const ACCOUNT_STATES = [
  "unconfigured",
  "signed-out",
  "restoring",
  "signing-in",
  "signed-in",
] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/**
 * Whether the backend has the account. `synced`: it answered for this
 * sign-in. `unreachable`: the last call failed in transit (offline); the
 * sign-in is kept. `refused`: the backend did not accept this sign-in (a
 * configuration or sign-in problem: signing out and in again is the
 * recovery). `none`: this build names no backend.
 */
export const ACCOUNT_BACKEND_STATES = ["synced", "unreachable", "refused", "none"] as const;
export type AccountBackendState = (typeof ACCOUNT_BACKEND_STATES)[number];

/** The signed-in person: profile only, never a token or a provider subject. */
export interface AccountSummary {
  readonly displayName: string;
  readonly email: string | null;
  /** The person's Volli user id, once the backend has answered. */
  readonly userId: string | null;
  /** When a pending deletion is purged; `null` for an account not being deleted. */
  readonly deletionPurgeAfter: number | null;
  readonly backend: AccountBackendState;
}

export interface AccountSnapshot {
  readonly state: AccountState;
  /** `null` exactly when `unconfigured`. */
  readonly provider: AccountProviderKind | null;
  /** The button in flight while `signing-in`; otherwise `null`. */
  readonly signingInWith: AccountConnection | null;
  /** Exactly when `signed-in`. */
  readonly account: AccountSummary | null;
  /** One sentence about the last thing that failed, for the window to show; `null` when nothing did. */
  readonly failure: string | null;
}

/** Bounds the router validates every snapshot against. */
export const ACCOUNT_TEXT_MAX = 512;

export function isAccountConnection(value: unknown): value is AccountConnection {
  return typeof value === "string" && (ACCOUNT_CONNECTIONS as readonly string[]).includes(value);
}

/** The snapshot a build with no provider answers. */
export const UNCONFIGURED_ACCOUNT: AccountSnapshot = Object.freeze({
  state: "unconfigured",
  provider: null,
  signingInWith: null,
  account: null,
  failure: null,
});

/**
 * A short-lived access token for the window's own Volli Cloud client
 * (`account.accessToken`, VC-889). The window's Convex client asks for one
 * whenever it connects or its token is about to expire; main answers from its
 * in-memory token, refreshing first when it must. The refresh token never
 * leaves main.
 *
 * - `token`: a current access JWT and when it expires (epoch ms).
 * - `signed-out`: there is no sign-in to answer for (also with `cloud` off, or
 *   a build with no sign-in configured). The client clears its auth.
 * - `unavailable`: a transient failure (offline, or a refresh that failed in
 *   transit). The sign-in is kept; ask again after `retryAfterMs`. Never a
 *   reason to clear auth: that would blank a board the window can still show.
 */
export type AccountAccessToken =
  | { readonly kind: "token"; readonly token: string; readonly expiresAt: number }
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable"; readonly retryAfterMs: number };

/** How long `unavailable` asks the window to wait before asking again. */
export const ACCOUNT_TOKEN_RETRY_MS = 5_000;

/** Bound on a token the router passes through: a JWT, never anything bigger. */
export const ACCOUNT_TOKEN_MAX = 16_384;

/**
 * Which product store this launch of the app uses (`cloud.launch`, VC-889),
 * chosen once by main before the window opens and fixed for the life of the
 * process: `local` is this Mac's own database, exactly as without Volli
 * Cloud; `cloud` is the signed-in person's Workspaces on the backend at
 * `backendUrl`. Signing in or out relaunches the app into the other one.
 * Never a secret: a user id and a URL.
 */
export type CloudLaunch =
  | { readonly store: "local" }
  | { readonly store: "cloud"; readonly userId: string; readonly backendUrl: string };

/** The launch every flag-off, signed-out or unconfigured app makes. */
export const LOCAL_LAUNCH: CloudLaunch = Object.freeze({ store: "local" });

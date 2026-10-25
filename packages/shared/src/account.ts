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

/**
 * Sign-ins on a host, as a Client may see them over the host protocol (VC-702;
 * HP § Sign-ins on a host).
 *
 * Owner decision 2 (2026-10-07), per sign-in:
 *
 * - **API keys and git push credentials are sent from a Client.** They travel
 *   once, write-only, over the authenticated host link, and the host keeps them
 *   through its key-provider port. No read path ever returns one.
 * - **Subscription logins sign in on the host.** The flow runs where the
 *   credential will live; the person approves in their own browser, by device
 *   code or through the auth-callback relay, and the refresh token never
 *   leaves the host. Copying an OAuth login between machines would share one
 *   refresh token, and a provider that rotates refresh tokens signs one of
 *   them out.
 *
 * **Nothing here carries a credential.** A status names availability; an
 * update names what a flow is doing. Values travel Client → host only, as
 * the bare input of `signIns.setApiKey`, `signIns.setGitCredential` and
 * `signIns.answer`.
 */
import type {
  ModelAccessSignInEvent,
  ModelAccessSignInMethod,
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
} from "./model-access-sign-in";

/** Where a sign-in row stands on this host. */
export type HostSignInState = "signed-in" | "expired" | "missing";

/**
 * What kind of sign-in a row holds: a key sent from a Client, a subscription
 * login made on the host, or a git push credential. `null` when the row holds
 * nothing this host can name (missing, or an ambient environment key).
 */
export type HostSignInKind = "api-key" | "subscription" | "git";

/** One model provider's sign-in on this host. Never a value. */
export interface HostProviderSignIn {
  providerId: string;
  label: string;
  state: HostSignInState;
  kind: Exclude<HostSignInKind, "git"> | null;
  /** The ways this provider can be signed in to, in the provider's own words. */
  methods: readonly ModelAccessSignInMethod[];
}

/** One git remote host's push credential on this host. Never the value or the username. */
export interface HostGitSignIn {
  /** The remote's host name, lowercase, with a port when it has one: `github.com`. */
  host: string;
  state: HostSignInState;
  kind: "git";
}

/**
 * `signIns.status`: every provider this host can sign in to, and every git
 * host it holds a push credential for. A git host that is not listed is
 * missing.
 */
export interface HostSignInStatus {
  providers: readonly HostProviderSignIn[];
  git: readonly HostGitSignIn[];
}

/** `signIns.setApiKey`'s input: the one write-only path a model key takes in. */
export interface HostSetApiKeyInput {
  providerId: string;
  key: string;
}

/** `signIns.setGitCredential`'s input: a push token for one remote host. */
export interface HostSetGitCredentialInput {
  host: string;
  /** What git sends as the user: `x-access-token` for a GitHub token. */
  username: string;
  password: string;
}

/** `signIns.start`'s input. `type` defaults to a subscription login (`oauth`). */
export interface HostSignInStartInput {
  providerId: string;
  type?: ModelAccessSignInType;
}

/** A flow the asking connection started; every later call names it. */
export interface HostSignInFlow {
  flowId: string;
}

/**
 * `auth-callback`: the relay grant (HP § Auth-callback relay). The Client binds
 * `redirectUri`'s loopback host and port for one request on its path, and
 * sends what arrived with `auth.callback.deliver`. Sent only to a connection
 * granted `auth.callback`, and before the `auth-url` it belongs to, so the
 * Client is listening before the browser can redirect.
 */
export interface HostAuthCallbackUpdate {
  kind: "auth-callback";
  flowId: string;
  redirectUri: string;
}

/**
 * Everything a flow reports, in order, on `signIns.subscribe`. The stream ends
 * after its one terminal update: `done`, `failed` or `cancelled`.
 *
 * An open union on `kind`: a Client ignores a kind it does not know, and a
 * terminal update is still the end of the stream.
 */
export type HostSignInUpdate =
  | Extract<ModelAccessSignInEvent, { kind: "auth-url" }>
  | Extract<ModelAccessSignInEvent, { kind: "device-code" }>
  | Extract<ModelAccessSignInEvent, { kind: "info" }>
  | Extract<ModelAccessSignInEvent, { kind: "progress" }>
  | HostAuthCallbackUpdate
  | { kind: "prompt"; prompt: ModelAccessSignInPrompt }
  | { kind: "prompt-withdrawn"; promptId: string }
  | { kind: "done" }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

/** `signIns.answer`'s input: the paste fallback, or any other step's answer. */
export interface HostSignInAnswerInput {
  flowId: string;
  promptId: string;
  value: string;
}

/** `auth.callback.deliver`'s input: what the Client's one-request listener received. */
export interface HostAuthCallbackDeliverInput {
  flowId: string;
  /** The request target, `/callback?code=…&state=…`: a path and query, no scheme or host. */
  pathAndQuery: string;
}

/** What the host's own listener answered the replayed request with. */
export interface HostAuthCallbackDeliverResult {
  status: number;
}

/** Whether an update ends its flow's stream. */
export function hostSignInUpdateIsFinal(update: { kind: string }): boolean {
  return update.kind === "done" || update.kind === "failed" || update.kind === "cancelled";
}

/**
 * An expired sign-in, as the host-connection store's `HostRecord.expiredSignIns`
 * carries it (VC-576's `HostSignIn`): the provider and the name a person
 * reads ("Claude").
 */
export interface ExpiredHostSignIn {
  readonly providerId: string;
  readonly name: string;
}

/**
 * The rows a host-chip badge reads (VC-576): a sign-in this host held that no
 * longer authenticates, in `HostRecord.expiredSignIns`'s shape. A Session on
 * it that tried says so itself, as its `auth_required` Attention; this is the
 * host's half.
 */
export function expiredHostSignIns(status: HostSignInStatus): readonly ExpiredHostSignIn[] {
  return status.providers
    .filter((provider) => provider.state === "expired")
    .map((provider) => ({ providerId: provider.providerId, name: provider.label }));
}

/**
 * A git remote host as the push-credential store keys it: lowercase, an
 * optional port, and nothing else (no scheme, user, path or wildcard).
 * Answers null for anything else.
 */
export function normalizeGitHost(value: string): string | null {
  const host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/u.test(
    host,
  )
    ? host
    : null;
}

/**
 * Why a sign-in operation was refused, as the host protocol names it. Branded
 * so the router maps it to its reason without importing host-core (the
 * `CommandIntentConflict` pattern).
 *
 * - `sign-in-unknown`: no such flow on this connection. A flow another
 *   connection owns answers exactly as an absent one, so one device can
 *   neither drive nor discover another's.
 * - `sign-in-conflict`: the flow is not in a state to take this: the provider
 *   is already signing in, the step is no longer waiting, or the callback
 *   grant is spent or was never issued.
 * - `sign-in-unsupported`: this host cannot sign in that way: an unknown
 *   provider, a method it does not offer, a git host it cannot key.
 */
export type SignInRefusalReason = "sign-in-unknown" | "sign-in-conflict" | "sign-in-unsupported";

const SIGN_IN_REFUSED: unique symbol = Symbol.for("volli.sign-in-refused");

export class SignInRefusedError extends Error {
  readonly [SIGN_IN_REFUSED] = true as const;
  readonly reason: SignInRefusalReason;

  constructor(reason: SignInRefusalReason, message: string) {
    super(message);
    this.name = "SignInRefusedError";
    this.reason = reason;
  }
}

export function isSignInRefused(value: unknown): value is SignInRefusedError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<SignInRefusedError>)[SIGN_IN_REFUSED] === true
  );
}

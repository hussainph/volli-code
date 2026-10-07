/**
 * Sign-ins on a host, as its rows read them (VC-702; VC-615 flow 4, owner
 * decision 2: per sign-in). Pure: what a row says and offers, from the host's
 * status and what this Mac holds. The controller (`host-sign-in-controller.ts`)
 * owns what changes; the rows (`host-sign-in-rows.tsx`) only draw it.
 *
 * - **Subscriptions sign in on the host.** The flow runs there; the person
 *   approves in this Mac's browser by device code or through the relay, and
 *   the row turns signed-in by itself. A subscription is never sent.
 * - **API keys are sent from this Mac** when it holds one, after the one-line
 *   confirm "<host> keeps a copy of what this Mac sends", or pasted.
 * - **Git push credentials are pasted** for now. Reading this Mac's git
 *   credential means asking its credential helper, which is the keychain on
 *   a stock Mac; that needs its own consent surface.
 *
 * Words: the host's own name and "This Mac", never Workspace or venue.
 */
import {
  expiredHostSignIns,
  type HostProviderSignIn,
  type HostSignInRelayState,
  type HostSignInRunEvent,
  type HostSignInState,
  type HostSignInStatus,
  type ModelAccessSignInPrompt as HostSignInPrompt,
} from "@volli/shared";

/** Where a row's sign-in comes from: this Mac sends it, or the host signs in itself. */
export type SignInSource = "mac" | "host";

/**
 * A host's expired sign-in, as the host-connection store's `HostRecord`
 * carries it (VC-576, `stores/host-connection.ts`: `HostSignIn`).
 */
export type { ExpiredHostSignIn } from "@volli/shared";

/** One row: a provider this host can sign in to, or a git host it can hold a push credential for. */
export interface SignInRowView {
  /** `provider:<id>` or `git:<host>`: unique across a host's rows. */
  readonly key: string;
  readonly kind: "provider" | "git";
  readonly id: string;
  readonly label: string;
  readonly state: HostSignInState;
  /** What the host holds now: a key, a subscription login, a push credential, or nothing. */
  readonly held: "api-key" | "subscription" | "git" | null;
  /** The host can run this provider's subscription login. */
  readonly subscription: boolean;
  /** The host takes an API key for this provider. */
  readonly takesKey: boolean;
  /** This Mac holds a key for this provider it could send. */
  readonly macHasKey: boolean;
  /** Which way the row offers first. */
  readonly source: SignInSource;
}

/** What a row is doing right now, beyond what the host holds. */
export type RowFlow =
  | { readonly kind: "idle" }
  /** The confirm before this Mac's key is sent. */
  | { readonly kind: "confirm-send" }
  | { readonly kind: "sending" }
  /** Pasting a key (or a push token) to store on the host. */
  | { readonly kind: "key-entry" }
  | { readonly kind: "saving" }
  | {
      readonly kind: "signing-in";
      readonly deviceCode: { readonly userCode: string; readonly verificationUri: string } | null;
      /** The authorization page, once the host asked for it to be opened. */
      readonly authUrl: string | null;
      /** The step the flow waits on, if any: a paste, a choice, a value. */
      readonly prompt: HostSignInPrompt | null;
      readonly relay: HostSignInRelayState | null;
      readonly progress: string | null;
    }
  | { readonly kind: "failed"; readonly message: string };

export const IDLE: RowFlow = Object.freeze({ kind: "idle" });

const SIGNING_IN: Extract<RowFlow, { kind: "signing-in" }> = Object.freeze({
  kind: "signing-in",
  deviceCode: null,
  authUrl: null,
  prompt: null,
  relay: null,
  progress: null,
});

/** A row key for a provider. */
export function providerRowKey(providerId: string): string {
  return `provider:${providerId}`;
}

/** A row key for a git host. */
export function gitRowKey(host: string): string {
  return `git:${host}`;
}

/**
 * The rows for one host, providers first in the host's order, then git hosts.
 * `macKeys` is the provider ids this Mac holds a key for: availability, never
 * a value. GitHub is always offered; `gitHosts` are normalized hosts the
 * person added on this surface. What the host holds takes precedence.
 */
export function signInRowsOf(
  status: HostSignInStatus,
  macKeys: ReadonlySet<string>,
  gitHosts: readonly string[] = [],
): readonly SignInRowView[] {
  const providers = status.providers.map((provider) => providerRow(provider, macKeys));
  const git = status.git.map((row) => gitRow(row.host, row.state, "git"));
  const held = new Set(status.git.map((row) => row.host));
  const missing = [...new Set(["github.com", ...gitHosts])]
    .filter((host) => !held.has(host))
    .map((host) => gitRow(host, "missing", null));
  return [...providers, ...git, ...missing];
}

function gitRow(host: string, state: HostSignInState, held: "git" | null): SignInRowView {
  return {
    key: gitRowKey(host),
    kind: "git",
    id: host,
    label: host,
    state,
    held,
    subscription: false,
    takesKey: true,
    macHasKey: false,
    source: "host",
  };
}

function providerRow(provider: HostProviderSignIn, macKeys: ReadonlySet<string>): SignInRowView {
  const subscription = provider.methods.some(
    (method) => method.type === "oauth" && method.isSubscription,
  );
  const takesKey = provider.methods.some((method) => method.type === "api-key");
  const macHasKey = takesKey && macKeys.has(provider.providerId);
  return {
    key: providerRowKey(provider.providerId),
    kind: "provider",
    id: provider.providerId,
    label: provider.label,
    state: provider.state,
    held: provider.kind,
    subscription,
    takesKey,
    macHasKey,
    // Subscriptions sign in on the host: a copied OAuth login would share one
    // refresh token between two machines. A key costs nothing to copy.
    source: subscription && provider.kind !== "api-key" ? "host" : macHasKey ? "mac" : "host",
  };
}

/** The host chip's badge: the sign-ins this host held that no longer authenticate. */
export const expiredSignInsOf = expiredHostSignIns;

/** The one sentence on the surface: the trust boundary, true for what is on screen. */
export function trustLine(hostName: string, sendsFromMac: boolean): string {
  return sendsFromMac
    ? `${hostName} keeps a copy of what this Mac sends.`
    : "Nothing is copied from this Mac.";
}

/** A row's second line. */
export function statusLine(row: SignInRowView, flow: RowFlow, hostName: string): string {
  switch (flow.kind) {
    case "confirm-send":
    case "sending":
      return "Sending from this Mac";
    case "key-entry":
      return `Stored only on ${hostName}`;
    case "saving":
      return `Saving on ${hostName}`;
    case "failed":
      return flow.message;
    case "signing-in":
      if (flow.relay === "paste" || flow.relay === "failed") {
        return "Paste the address your browser ends on";
      }
      if (flow.deviceCode !== null) return "Enter the code on the provider's page";
      if (flow.authUrl !== null) return "Waiting for your browser";
      return flow.progress ?? `Signing in on ${hostName}`;
    case "idle":
      break;
  }
  switch (row.state) {
    case "expired":
      return `Expired on ${hostName}`;
    case "missing":
      return "Not signed in";
    case "signed-in":
      return `Signed in on ${hostName}${heldLabel(row.held)}`;
  }
}

function heldLabel(held: SignInRowView["held"]): string {
  switch (held) {
    case "api-key":
      return " · API key";
    case "subscription":
      return " · subscription";
    case "git":
      return " · push access";
    case null:
      return "";
  }
}

/** Folds one event from a host sign-in into its row. */
export function reduceSignIn(flow: RowFlow, event: HostSignInRunEvent): RowFlow {
  const current = flow.kind === "signing-in" ? flow : SIGNING_IN;
  switch (event.kind) {
    case "device-code":
      return {
        ...current,
        deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri },
      };
    case "auth-url":
      return { ...current, authUrl: event.url };
    case "prompt":
      return { ...current, prompt: event.prompt };
    case "prompt-withdrawn":
      return current.prompt?.promptId === event.promptId ? { ...current, prompt: null } : current;
    case "relay":
      return { ...current, relay: event.state };
    case "progress":
    case "info":
      return { ...current, progress: event.message };
    case "done":
    case "cancelled":
      return IDLE;
    case "failed":
      return { kind: "failed", message: failureLine(event.message) };
    case "lost":
      return { kind: "failed", message: "The host went away before the sign-in finished" };
  }
}

/** A provider's failure, bounded: the host already sanitized and redacted it. */
function failureLine(message: string): string {
  const line = message.trim().replace(/\n[\s\S]*$/u, "");
  return line.length === 0 ? "The sign-in did not finish" : line;
}

/** Whether a paste field belongs on the row: the flow waits on a pasted code or a redirect. */
export function wantsPaste(flow: RowFlow): boolean {
  return flow.kind === "signing-in" && flow.prompt?.kind === "manual-code";
}

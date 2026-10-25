/**
 * The Volli GitHub App's backend-independent half: the HTTP paths Convex
 * serves for GitHub, the vocabularies its tables store, the error codes its
 * functions answer, and the pure decisions both the backend and a client run.
 *
 * - **Flows.** Connecting GitHub and installing the App each start a
 *   `githubFlows` row; the browser comes back to Convex with
 *   `state = <flowId>.<secret>` ({@link formatFlowState}), and the client
 *   learns the outcome from its own flow row.
 * - **Webhooks.** {@link extractGithubEvent} turns a delivery into the few
 *   fields the backend acts on, or `ignored`. Unknown events and actions are
 *   tolerated (recorded, not applied), so GitHub adding one never fails a
 *   delivery. Installation and repository events are nudges: the backend
 *   reads the current state from the API afterwards, so delivery order does
 *   not matter.
 * - **Tokens.** A person's user access token is used until
 *   {@link githubTokenUseUntil}, then refreshed once under a lease
 *   ({@link decideGithubMint}).
 *
 * Nothing here holds or names a credential.
 */

/** The routes on the Convex site (`<deployment>.convex.site`) the App is registered with. */
export const GITHUB_HTTP_PATHS = {
  oauthCallback: "/github/oauth/callback",
  setup: "/github/setup",
  webhook: "/github/webhook",
} as const;

export const GITHUB_FLOW_PURPOSES = ["connect", "install"] as const;
export type GithubFlowPurpose = (typeof GITHUB_FLOW_PURPOSES)[number];

/**
 * `pending` until the browser comes back; `requested` when an organization
 * member asked an owner to install (completed later by the installation's
 * webhook); `done` or `failed` once, never reopened.
 */
export const GITHUB_FLOW_STATUSES = ["pending", "requested", "done", "failed"] as const;
export type GithubFlowStatus = (typeof GITHUB_FLOW_STATUSES)[number];

export const GITHUB_CONNECTION_STATUSES = ["active", "needs_reconnect", "revoked"] as const;
export type GithubConnectionStatus = (typeof GITHUB_CONNECTION_STATUSES)[number];

/** Whether a project's repository is reachable through the App, and if not, why. */
export const GITHUB_REPO_ACCESS = [
  "ok",
  "app_removed",
  "not_in_installation",
  "archived",
  "deleted",
] as const;
export type GithubRepoAccess = (typeof GITHUB_REPO_ACCESS)[number];

export const GITHUB_DELIVERY_OUTCOMES = ["applied", "ignored"] as const;
export type GithubDeliveryOutcome = (typeof GITHUB_DELIVERY_OUTCOMES)[number];

export const GITHUB_ACCOUNT_TYPES = ["user", "org"] as const;
export type GithubAccountType = (typeof GITHUB_ACCOUNT_TYPES)[number];

export const GITHUB_REPOSITORY_SELECTIONS = ["all", "selected"] as const;
export type GithubRepositorySelection = (typeof GITHUB_REPOSITORY_SELECTIONS)[number];

/** The typed `code` of every GitHub failure the backend answers or records on a flow. */
export const GITHUB_ERROR_CODES = [
  /** The deployment has no GitHub App configured (owner setup pending). */
  "github_not_configured",
  /** The person has not connected GitHub. */
  "not_connected",
  /** The connection's refresh token no longer works: connect again. */
  "needs_reconnect",
  /** The flow is unknown, belongs to someone else, or its secret does not match. */
  "flow_not_found",
  "flow_expired",
  /** The flow already finished: a browser tab replayed it. */
  "flow_used",
  /** This GitHub account is already connected to another Volli account. */
  "account_already_linked",
  /** The setup redirect named an installation the person's token cannot see. */
  "installation_not_visible",
  /** The person declined on GitHub, or GitHub refused the exchange. */
  "github_denied",
  "github_rate_limited",
  "github_unavailable",
] as const;
export type GithubErrorCode = (typeof GITHUB_ERROR_CODES)[number];

/** How long a connect or install flow waits for the browser. */
export const GITHUB_FLOW_TTL_MS = 10 * 60 * 1000;
/** How long a webhook delivery id is remembered (duplicates inside it are no-ops). */
export const GITHUB_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A user access token is refreshed this long before GitHub expires it. */
export const GITHUB_TOKEN_REFRESH_MARGIN_MS = 30 * 60 * 1000;
/** How long one caller holds the right to refresh a person's tokens. */
export const GITHUB_REFRESH_LEASE_MS = 60 * 1000;

// ── flow state ─────────────────────────────────────────────────────────────

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLOW_SECRET = /^[A-Za-z0-9_-]{32,128}$/;

/** The `state` a flow's browser round trip carries: which flow, and its secret. */
export function formatFlowState(flowId: string, secret: string): string {
  return `${flowId}.${secret}`;
}

/** The flow id and secret in a returned `state`, or `null` for anything else. */
export function parseFlowState(
  state: string | null | undefined,
): { flowId: string; secret: string } | null {
  if (typeof state !== "string") return null;
  const dot = state.indexOf(".");
  if (dot < 0) return null;
  const flowId = state.slice(0, dot);
  const secret = state.slice(dot + 1);
  if (!FLOW_ID.test(flowId) || !FLOW_SECRET.test(secret)) return null;
  return { flowId, secret };
}

// ── tokens ─────────────────────────────────────────────────────────────────

/** When a user access token stops being handed out: the moment the backend refreshes it. */
export function githubTokenUseUntil(accessExpiresAt: number): number {
  return accessExpiresAt - GITHUB_TOKEN_REFRESH_MARGIN_MS;
}

/** What a mint needs to know about a person's connection. */
export interface GithubMintFacts {
  readonly status: GithubConnectionStatus;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly hasTokens: boolean;
}

/**
 * What a mint does now: hand out the current token, refresh it first, or
 * refuse (`not_connected` with no connection, `needs_reconnect` once the
 * refresh token is spent or expired).
 */
export function decideGithubMint(
  connection: GithubMintFacts | null,
  now: number,
): "use" | "refresh" | "not_connected" | "needs_reconnect" {
  if (connection === null || connection.status === "revoked" || !connection.hasTokens) {
    return "not_connected";
  }
  if (connection.status === "needs_reconnect") return "needs_reconnect";
  if (now < githubTokenUseUntil(connection.accessExpiresAt)) return "use";
  if (now >= connection.refreshExpiresAt) return "needs_reconnect";
  return "refresh";
}

/** Whether a refresh lease is free for a new holder (none, or expired). */
export function githubLeaseFree(lease: { until: number } | null, now: number): boolean {
  return lease === null || lease.until <= now;
}

/** The secrets in `current[,previous]`, in order, blanks dropped. */
export function parseWebhookSecrets(variable: string | null | undefined): string[] {
  return (variable ?? "")
    .split(",")
    .map((secret) => secret.trim())
    .filter((secret) => secret !== "");
}

// ── repository access ──────────────────────────────────────────────────────

/** What the backend knows about a repository a project uses, after a reconcile. */
interface GithubRepoAccessFacts {
  /** The installation that holds the repository, or `null` when none does any more. */
  readonly installation: { readonly deleted: boolean; readonly suspended: boolean } | null;
  /** Whether the installation's repository selection includes it. */
  readonly inInstallation: boolean;
  readonly repository: { readonly archived: boolean; readonly deleted: boolean };
}

/**
 * The repository's `githubAccess`: a deleted repository first, then the
 * App's own reach (removed or suspended reads as removed; a repository left
 * out of the selection), then an archived one, which can be read but not
 * pushed to.
 */
export function decideRepoAccess(facts: GithubRepoAccessFacts): GithubRepoAccess {
  if (facts.repository.deleted) return "deleted";
  if (facts.installation === null || facts.installation.deleted || facts.installation.suspended) {
    return "app_removed";
  }
  if (!facts.inInstallation) return "not_in_installation";
  if (facts.repository.archived) return "archived";
  return "ok";
}

// ── emails ─────────────────────────────────────────────────────────────────

/** A verified email address, as `GET /user/emails` answers it. */
export interface GithubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
  /** `public`, `private`, or `null` when the person never set it. */
  readonly visibility: string | null;
}

/**
 * The verified addresses in a `GET /user/emails` answer, at most `limit`:
 * what a connection caches for the "Commit as" choices and the default
 * commit identity. Unreadable entries are dropped.
 */
export function readVerifiedGithubEmails(value: unknown, limit = 20): GithubEmail[] {
  if (!Array.isArray(value)) return [];
  const emails: GithubEmail[] = [];
  for (const entry of value) {
    const row = record(entry);
    const email = text(row?.["email"]);
    if (email === null || row?.["verified"] !== true) continue;
    emails.push({
      email,
      primary: row["primary"] === true,
      verified: true,
      visibility: text(row["visibility"]),
    });
    if (emails.length === limit) break;
  }
  return emails;
}

// ── webhook events ─────────────────────────────────────────────────────────

/** The installation fields every installation event carries. */
export interface GithubInstallationFacts {
  readonly installationId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly accountType: GithubAccountType;
  readonly repositorySelection: GithubRepositorySelection;
  readonly permissions: Record<string, string>;
  readonly events: string[];
  readonly suspended: boolean;
}

const GITHUB_INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspend",
  "unsuspend",
  "new_permissions_accepted",
] as const;
export type GithubInstallationAction = (typeof GITHUB_INSTALLATION_ACTIONS)[number];

const GITHUB_REPOSITORY_ACTIONS = [
  "renamed",
  "transferred",
  "edited",
  "archived",
  "unarchived",
  "deleted",
  "privatized",
  "publicized",
] as const;
export type GithubRepositoryAction = (typeof GITHUB_REPOSITORY_ACTIONS)[number];

/** A delivery reduced to what the backend acts on. */
export type GithubEvent =
  | {
      readonly kind: "installation";
      readonly action: GithubInstallationAction;
      readonly installation: GithubInstallationFacts;
      /** The GitHub user who asked an organization owner to install, when one did. */
      readonly requesterId: string | null;
    }
  | {
      readonly kind: "installation_repositories";
      readonly action: "added" | "removed";
      readonly installation: GithubInstallationFacts;
    }
  | {
      readonly kind: "installation_target";
      readonly action: "renamed";
      readonly installationId: string;
      readonly accountLogin: string;
    }
  | {
      readonly kind: "repository";
      readonly action: GithubRepositoryAction;
      readonly installationId: string | null;
      readonly githubRepoId: string;
    }
  | {
      readonly kind: "github_app_authorization";
      readonly action: "revoked";
      readonly githubUserId: string;
    }
  | { readonly kind: "ignored"; readonly event: string; readonly action: string | null };

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** GitHub's numeric ids, carried as decimal strings. */
function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)) return value;
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function oneOf<const T extends readonly string[]>(list: T, value: unknown): T[number] | null {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

/** The installation object of a delivery or of `GET /app/installations/{id}`, or `null`. */
export function readGithubInstallation(value: unknown): GithubInstallationFacts | null {
  const installation = record(value);
  const account = record(installation?.["account"]);
  const installationId = idOf(installation?.["id"]);
  const accountId = idOf(account?.["id"]);
  const accountLogin = text(account?.["login"]);
  if (installationId === null || accountId === null || accountLogin === null) return null;
  const permissions: Record<string, string> = {};
  for (const [name, level] of Object.entries(record(installation?.["permissions"]) ?? {})) {
    if (typeof level === "string") permissions[name] = level;
  }
  const events = installation?.["events"];
  return {
    installationId,
    accountId,
    accountLogin,
    accountType: account?.["type"] === "Organization" ? "org" : "user",
    repositorySelection: installation?.["repository_selection"] === "all" ? "all" : "selected",
    permissions,
    events: Array.isArray(events) ? events.filter((e): e is string => typeof e === "string") : [],
    suspended:
      installation?.["suspended_at"] !== null && installation?.["suspended_at"] !== undefined,
  };
}

/**
 * Reads one webhook delivery (`X-GitHub-Event` and the parsed body). Anything
 * Volli does not act on, or cannot read, is `ignored` with what it was.
 */
export function extractGithubEvent(event: string, payload: unknown): GithubEvent {
  const body = record(payload);
  const action = text(body?.["action"]);
  const ignored: GithubEvent = { kind: "ignored", event, action };
  if (body === null) return ignored;
  switch (event) {
    case "installation": {
      const known = oneOf(GITHUB_INSTALLATION_ACTIONS, action);
      const installation = readGithubInstallation(body["installation"]);
      if (known === null || installation === null) return ignored;
      return {
        kind: "installation",
        action: known,
        installation,
        requesterId: idOf(record(body["requester"])?.["id"]),
      };
    }
    case "installation_repositories": {
      const installation = readGithubInstallation(body["installation"]);
      if ((action !== "added" && action !== "removed") || installation === null) return ignored;
      return { kind: "installation_repositories", action, installation };
    }
    case "installation_target": {
      const installationId = idOf(record(body["installation"])?.["id"]);
      const accountLogin = text(record(body["account"])?.["login"]);
      if (action !== "renamed" || installationId === null || accountLogin === null) return ignored;
      return { kind: "installation_target", action, installationId, accountLogin };
    }
    case "repository": {
      const known = oneOf(GITHUB_REPOSITORY_ACTIONS, action);
      const githubRepoId = idOf(record(body["repository"])?.["id"]);
      if (known === null || githubRepoId === null) return ignored;
      return {
        kind: "repository",
        action: known,
        installationId: idOf(record(body["installation"])?.["id"]),
        githubRepoId,
      };
    }
    case "github_app_authorization": {
      const githubUserId = idOf(record(body["sender"])?.["id"]);
      if (action !== "revoked" || githubUserId === null) return ignored;
      return { kind: "github_app_authorization", action, githubUserId };
    }
    default:
      return ignored;
  }
}

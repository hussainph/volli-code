/**
 * Runners: the machines a person links to their account so Sessions can run
 * there (their Mac, a Linux box, later a Volli Cloud runner). This is the
 * Convex-independent half of runner registration, shared by the backend
 * (`convex/functions/runners.ts`, `runnerHttp.ts`) and the runner-side client
 * (`@volli/host-core/cloud-runner`):
 *
 * - the vocabulary the `runners` table stores (kinds, statuses, install modes,
 *   link methods);
 * - the liveness contract: a heartbeat every 30 s into a presence document no
 *   client subscribes to, and `offline` after 90 s of silence;
 * - the runner token: a short-lived JWT the backend issues for a rotated
 *   refresh credential (issuer, audience, `runner:<uuid>` subject);
 * - the capability report a runner publishes on connect and on change;
 * - the HTTP wire of `/runner/*` (link with an install token, the device-code
 *   link, the token exchange), with codecs for both ends.
 *
 * A runner belongs to a person, never a Workspace: it serves its owner's
 * Sessions in every Workspace they are a member of, and nobody else's.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { readId, type RunnerId, type UserId } from "./ids";

// ── vocabulary ───────────────────────────────────────────────────────────────

export const RUNNER_KINDS = ["mac", "linux", "cloud"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export const RUNNER_STATUSES = [
  "online",
  "offline",
  /** The machine said it is going to sleep (a Mac's lid closed); its first beat after wake makes it `online`. */
  "asleep",
  "draining",
  "updating",
  "degraded",
  "upgrade_required",
  "stopped",
  "revoked",
] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** Statuses the offline sweep watches: a runner in one of them is expected to heartbeat. */
export const LIVE_RUNNER_STATUSES = [
  "online",
  "draining",
  "updating",
  "degraded",
  "upgrade_required",
] as const satisfies readonly RunnerStatus[];

/**
 * What a runner may report about itself. `offline` is the sweep's; `revoked` the owner's.
 * `asleep` is not a live status: an asleep runner is not expected to beat, so
 * the offline sweep leaves it (and its `since`) as it said.
 */
export const RUNNER_REPORTED_STATES = [
  "online",
  "asleep",
  "draining",
  "updating",
  "degraded",
  "stopped",
] as const satisfies readonly RunnerStatus[];
export type RunnerReportedState = (typeof RUNNER_REPORTED_STATES)[number];

export const RUNNER_INSTALL_MODES = ["system", "user", "app", "cloud"] as const;
export type RunnerInstallMode = (typeof RUNNER_INSTALL_MODES)[number];

export const RUNNER_LINK_METHODS = ["desktop", "install_token", "device_code", "provider"] as const;
export type RunnerLinkMethod = (typeof RUNNER_LINK_METHODS)[number];

export const RUNNER_LOCAL_CREDENTIAL_KINDS = ["subscription", "api_key"] as const;
export type RunnerLocalCredentialKind = (typeof RUNNER_LOCAL_CREDENTIAL_KINDS)[number];

/**
 * Why a runner is `revoked` or `offline`, as `runners.statusReason` stores it.
 * The set is open on read: a reason this build does not know is shown as-is.
 */
export const RUNNER_STATUS_REASONS = {
  /** The owner removed it in Settings. */
  removed: "removed",
  /** Its credential was presented from two places; the runner was cut off. */
  credentialReuse: "credential_reuse",
  /** No heartbeat for {@link RUNNER_OFFLINE_AFTER_MS}. */
  heartbeatLost: "heartbeat_lost",
  /** The same Mac registered again (its local credential was lost); its successor took its name and Sessions. */
  replaced: "replaced",
} as const;

// ── liveness and lifetimes ───────────────────────────────────────────────────

/** How often a connected runner heartbeats. */
export const RUNNER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Silence after which the sweep marks a live runner `offline`. */
export const RUNNER_OFFLINE_AFTER_MS = 90_000;
/** How long a runner token (JWT) lives. A runner refreshes it at two thirds of that, on server time. */
export const RUNNER_TOKEN_TTL_MS = 15 * 60_000;
/** How long an install token minted in Settings stays usable. */
export const RUNNER_INSTALL_TOKEN_TTL_MS = 60 * 60_000;
/** How long a device code waits for approval. */
export const RUNNER_LINK_REQUEST_TTL_MS = 10 * 60_000;
/** How often a box polls a pending device code. */
export const RUNNER_LINK_POLL_INTERVAL_MS = 5_000;

// ── the runner token ─────────────────────────────────────────────────────────

/** The `iss` of every runner token. Paired with a per-deployment key, so it names the role, not a host. */
export const RUNNER_TOKEN_ISSUER = "https://runners.volli.app";
/** The `aud` of every runner token. */
export const RUNNER_TOKEN_AUDIENCE = "volli-runner";

const RUNNER_SUBJECT_PREFIX = "runner:";

/** The token subject for a runner: `runner:<uuid>`. */
export function runnerSubject(runnerId: RunnerId): string {
  return `${RUNNER_SUBJECT_PREFIX}${runnerId}`;
}

/** The runner a token subject names, or `null` when it names none. */
export function runnerIdFromSubject(subject: string): RunnerId | null {
  if (!subject.startsWith(RUNNER_SUBJECT_PREFIX)) return null;
  return readId("runner", subject.slice(RUNNER_SUBJECT_PREFIX.length));
}

/** The claims a runner token carries beside `iss`, `aud`, `sub`, `iat` and `exp`. */
export interface RunnerTokenClaims {
  /** The owner's user id. A hint for logs; functions read the owner from the runner row. */
  own: UserId;
  /** The credential generation the token was minted for (first use ends the previous one's grace). */
  gen: number;
  kind: RunnerKind;
}

// ── secrets ──────────────────────────────────────────────────────────────────

/** Prefixes that make a leaked secret recognisable in a log or a paste. */
export const RUNNER_SECRET_PREFIXES = {
  installToken: "vrt_",
  credential: "vrc_",
  pollSecret: "vrp_",
} as const;

/**
 * The stored form of a runner secret (install token, refresh credential, poll
 * secret, device code): lowercase hex SHA-256. The backend keeps only this.
 * The secrets carry 256 random bits, so an unsalted hash is enough.
 */
export function secretHash(secret: string): string {
  return bytesToHex(sha256(utf8ToBytes(secret)));
}

/**
 * The device-code alphabet: twenty consonants (RFC 8628 §6.1), so a code
 * cannot spell a word and has no 0/O or 1/I to confuse.
 */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

/** `ABCDEFGH` → `ABCD-EFGH`, the form a box prints. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What a person typed, as the code it means: upper-cased, separators and
 * spaces dropped. `null` when it cannot be a code at all.
 */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const letter of code) if (!USER_CODE_ALPHABET.includes(letter)) return null;
  return code;
}

// ── names ────────────────────────────────────────────────────────────────────

export const RUNNER_NAME_MAX_LENGTH = 40;

/**
 * A runner name as stored: a lowercase slug of letters, digits and dashes,
 * unique per owner. A hostname contributes its first label
 * (`hetzner-1.example.com` → `hetzner-1`). `null` when nothing usable is left.
 */
export function runnerNameSlug(input: string): string | null {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, RUNNER_NAME_MAX_LENGTH)
    .replace(/-$/, "");
  return slug === "" ? null : slug;
}

/** The first of `candidates` that slugs to a name; a hostname counts by its first label. */
export function chooseRunnerName(candidates: {
  name?: string | null;
  nameHint?: string | null;
  hostname?: string | null;
}): string {
  const hostLabel = candidates.hostname?.split(".")[0] ?? null;
  for (const candidate of [candidates.name, candidates.nameHint, hostLabel]) {
    const slug = candidate == null ? null : runnerNameSlug(candidate);
    if (slug !== null) return slug;
  }
  return "runner";
}

/** `base`, or `base-2`, `base-3`, … : the first that `taken` does not hold. */
export function dedupeRunnerName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, RUNNER_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

// ── capabilities and load ────────────────────────────────────────────────────

export interface RunnerPlatform {
  /** `darwin` | `linux` | … (Node's `process.platform`). */
  os: string;
  distro: string | null;
  kernel: string | null;
  arch: string;
  glibc: string | null;
}

/** The runner's load, sent with every heartbeat into the presence document. */
export interface RunnerLoad {
  activeSessions: number;
  activeTurns: number;
  queueDepth: number;
  freeDiskMb: number;
  freeMemMb: number;
}

export const RUNNER_CAPABILITIES_VERSION = 1;

export type RunnerBrowserCapability =
  | { state: "available"; backend: string }
  | { state: "unavailable"; reason: string };

/**
 * What a runner can do, sent on connect and on change, never with every
 * heartbeat. Versioned: a reader shows a newer version's known fields and
 * ignores the rest.
 */
export interface RunnerCapabilities {
  v: typeof RUNNER_CAPABILITIES_VERSION;
  nodeVersion: string;
  cpuCount: number;
  memTotalMb: number;
  /** `null` when git is not installed: such a runner cannot start Sessions. */
  git: { version: string } | null;
  docker: boolean;
  terminals: "available" | "unavailable";
  browser: RunnerBrowserCapability;
  /** How many Sessions this runner admits at once (its memory admission). */
  maxConcurrentSessions: number;
  /**
   * Open capability names: platform tools a Session may need (`xcode`,
   * `simulator`, …), plus explicit job executors such as `automation.run`.
   * Mac-only tools appear only on a Mac. A job capability is advertised only
   * when this runner can execute that kind; absence never implies support.
   */
  tools: string[];
}

/** Availability of a model credential signed in on the runner. Never a value. */
export interface RunnerLocalCredential {
  providerId: string;
  kind: RunnerLocalCredentialKind;
  expiresAt: number | null;
}

/** What `runners.reportCapabilities` takes. */
export interface RunnerCapabilityReport {
  version: string;
  platform: RunnerPlatform;
  installMode: RunnerInstallMode;
  capabilities: RunnerCapabilities;
  localCredentials: RunnerLocalCredential[];
}

/** Bounds that keep a report one small document. `text` admits a full 253-character hostname. */
export const RUNNER_REPORT_LIMITS = { tools: 64, localCredentials: 64, text: 255 } as const;

/** A wire value that is not what its codec expects. */
export class RunnerWireError extends Error {
  readonly code = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "RunnerWireError";
  }
}

type Fields = Record<string, unknown>;

function objectOf(value: unknown, what: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerWireError(`${what} must be an object`);
  }
  return value as Fields;
}

function textOf(fields: Fields, key: string, what: string): string {
  const value = fields[key];
  if (typeof value !== "string" || value === "" || value.length > RUNNER_REPORT_LIMITS.text) {
    throw new RunnerWireError(`${what}.${key} must be a non-empty string`);
  }
  return value;
}

/** A JWT is longer than any other wire text; it is still bounded. */
const MAX_TOKEN_LENGTH = 8_192;

function tokenOf(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_TOKEN_LENGTH) {
    throw new RunnerWireError("body.token must be a non-empty string");
  }
  return value;
}

function nullableTextOf(fields: Fields, key: string, what: string): string | null {
  return fields[key] == null ? null : textOf(fields, key, what);
}

function countOf(fields: Fields, key: string, what: string): number {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RunnerWireError(`${what}.${key} must be a non-negative number`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  fields: Fields,
  key: string,
  values: T,
  what: string,
): T[number] {
  const value = fields[key];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RunnerWireError(`${what}.${key} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function listOf<T>(
  fields: Fields,
  key: string,
  max: number,
  what: string,
  item: (value: unknown) => T,
): T[] {
  const value = fields[key];
  if (!Array.isArray(value) || value.length > max) {
    throw new RunnerWireError(`${what}.${key} must be a list of at most ${max}`);
  }
  return value.map(item);
}

/** Strict on write: the capability report as the backend stores it. */
export function parseRunnerCapabilities(value: unknown): RunnerCapabilities {
  const what = "capabilities";
  const fields = objectOf(value, what);
  if (fields.v !== RUNNER_CAPABILITIES_VERSION) {
    throw new RunnerWireError(`${what}.v must be ${RUNNER_CAPABILITIES_VERSION}`);
  }
  const git =
    fields.git == null
      ? null
      : { version: textOf(objectOf(fields.git, `${what}.git`), "version", `${what}.git`) };
  const browserFields = objectOf(fields.browser, `${what}.browser`);
  const browserState = oneOf(
    browserFields,
    "state",
    ["available", "unavailable"] as const,
    `${what}.browser`,
  );
  const browser: RunnerBrowserCapability =
    browserState === "available"
      ? { state: "available", backend: textOf(browserFields, "backend", `${what}.browser`) }
      : { state: "unavailable", reason: textOf(browserFields, "reason", `${what}.browser`) };
  if (typeof fields.docker !== "boolean")
    throw new RunnerWireError(`${what}.docker must be a boolean`);
  return {
    v: RUNNER_CAPABILITIES_VERSION,
    nodeVersion: textOf(fields, "nodeVersion", what),
    cpuCount: countOf(fields, "cpuCount", what),
    memTotalMb: countOf(fields, "memTotalMb", what),
    git,
    docker: fields.docker,
    terminals: oneOf(fields, "terminals", ["available", "unavailable"] as const, what),
    browser,
    maxConcurrentSessions: countOf(fields, "maxConcurrentSessions", what),
    tools: listOf(fields, "tools", RUNNER_REPORT_LIMITS.tools, what, (tool) => {
      if (typeof tool !== "string" || tool === "" || tool.length > RUNNER_REPORT_LIMITS.text) {
        throw new RunnerWireError(`${what}.tools must hold non-empty strings`);
      }
      return tool;
    }),
  };
}

/** Strict on write: the local-credential availability list. */
export function parseRunnerLocalCredentials(value: unknown): RunnerLocalCredential[] {
  return listOf(
    { value },
    "value",
    RUNNER_REPORT_LIMITS.localCredentials,
    "localCredentials",
    (entry) => {
      const fields = objectOf(entry, "localCredentials[]");
      const expiresAt =
        fields.expiresAt == null ? null : countOf(fields, "expiresAt", "localCredentials[]");
      return {
        providerId: textOf(fields, "providerId", "localCredentials[]"),
        kind: oneOf(fields, "kind", RUNNER_LOCAL_CREDENTIAL_KINDS, "localCredentials[]"),
        expiresAt,
      };
    },
  );
}

function platformOf(value: unknown, what: string): RunnerPlatform {
  const fields = objectOf(value, what);
  return {
    os: textOf(fields, "os", what),
    distro: nullableTextOf(fields, "distro", what),
    kernel: nullableTextOf(fields, "kernel", what),
    arch: textOf(fields, "arch", what),
    glibc: nullableTextOf(fields, "glibc", what),
  };
}

/** Strict on write: a whole `runners.reportCapabilities` report. */
export function parseRunnerCapabilityReport(value: unknown): RunnerCapabilityReport {
  const fields = objectOf(value, "report");
  return {
    version: textOf(fields, "version", "report"),
    platform: platformOf(fields.platform, "report.platform"),
    installMode: oneOf(fields, "installMode", RUNNER_INSTALL_MODES, "report"),
    capabilities: parseRunnerCapabilities(fields.capabilities),
    localCredentials: parseRunnerLocalCredentials(fields.localCredentials),
  };
}

// ── the `/runner/*` HTTP wire ────────────────────────────────────────────────

/** HTTP routes on the deployment's site URL. */
export const RUNNER_HTTP_PATHS = {
  link: "/runner/link",
  linkStart: "/runner/link/start",
  linkPoll: "/runner/link/poll",
  token: "/runner/token",
} as const;

/** What a box says about itself when it links. Stored on the request and the runner row. */
export interface RunnerHostFacts {
  hostname: string;
  platform: RunnerPlatform;
  installMode: RunnerInstallMode;
}

export function parseRunnerHostFacts(value: unknown): RunnerHostFacts {
  const fields = objectOf(value, "host");
  return {
    hostname: textOf(fields, "hostname", "host"),
    platform: platformOf(fields.platform, "host.platform"),
    installMode: oneOf(fields, "installMode", RUNNER_INSTALL_MODES, "host"),
  };
}

/** The kind a linking box becomes: a Mac is `mac`, anything else a box links is `linux`. */
export function runnerKindForOs(os: string): RunnerKind {
  return os === "darwin" ? "mac" : "linux";
}

/** `POST /runner/link`: an install token minted in Settings. */
export interface RunnerLinkRequest {
  installToken: string;
  host: RunnerHostFacts;
  /** `volli-runner link --name`; wins over the token's hint and the hostname. */
  name: string | null;
}

export function parseRunnerLinkRequest(value: unknown): RunnerLinkRequest {
  const fields = objectOf(value, "body");
  return {
    installToken: textOf(fields, "installToken", "body"),
    host: parseRunnerHostFacts(fields.host),
    name: nullableTextOf(fields, "name", "body"),
  };
}

/** What both link paths end in: the runner's id and its first refresh credential. */
export interface RunnerLinkGrant {
  runnerId: RunnerId;
  name: string;
  /** The refresh credential: shown once, stored only as a hash. */
  credential: string;
  generation: number;
}

/** `POST /runner/link/start`: begin a device-code link. */
export interface RunnerDeviceLinkStartRequest {
  host: RunnerHostFacts;
}

export function parseRunnerDeviceLinkStartRequest(value: unknown): RunnerDeviceLinkStartRequest {
  return { host: parseRunnerHostFacts(objectOf(value, "body").host) };
}

export interface RunnerDeviceLinkStart {
  requestId: string;
  /** `ABCD-EFGH`, to enter in Settings → Runners → Link a runner. */
  userCode: string;
  /** Proves the poller is the box that started the request. */
  pollSecret: string;
  intervalMs: number;
  expiresAt: number;
}

/** `POST /runner/link/poll`. */
export interface RunnerDeviceLinkPollRequest {
  requestId: string;
  pollSecret: string;
}

export function parseRunnerDeviceLinkPollRequest(value: unknown): RunnerDeviceLinkPollRequest {
  const fields = objectOf(value, "body");
  return {
    requestId: textOf(fields, "requestId", "body"),
    pollSecret: textOf(fields, "pollSecret", "body"),
  };
}

export type RunnerDeviceLinkPoll =
  | { status: "pending" | "denied" | "expired" }
  | { status: "linked"; grant: RunnerLinkGrant };

/** `POST /runner/token`: exchange the refresh credential for a token and its successor. */
export interface RunnerTokenRequest {
  runnerId: RunnerId;
  credential: string;
}

export function parseRunnerTokenRequest(value: unknown): RunnerTokenRequest {
  const fields = objectOf(value, "body");
  const runnerId = readId("runner", fields.runnerId);
  if (runnerId === null) throw new RunnerWireError("body.runnerId must be a runner id");
  return { runnerId, credential: textOf(fields, "credential", "body") };
}

export interface RunnerTokenGrant {
  /** The runner token, for `Authorization: Bearer` and the Convex client's `setAuth`. */
  token: string;
  /** Server time the token expires at. */
  expiresAt: number;
  /** Server time when it was minted: refresh scheduling runs on this clock, never the box's. */
  serverTime: number;
  /** The rotated refresh credential. Persist it BEFORE using the token. */
  credential: string;
  generation: number;
}

/** Error codes `/runner/*` answers with, as `{ error: { code, message } }`. */
export const RUNNER_HTTP_ERROR_CODES = [
  "invalid_request",
  /** The install token is unknown, used, expired or revoked. */
  "invalid_install_token",
  /** The device-code request is unknown or the poll secret is wrong. */
  "invalid_link_request",
  /** The refresh credential matches nothing current: link again. */
  "invalid_credential",
  /** The runner was removed or cut off: link again. */
  "revoked",
  /** The deployment has no runner-token signing key. */
  "issuer_unconfigured",
  /**
   * Too many requests from this network (or the deployment as a whole): the
   * reply is a 429 whose `Retry-After` header says, in seconds, when to try again.
   */
  "rate_limited",
  /** Authorization is paused; keep the credential for when preview access is restored. */
  "preview_access_required",
] as const;
export type RunnerHttpErrorCode = (typeof RUNNER_HTTP_ERROR_CODES)[number];

/** Errors after which retrying the same request cannot succeed: the runner must be linked again. */
export const RUNNER_RELINK_CODES: readonly RunnerHttpErrorCode[] = [
  "invalid_credential",
  "revoked",
];

export interface RunnerHttpErrorBody {
  error: { code: RunnerHttpErrorCode; message: string };
}

/** The error a `/runner/*` response body names, or `null` when it is not one of ours. */
export function readRunnerHttpError(value: unknown): RunnerHttpErrorBody["error"] | null {
  if (typeof value !== "object" || value === null) return null;
  const error = (value as Fields).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message } = error as Fields;
  if (typeof code !== "string" || !(RUNNER_HTTP_ERROR_CODES as readonly string[]).includes(code))
    return null;
  return {
    code: code as RunnerHttpErrorCode,
    message: typeof message === "string" ? message : code,
  };
}

function grantOf(value: unknown): RunnerLinkGrant {
  const fields = objectOf(value, "grant");
  const runnerId = readId("runner", fields.runnerId);
  if (runnerId === null) throw new RunnerWireError("grant.runnerId must be a runner id");
  return {
    runnerId,
    name: textOf(fields, "name", "grant"),
    credential: textOf(fields, "credential", "grant"),
    generation: countOf(fields, "generation", "grant"),
  };
}

/** The runner's read of a `/runner/link` reply. */
export function parseRunnerLinkGrant(value: unknown): RunnerLinkGrant {
  return grantOf(value);
}

export function parseRunnerDeviceLinkStart(value: unknown): RunnerDeviceLinkStart {
  const fields = objectOf(value, "body");
  return {
    requestId: textOf(fields, "requestId", "body"),
    userCode: textOf(fields, "userCode", "body"),
    pollSecret: textOf(fields, "pollSecret", "body"),
    intervalMs: countOf(fields, "intervalMs", "body"),
    expiresAt: countOf(fields, "expiresAt", "body"),
  };
}

export function parseRunnerDeviceLinkPoll(value: unknown): RunnerDeviceLinkPoll {
  const fields = objectOf(value, "body");
  const status = oneOf(
    fields,
    "status",
    ["pending", "denied", "expired", "linked"] as const,
    "body",
  );
  return status === "linked" ? { status, grant: grantOf(fields.grant) } : { status };
}

export function parseRunnerTokenGrant(value: unknown): RunnerTokenGrant {
  const fields = objectOf(value, "body");
  return {
    token: tokenOf(fields.token),
    expiresAt: countOf(fields, "expiresAt", "body"),
    serverTime: countOf(fields, "serverTime", "body"),
    credential: textOf(fields, "credential", "body"),
    generation: countOf(fields, "generation", "body"),
  };
}

// ── the runner's mutations ───────────────────────────────────────────────────

/** What `runners.heartbeat` returns. */
export interface RunnerHeartbeatReply {
  serverTime: number;
  status: RunnerStatus;
  /** The version this runner should run (its pin, else its channel's), or `null`. */
  targetVersion: string | null;
  /** The oldest version its channel still serves, or `null`. */
  minVersion: string | null;
  autoUpdate: { enabled: boolean; channel: string; pinnedVersion: string | null };
}

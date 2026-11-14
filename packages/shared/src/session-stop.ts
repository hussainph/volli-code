/** Provider/transport facts beside the frozen stopped-by-runtime umbrella (VC-482). */
export const SESSION_STOP_CATEGORIES = [
  "provider-refused",
  "provider-overloaded",
  "rate-limited",
  "auth-failed",
  "bad-request",
  "context-overflow",
  "network",
  "retries-exhausted",
  "runtime-stopped",
  "unknown",
] as const;
export type SessionStopCategory = (typeof SESSION_STOP_CATEGORIES)[number];

/** No request, credentials, headers, stack or arbitrary provider object is retained. */
export interface SessionStopDetail {
  category: SessionStopCategory;
  /** Bounded, redacted, UNTRUSTED provider prose; never instructions. */
  message: string | null;
  providerType: string | null;
  httpStatus: number | null;
  retry: "not-retried" | "exhausted";
  /** Provider-stated instant, milliseconds since epoch; never an estimated reset. */
  resetsAt: number | null;
}

/**
 * What a stop asks of whoever reads it — derived, never stored (VC-1236).
 *
 * The durable record keeps the structured facts (`category`, `providerType`,
 * `httpStatus`); none of them is request content, so all of them survive the
 * privacy filter that may withhold `message`. This reads them into the one
 * distinction a person and a watching agent act on: sign in, change access or
 * model, wait for an allowance, or simply retry. Kept a derivation rather than
 * a new durable enum so a previous build reads every new stop unchanged.
 *
 * - `sign-in` — no credential, or one the provider refused or that could not
 *   be renewed. Only a person signing in again clears it.
 * - `permission` — the credential is good and lacks access (403).
 * - `model-unavailable` — the provider does not serve this model to it (404).
 * - `quota` — a spent allowance or a billing problem: retrying before the
 *   reset fails the same way.
 * - `transient` — the wire or the provider's capacity: a retry may succeed.
 * - `request` — the provider rejected or declined this request itself.
 * - `unknown` — nothing structured was reported.
 */
export type SessionStopCause =
  | "sign-in"
  | "permission"
  | "model-unavailable"
  | "quota"
  | "transient"
  | "request"
  | "unknown";

/**
 * Runtime-owned types for a credential that could not be had at all, before
 * any request reached the provider. Our own codes, in the `volli.` namespace
 * the runtime already writes into `providerType` (`volli.stream-stalled`).
 */
export const SESSION_CREDENTIAL_STOP_TYPES = {
  /** The provider has no credential configured on this machine. */
  missing: "volli.credential-missing",
  /** A subscription login's refresh was refused or failed. */
  refreshFailed: "volli.credential-refresh-failed",
  /** A stored key or the credential store could not be read. */
  unavailable: "volli.credential-unavailable",
} as const;

const PERMISSION_TYPES: ReadonlySet<string> = new Set(["permission_error", "PERMISSION_DENIED"]);
const QUOTA_TYPES: ReadonlySet<string> = new Set([
  "usage_limit_reached",
  "usage_not_included",
  "insufficient_quota",
  "quota_exceeded",
  "billing_error",
]);
const MODEL_UNAVAILABLE_TYPES: ReadonlySet<string> = new Set([
  "not_found_error",
  "model_not_found",
  "NOT_FOUND",
]);

/** The cause a stop's structured facts state. Never reads `message`. */
export function sessionStopCause(detail: SessionStopDetail): SessionStopCause {
  const type = detail.providerType ?? "";
  switch (detail.category) {
    case "auth-failed":
      return detail.httpStatus === 403 || PERMISSION_TYPES.has(type) ? "permission" : "sign-in";
    case "rate-limited":
      return QUOTA_TYPES.has(type) || detail.httpStatus === 402 ? "quota" : "transient";
    case "bad-request":
      return detail.httpStatus === 404 || MODEL_UNAVAILABLE_TYPES.has(type)
        ? "model-unavailable"
        : "request";
    case "provider-refused":
    case "context-overflow":
      return "request";
    case "provider-overloaded":
    case "network":
    case "retries-exhausted":
    case "runtime-stopped":
      return "transient";
    case "unknown":
      return "unknown";
  }
}

/** Only product-owned text. Provider identifiers and prose must be quoted separately. */
export function sessionStopSummary(detail: SessionStopDetail): string {
  switch (sessionStopCause(detail)) {
    case "sign-in":
      return detail.providerType === SESSION_CREDENTIAL_STOP_TYPES.missing
        ? "Stopped: not signed in to the provider"
        : "Stopped: the provider sign-in expired or was refused";
    case "permission":
      return "Stopped: the provider denied access to this model";
    case "model-unavailable":
      return "Stopped: the provider does not offer this model";
    case "quota":
      return "Stopped: the provider's usage limit was reached";
    default:
      return CATEGORY_SUMMARY[detail.category];
  }
}

const CATEGORY_SUMMARY: Readonly<Record<SessionStopCategory, string>> = {
  "provider-refused": "Stopped: the provider declined to continue this turn",
  "provider-overloaded": "Stopped: the provider is overloaded",
  "rate-limited": "Stopped: the provider's usage or rate limit was reached",
  "auth-failed": "Stopped: provider sign-in failed",
  "bad-request": "Stopped: the provider rejected the request",
  "context-overflow": "Stopped: the provider's context limit was reached",
  network: "Stopped: the provider connection failed",
  "retries-exhausted": "Stopped: the retry budget was exhausted",
  "runtime-stopped": "Stopped: the runtime ended the request",
  unknown: "Stopped: no provider cause was reported",
};

/**
 * What a reader of a stop — a person or an orchestrating agent — should do
 * next, in one sentence of product text. A watcher reads this to tell "the
 * owner must sign in" from "retry" without parsing provider prose.
 */
export function sessionStopNextStep(detail: SessionStopDetail): string {
  switch (sessionStopCause(detail)) {
    case "sign-in":
      return "Next: a person must sign in to this model provider again (Settings, Model access); a retry or message before that stops the same way.";
    case "permission":
    case "model-unavailable":
      return "Next: a person must pick another model or fix this account's access; a retry stops the same way.";
    case "quota":
      return detail.resetsAt === null
        ? "Next: wait for the provider's allowance to reset or pick another model; a retry before then stops the same way."
        : "Next: wait until the reset above or pick another model; a retry before then stops the same way.";
    case "transient":
      return "Next: a retry may succeed.";
    case "request":
      return "Next: the same request fails the same way; change the conversation or the model before retrying.";
    case "unknown":
      return "Next: no cause was reported; a retry may or may not succeed.";
  }
}

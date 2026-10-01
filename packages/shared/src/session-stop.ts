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

/** Only product-owned text. Provider identifiers and prose must be quoted separately. */
export function sessionStopSummary(detail: SessionStopDetail): string {
  return {
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
  }[detail.category];
}

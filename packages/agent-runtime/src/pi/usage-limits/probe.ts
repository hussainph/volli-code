/**
 * The on-demand read: one GET per subscribed provider, no model call.
 *
 * Two providers have an endpoint that answers "how much of my subscription is
 * left" without spending any of it — Anthropic's `/api/oauth/usage` and
 * Codex's `/backend-api/wham/usage`. Both take the same OAuth access token the
 * turns use, so the probe asks Pi for it through `Models.getAuth`, which runs
 * Pi's own refresh under Pi's own lock; nothing here reads `auth.json` or
 * mints a token.
 *
 * Three things the probe is careful about, in the order they bite:
 *
 * - **An API key has no windows.** An `api_key` credential is metered by
 *   invoice, and the endpoint would refuse it anyway. The probe reports
 *   `unsupported` without a request, and the fold treats that as final.
 * - **The usage endpoint has its own rate limit**, independent of chat. A 429
 *   is honoured for `Retry-After` when stated and five minutes otherwise, and
 *   the attempt reports `probeFailed` — which the fold reads as "keep the last
 *   good read". It is never retried inside one inspection.
 * - **A good read is fresh for five minutes.** Model Access is inspected far
 *   more often than a person opens it — every chat plane mount, every Session
 *   start — and each of those would otherwise be a request to a rate-limited
 *   endpoint. Within the freshness hold the probe says nothing new and the
 *   holder's value stands; an explicit Refresh skips the hold.
 *
 * `fetch` is injected so no test reaches the network, and every request is
 * bounded by the caller's signal — `inspectPiModelAccess` runs each probe
 * under the same `PROBE_TIMEOUT_MS` the provider probes get.
 */

import type { Models } from "@earendil-works/pi-ai";
import type { UsageLimits } from "@volli/shared";

import { anthropicUsageFromEndpoint } from "./anthropic";
import { codexUsageFromEndpoint } from "./codex";

/** How long a 429 holds the endpoint off when it names no `Retry-After`. */
export const USAGE_PROBE_COOLDOWN_MS = 5 * 60_000;
/** How long a good read is trusted before an ordinary inspection asks again. */
export const USAGE_PROBE_FRESH_MS = 5 * 60_000;
/**
 * The most a `Retry-After` may hold the endpoint off. A header that asks for
 * a day is a header that has decided the page shows yesterday's numbers until
 * tomorrow; an hour is the most this will honour before asking again.
 */
const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** More than enough for either endpoint's JSON; anything larger is not a usage body. */
const MAX_BODY_BYTES = 64 * 1024;

/** The narrow view of Pi's collection a probe takes: the credential's kind, and the credential. */
export type UsageProbeModels = Pick<Models, "checkAuth" | "getAuth">;

/** Injected so tests never reach the network; production passes `globalThis.fetch`. */
export type UsageProbeFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/**
 * Per-provider holds on the endpoint: the cooldown a 429 imposes, which nothing
 * skips, and the freshness a good read earns, which an explicit refresh does.
 *
 * One per runtime, shared across inspections, because a limit the endpoint
 * stated on one inspection is still in force on the next.
 */
export class UsageProbeSchedule {
  readonly #cooldownUntil = new Map<string, number>();
  readonly #freshUntil = new Map<string, number>();

  /** Whether a read may go out now. `force` skips the freshness hold, never the cooldown. */
  allows(providerId: string, now: number, force: boolean): boolean {
    const cooldown = this.#cooldownUntil.get(providerId);
    if (cooldown !== undefined && now < cooldown) return false;
    if (force) return true;
    const fresh = this.#freshUntil.get(providerId);
    return fresh === undefined || now >= fresh;
  }

  holdOff(providerId: string, untilMs: number): void {
    this.#cooldownUntil.set(providerId, untilMs);
  }

  markFresh(providerId: string, untilMs: number): void {
    this.#freshUntil.set(providerId, untilMs);
  }
}

/** What one probe of one provider concluded. */
export type UsageProbeOutcome =
  /** A read happened, or a verdict that needs none: fold it. */
  | { kind: "read"; limits: UsageLimits }
  /** The schedule held the read; whatever is published stands. */
  | { kind: "held" }
  /** Nothing to show for this provider: no read exists, or no credential to read with. */
  | { kind: "none" };

export interface UsageProbeInput {
  providerId: string;
  models: UsageProbeModels;
  fetch: UsageProbeFetch;
  signal: AbortSignal;
  now: () => number;
  schedule: UsageProbeSchedule;
  /** An explicit Refresh: skip the freshness hold (never the cooldown). */
  force: boolean;
}

/** One provider's usage endpoint and how to read it. */
interface UsageReader {
  url: string;
  /** Headers beyond `authorization`, which every reader sends. */
  headers(accessToken: string): Record<string, string>;
  parse(body: unknown, checkedAt: number): UsageLimits;
}

const READERS: Readonly<Record<string, UsageReader>> = {
  anthropic: {
    url: "https://api.anthropic.com/api/oauth/usage",
    headers: () => ({ "anthropic-beta": "oauth-2025-04-20" }),
    parse: anthropicUsageFromEndpoint,
  },
  "openai-codex": {
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers: (accessToken): Record<string, string> => {
      // The endpoint needs the ChatGPT account the token belongs to, and the
      // token says which: pi-ai reads the same claim off the same JWT for
      // every Codex request, so this is the credential's own statement rather
      // than a second read of the store.
      const accountId = chatgptAccountId(accessToken);
      return accountId === undefined ? {} : { "chatgpt-account-id": accountId };
    },
    parse: codexUsageFromEndpoint,
  },
};

/** The providers this module knows how to ask. */
export const USAGE_PROBE_PROVIDER_IDS: readonly string[] = Object.keys(READERS);

/**
 * Reads one provider's subscription windows, or says why it did not.
 *
 * Every failure collapses to `probeFailed`: a refused token, a body that is
 * not JSON, a network error, an aborted signal. No response text is carried
 * out — a provider's error body can echo the request that caused it, and a
 * request here carries a bearer token.
 */
export async function probeUsageLimits(input: UsageProbeInput): Promise<UsageProbeOutcome> {
  const reader = READERS[input.providerId];
  if (reader === undefined) return { kind: "none" };
  const checkedAt = input.now();
  try {
    const check = await input.models.checkAuth(input.providerId, { signal: input.signal });
    if (check === undefined) return { kind: "none" };
    if (check.type !== "oauth") {
      return {
        kind: "read",
        limits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      };
    }
    if (!input.schedule.allows(input.providerId, checkedAt, input.force)) return { kind: "held" };
    const resolved = await input.models.getAuth(input.providerId, { signal: input.signal });
    const accessToken = resolved?.auth.apiKey;
    if (accessToken === undefined) return { kind: "read", limits: probeFailed(checkedAt) };
    const response = await input.fetch(reader.url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...reader.headers(accessToken),
      },
      signal: input.signal,
    });
    if (response.status === 429) {
      const retryAfterMs = retryAfterMillis(response.headers.get("retry-after"), input.now());
      input.schedule.holdOff(
        input.providerId,
        input.now() + (retryAfterMs ?? USAGE_PROBE_COOLDOWN_MS),
      );
      return { kind: "read", limits: probeFailed(checkedAt) };
    }
    if (!response.ok) return { kind: "read", limits: probeFailed(checkedAt) };
    const body = await readJson(response);
    const limits = reader.parse(body, checkedAt);
    if (limits.unavailable === undefined) {
      input.schedule.markFresh(input.providerId, input.now() + USAGE_PROBE_FRESH_MS);
    }
    return { kind: "read", limits };
  } catch {
    return { kind: "read", limits: probeFailed(checkedAt) };
  }
}

/**
 * `Retry-After` as milliseconds from now, when it is usable.
 *
 * Both spellings the header allows — delay-seconds and an HTTP-date — and the
 * answer is clamped: a value in the past or zero reads as no header (the
 * default cooldown applies), and nothing holds the endpoint off longer than
 * {@link MAX_RETRY_AFTER_MS}.
 */
export function retryAfterMillis(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  if (!(ms > 0)) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * The `chatgpt_account_id` claim off a Codex access token, or nothing.
 *
 * The same decode pi-ai performs before every Codex request. Only the one
 * claim is read and only its string value leaves this function; the token is
 * never logged, compared or stored.
 */
export function chatgptAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return undefined;
    const auth = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("usage body too large");
  return JSON.parse(text);
}

function probeFailed(checkedAt: number): UsageLimits {
  return { checkedAt, windows: [], unavailable: { reason: "probeFailed" } };
}

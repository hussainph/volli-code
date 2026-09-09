/**
 * The on-demand read: one GET per subscribed provider, no model call.
 *
 * Three providers have an endpoint that answers "how much of my subscription
 * is left" without spending any of it — Anthropic's `/api/oauth/usage`,
 * Codex's `/backend-api/wham/usage`, and OpenCode Go's `/zen/go/v1/usage`.
 * Each takes the same credential the turns use, so the probe asks Pi for it
 * through `Models.getAuth`, which runs Pi's own refresh under Pi's own lock;
 * nothing here reads `auth.json` or mints a token.
 *
 * Three things the probe is careful about, in the order they bite:
 *
 * - **Which credential a subscription wears is the reader's to say.** On
 *   Anthropic and Codex an `api_key` is metered by invoice, and the endpoint
 *   would refuse it anyway: the probe reports `unsupported` without a request,
 *   and the fold treats that as final. OpenCode Go is a subscription driven by
 *   an API key, so its reader accepts one — and reads the console's 403
 *   ("OpenCode Go subscription required": a Zen-only key) as the same final
 *   `unsupported`, because no later read of that key will grow windows.
 * - **The usage endpoint has its own rate limit**, independent of chat. A 429
 *   is honoured for `Retry-After` when stated and five minutes otherwise, and
 *   the attempt reports `probeFailed` — which the fold reads as "keep the last
 *   good read". It is never retried inside one inspection.
 * - **Every completed attempt stands for five minutes**, not only a good one.
 *   Model Access is inspected far more often than a person opens it — every
 *   chat plane mount, every Session start, every auto-title — and each of
 *   those would otherwise be a request to a rate-limited endpoint. A FAILED
 *   attempt holds on the same terms as a good one: an endpoint that is down
 *   is exactly the one a loop of inspections must not hammer. An explicit
 *   Refresh skips this hold, which is what makes the surface's "Refresh to
 *   try again" true; nothing skips a 429's cooldown.
 * - **One read per provider at a time.** Nothing serializes the callers of
 *   `inspectModelAccess` — a Session start, a chat plane mount and the CLI can
 *   all land in the same tick — and the hold above cannot help, because it is
 *   only set once a reply comes back. A second caller joins the read already
 *   in flight instead of opening a second one.
 *
 * `fetch` is injected so no test reaches the network, and every request is
 * bounded by the caller's signal — `inspectPiModelAccess` runs each probe
 * under the same `PROBE_TIMEOUT_MS` the provider probes get.
 */

import type { CredentialStore, ModelAuth, Models } from "@earendil-works/pi-ai";
import { usageLimitsProbeFailed, usageLimitsUnsupported, type UsageLimits } from "@volli/shared";

import { anthropicUsageFromEndpoint } from "./anthropic";
import { codexUsageFromEndpoint } from "./codex";
import { githubCopilotUsageFromEndpoint } from "./github-copilot";
import { kimiUsageFromEndpoint } from "./kimi";
import { opencodeGoUsageFromEndpoint } from "./opencode-go";
import { xaiUsageFromEndpoint } from "./xai";

/** How long a 429 holds the endpoint off when it names no `Retry-After`. */
export const USAGE_PROBE_COOLDOWN_MS = 5 * 60_000;
/** How long one completed attempt stands before an ordinary inspection asks again. */
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

/**
 * The narrow view of the credential store a probe takes: ONE read, no writes.
 *
 * Only a reader whose endpoint refuses the request credential asks for this —
 * today only Copilot's, whose account endpoint lives on a different host than
 * its turns and knows a different token. Nothing here may write: a usage read
 * has no business changing what a person is signed in as.
 */
export type UsageProbeCredentials = Pick<CredentialStore, "read">;

/** Injected so tests never reach the network; production passes `globalThis.fetch`. */
export type UsageProbeFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/**
 * What each provider's endpoint is owed, and what is already on its way there.
 *
 * Two holds and one gate. The COOLDOWN is what a 429 imposed, and nothing
 * skips it — the endpoint has told us a number and we obey it. The ASKED hold
 * is what one completed attempt earns, and an explicit Refresh skips it,
 * because a person waiting on the page is not the traffic the hold exists to
 * stop. The gate is single-flight: concurrent inspections share one read.
 *
 * One per runtime, shared across inspections, because a limit the endpoint
 * stated on one inspection is still in force on the next.
 */
export class UsageProbeSchedule {
  readonly #cooldownUntil = new Map<string, number>();
  readonly #askedUntil = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<UsageProbeOutcome>>();

  /** Whether a read may go out now. `force` skips the asked hold, never the cooldown. */
  allows(providerId: string, now: number, force: boolean): boolean {
    const cooldown = this.#cooldownUntil.get(providerId);
    if (cooldown !== undefined && now < cooldown) return false;
    if (force) return true;
    const asked = this.#askedUntil.get(providerId);
    return asked === undefined || now >= asked;
  }

  holdOff(providerId: string, untilMs: number): void {
    this.#cooldownUntil.set(providerId, untilMs);
  }

  markAsked(providerId: string, untilMs: number): void {
    this.#askedUntil.set(providerId, untilMs);
  }

  /**
   * Runs one read per provider at a time; a caller arriving mid-read gets the
   * one already going.
   *
   * The outcome is an immutable value, so sharing it is safe. The joiner does
   * inherit the first caller's bound and signal — but a read it shares is a
   * read that happened, where a second request would have been one more call
   * on an endpoint that rate-limits us independently of chat.
   */
  coalesce(
    providerId: string,
    start: () => Promise<UsageProbeOutcome>,
  ): Promise<UsageProbeOutcome> {
    const existing = this.#inFlight.get(providerId);
    if (existing !== undefined) return existing;
    const run = start();
    this.#inFlight.set(providerId, run);
    // An unconditional delete, because the slot can only ever hold this run: a
    // caller arriving before this settles joins it rather than replacing it,
    // and one arriving after finds the slot already empty.
    void run.finally(() => this.#inFlight.delete(providerId));
    return run;
  }
}

/** What one probe of one provider concluded. */
export type UsageProbeOutcome =
  /** What the probe concluded — from a read, or from a fact that needed none. */
  | { kind: "verdict"; limits: UsageLimits }
  /** The schedule held the read; whatever is published stands. */
  | { kind: "held" }
  /**
   * This provider has nothing to show and any held reading is now wrong: it
   * has no usage endpoint, or nobody is signed in to it. The holder CLEARS on
   * this, so it is not the outcome for a read that merely failed.
   */
  | { kind: "cleared" };

export interface UsageProbeInput {
  providerId: string;
  models: UsageProbeModels;
  /**
   * The stored credentials, for the one reader whose endpoint takes something
   * other than the request token. Null is "cannot tell" — the same reading
   * `inspectPiModelAccess` gives a store it does not have — and a reader that
   * needs one then reports a failed attempt rather than clearing a good read.
   */
  credentials: UsageProbeCredentials | null;
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
  /**
   * Whether an `api_key` credential is a subscription here. False for a
   * provider whose subscription is OAuth-only (an API key is invoiced, not
   * windowed); true for one that hands subscribers a key.
   */
  acceptsApiKey: boolean;
  /**
   * WHICH of the account's secrets this endpoint takes.
   *
   * `request` — the default and the ordinary case — is the credential the
   * turns use, resolved through `Models.getAuth` so Pi's own refresh and lock
   * govern it.
   *
   * `oauth-refresh` is for an endpoint that is not the one the turns talk to.
   * Copilot is the case: a turn presents a short-lived proxy token to
   * `api.individual.githubcopilot.com`, and that token means nothing to
   * `api.github.com`, which knows only the GitHub OAuth token the proxy token
   * was minted FROM — the one Pi stores as `refresh` and re-presents on every
   * refresh of the other. Reading it here sends the same secret to the same
   * host Pi already sends it to, for the account it already belongs to.
   */
  credential?: "request" | "oauth-refresh";
  /**
   * The `authorization` scheme, when the endpoint wants something other than
   * `Bearer`. GitHub's internal endpoints take `token`.
   */
  scheme?: string;
  /**
   * A status the endpoint answers when the credential is valid but carries no
   * subscription — final for that credential, so it reads as `unsupported`
   * rather than a failed attempt. Absent means every refusal is an attempt.
   */
  noSubscriptionStatus?: number;
  /** Headers beyond `authorization`, which every reader sends. */
  headers(accessToken: string): Record<string, string>;
  parse(body: unknown, checkedAt: number): UsageLimits;
}

const READERS: Readonly<Record<string, UsageReader>> = {
  "github-copilot": {
    url: "https://api.github.com/copilot_internal/user",
    // A `COPILOT_GITHUB_TOKEN` in the environment is the same GitHub token by
    // another door — but it arrives as an api-key credential, and this reader
    // takes the OAuth one it can name with certainty.
    acceptsApiKey: false,
    credential: "oauth-refresh",
    scheme: "token",
    // The API version GitHub's own Copilot clients pin on this surface. No
    // editor identity rides with it: pi-ai states one on the requests it makes
    // as the Copilot editor client, and this is not one of those requests.
    headers: () => ({ "x-github-api-version": "2025-04-01" }),
    parse: githubCopilotUsageFromEndpoint,
  },
  anthropic: {
    url: "https://api.anthropic.com/api/oauth/usage",
    acceptsApiKey: false,
    headers: () => ({ "anthropic-beta": "oauth-2025-04-20" }),
    parse: anthropicUsageFromEndpoint,
  },
  "openai-codex": {
    url: "https://chatgpt.com/backend-api/wham/usage",
    acceptsApiKey: false,
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
  "kimi-coding": {
    url: "https://api.kimi.com/coding/v1/usages",
    // A Kimi membership is driven by an OAuth login or by a key minted in the
    // console FROM that membership, and the endpoint answers either: unlike
    // Anthropic's, a key here is the subscription rather than an invoice.
    acceptsApiKey: true,
    headers: () => ({}),
    parse: kimiUsageFromEndpoint,
  },
  xai: {
    // The shared-period meter, not `/v1/billing`'s dollar allowance: the query
    // is the difference between a window and a credit balance.
    url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    // A SuperGrok or X Premium subscription signs in; an `XAI_API_KEY` is the
    // pay-as-you-go platform account, which is invoiced rather than windowed.
    acceptsApiKey: false,
    // Which client is asking. No version rides with it: this is not the Grok
    // Build client, and a version string invented here would be a claim about
    // a build that does not exist.
    headers: () => ({ "x-grok-client-surface": "grok-build" }),
    parse: xaiUsageFromEndpoint,
  },
  "opencode-go": {
    url: "https://opencode.ai/zen/go/v1/usage",
    acceptsApiKey: true,
    // `EntitlementError`: the key is a Zen key with no Go subscription behind
    // it. Zen is pay-as-you-go credit, which has no windows to show.
    noSubscriptionStatus: 403,
    headers: () => ({}),
    parse: opencodeGoUsageFromEndpoint,
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
export function probeUsageLimits(input: UsageProbeInput): Promise<UsageProbeOutcome> {
  return input.schedule.coalesce(input.providerId, () => readUsageLimits(input));
}

async function readUsageLimits(input: UsageProbeInput): Promise<UsageProbeOutcome> {
  const reader = READERS[input.providerId];
  if (reader === undefined) return { kind: "cleared" };
  const checkedAt = input.now();
  try {
    const check = await input.models.checkAuth(input.providerId, { signal: input.signal });
    if (check === undefined) return { kind: "cleared" };
    if (check.type !== "oauth" && !reader.acceptsApiKey) {
      return { kind: "verdict", limits: usageLimitsUnsupported(checkedAt) };
    }
    if (!input.schedule.allows(input.providerId, checkedAt, input.force)) return { kind: "held" };
    // Past the gate, so this attempt counts whatever it returns. Recorded here
    // rather than on the way out so that a throw, an abort and a refused token
    // hold the endpoint off exactly as a good read does: the loop of ordinary
    // inspections is the traffic worth stopping, and a broken endpoint is the
    // case where stopping it matters most.
    input.schedule.markAsked(input.providerId, input.now() + USAGE_PROBE_FRESH_MS);
    const accessToken = await readerCredential(reader, input);
    if (accessToken === undefined) {
      return { kind: "verdict", limits: usageLimitsProbeFailed(checkedAt) };
    }
    const response = await input.fetch(reader.url, {
      method: "GET",
      headers: {
        authorization: `${reader.scheme ?? "Bearer"} ${accessToken}`,
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
      return { kind: "verdict", limits: usageLimitsProbeFailed(checkedAt) };
    }
    if (response.status === reader.noSubscriptionStatus) {
      return { kind: "verdict", limits: usageLimitsUnsupported(checkedAt) };
    }
    if (!response.ok) return { kind: "verdict", limits: usageLimitsProbeFailed(checkedAt) };
    const body = await readJson(response);
    return { kind: "verdict", limits: reader.parse(body, checkedAt) };
  } catch {
    return { kind: "verdict", limits: usageLimitsProbeFailed(checkedAt) };
  }
}

/** The secret this reader's endpoint takes, or nothing when it cannot be had. */
async function readerCredential(
  reader: UsageReader,
  input: UsageProbeInput,
): Promise<string | undefined> {
  if (reader.credential === "oauth-refresh") {
    const stored = await input.credentials?.read(input.providerId, { signal: input.signal });
    return stored?.type === "oauth" && stored.refresh.length > 0 ? stored.refresh : undefined;
  }
  const resolved = await input.models.getAuth(input.providerId, { signal: input.signal });
  return resolved === undefined ? undefined : bearerOf(resolved.auth);
}

/**
 * The token a resolved credential carries, wherever the provider puts it.
 *
 * `apiKey` is where most providers leave it, and pi-ai then writes the
 * `authorization` header itself. A provider whose gateway wants some other
 * spelling supplies the whole header instead — Kimi's `toAuth` returns
 * `headers.Authorization` and no `apiKey` at all — and a probe reading only
 * `apiKey` would report a subscribed account as unreadable forever.
 *
 * Only a bearer is taken. Any other scheme is a credential this reader does
 * not know how to present, and guessing at one would send a secret in a shape
 * the endpoint never asked for.
 */
export function bearerOf(auth: ModelAuth): string | undefined {
  if (auth.apiKey !== undefined && auth.apiKey.length > 0) return auth.apiKey;
  const header = auth.headers?.Authorization ?? auth.headers?.authorization;
  if (typeof header !== "string") return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  return bearer?.[1];
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

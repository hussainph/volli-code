/**
 * Pure projection of settled Pi assistant messages into Volli observations.
 *
 * Pi's durable history is the JSONL session tree, so a settled message is
 * identified by its session entry — not by its position in a live message
 * array. Keeping the projection pure here means the live runtime never has to
 * reason about Pi content shapes, and every mapping arm is testable without a
 * model.
 */

import type { AssistantMessage, KnownApi, Usage } from "@earendil-works/pi-ai";
import type {
  AttentionObservation,
  CostBasis,
  RuntimeFailure,
  RuntimeRecoveryRef,
  SanitizedUsage,
  SessionUsage,
  SettledAssistantMessage,
} from "@volli/shared";

export type AssistantMessageOutcome =
  | { kind: "settled"; message: SettledAssistantMessage }
  | { kind: "ignored" }
  | { kind: "failed"; failure: RuntimeFailure };

/**
 * Long enough for a provider's whole refusal, including the sentence that
 * says what to do about it. Anthropic's preserved-thinking 400 runs to about
 * 360 characters once its envelope is off, and the clause that names what
 * changed is the last one; 300 cut it (VC-242).
 */
const MAX_DIAGNOSTIC_LENGTH = 400;

/** Long opaque runs are how provider keys and bearer tokens look in error text. */
const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/g;
const PREFIXED_SECRET = /\b(?:sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]+/gi;
/**
 * How long a `-` or `_` joined segment may be before the run stops reading as
 * words. `prefix_mismatch_behavior` and `thinking-binding-controls-2026-08-01`
 * are under it in every segment; a key is one long segment, or mixed case, or
 * digits throughout, and the check below asks for all three to be absent.
 */
const MAX_WORD_SEGMENT = 12;

/**
 * Whether a long run is vocabulary rather than a credential.
 *
 * The opaque-run rule redacted `prefix_mismatch_behavior` (24 characters) and
 * the beta header name (36) out of the one provider message whose whole point
 * is naming them, leaving a person a sentence that says to set `[redacted]` to
 * `"drop_block"` (VC-242). What tells those apart from a key is that they are
 * lowercase words joined by separators: every segment short, at least one of
 * them a plain word. A key has none of that at once — a raw hex or base64
 * token is one long segment, a JWT segment is mixed case, a UUID has no
 * alphabetic segment — so each still redacts.
 */
function readsAsWords(run: string): boolean {
  if (run !== run.toLowerCase()) return false;
  const segments = run.split(/[-_]/);
  return (
    segments.every((segment) => segment.length > 0 && segment.length <= MAX_WORD_SEGMENT) &&
    segments.some((segment) => /^[a-z]+$/.test(segment))
  );
}

/**
 * The sentence inside a provider's error envelope, when the text is one.
 *
 * Anthropic's SDK renders a refused request as
 * `400 {"type":"error","error":{"type":"invalid_request_error","message":"…"},"request_id":"…"}`
 * and OpenAI's as `400 {"error":{"message":"…",…}}`. The envelope is for a
 * log; the person waiting on the turn needs the sentence. The status code
 * ahead of the brace is kept, because the auth classifier reads `401`/`403`
 * off it, and anything that is not an envelope is returned as it came.
 */
function providerSentence(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return raw;
  let body: Record<string, unknown>;
  try {
    // Text that opens with `{` parses to an object or throws; there is no
    // third case for the cast to be wrong about.
    body = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const message = errorMessageOf(body);
  if (message === undefined) return raw;
  const prefix = raw.slice(0, start).trim();
  return prefix.length > 0 ? `${prefix} ${message}` : message;
}

/** `error.message`, then `message`, when the parsed body carries either as text. */
function errorMessageOf(body: Record<string, unknown>): string | undefined {
  const nested = body["error"];
  const inner =
    nested !== null && typeof nested === "object"
      ? (nested as Record<string, unknown>)["message"]
      : undefined;
  const message = typeof inner === "string" && inner.length > 0 ? inner : body["message"];
  return typeof message === "string" && message.length > 0 ? message : undefined;
}
/**
 * The status codes are bounded as whole numbers: a Cloudflare error page or a
 * request id carries hex runs short enough to survive redaction, and one that
 * happened to contain `401` read a 502 as a refused key.
 */
const AUTH_SIGNAL =
  /(api[ _-]?key|auth|credential|unauthorized|forbidden|login|sign[ _-]?in|not configured|\b401\b|\b403\b)/i;
/**
 * How a provider says the window is spent, across the vocabularies they
 * actually use. Overflow recovery hangs off this classification: a refusal it
 * does not recognize is a Session told it broke instead of one that compacts
 * and continues, so each provider family's phrasing is pinned by a test with
 * its real sentence — OpenAI's "context window"/"maximum context length",
 * Anthropic's "prompt is too long", Bedrock's "input is too long", Google's
 * "input token count … exceeds the maximum number of tokens" (VC-155).
 */
const CONTEXT_SIGNAL =
  /(context (?:length|limit|window)|too many tokens|maximum tokens|(?:prompt|input) is too long|exceeds the maximum number of tokens)/i;
/**
 * How Anthropic refuses the conversation's own earlier reasoning.
 *
 * Two sentences, one repair. Claude Fable 5.1's preserved thinking answers a
 * `thinking` block whose signature is bound to a different prefix with
 * ``Invalid `signature` in `thinking` block``; every thinking model answers a
 * block that came back altered with ``blocks in the latest assistant message
 * cannot be modified``. Neither clears on a resend, and both clear once the
 * reasoning is dropped and the turn sent again — which is what
 * {@link RuntimeFailure}'s `reasoning` arm exists to trigger (VC-242). The
 * backtick-adjacent characters are wildcards so an envelope that escaped them
 * still matches; the second alternative is bounded so the pattern stays linear.
 */
const REASONING_SIGNAL =
  /(invalid .signature. in .thinking. block|(?:thinking|reasoning).{0,60}cannot be modified)/i;
/**
 * How a connection that died, or a provider that could not answer right now,
 * reads once the provider has rethrown it. Deliberately narrower than pi-ai's
 * own retry predicate: everything else a model can fail with — a spent quota, a
 * refused key, a payload it would build the same way again — is answered by a
 * person, and re-sending it just spends another turn arriving at the same
 * sentence.
 *
 * Every alternative is a sentence the owner's ledger recorded raised as a dead
 * end (VC-443), pinned by a table in `transcript.test.ts`:
 *
 * - the socket itself — Node's errno names, undici's `fetch failed`,
 *   `other side closed` and bare `terminated` (a body cut mid-read; anchored,
 *   because "terminated" inside a sentence is not this);
 * - the SDKs' own wording for the same — `Connection error.` and
 *   `Request timed out.`;
 * - a stream that ended without its closing event — Anthropic's
 *   `ended before message_stop`, an OpenAI-compatible `Stream ended without
 *   finish_reason`, and this runtime's own {@link STREAM_STALLED} report;
 * - a provider saying it is overloaded or that the request may simply be sent
 *   again (`You can retry your request`).
 */
const TRANSPORT_SIGNAL =
  /(websocket|econnreset|etimedout|econnrefused|econnaborted|epipe|ehostunreach|enetunreach|enetdown|eai_again|enotfound|socket hang up|other side closed|^terminated\b|fetch failed|network|connection error|timed out|timeout|stream (?:closed|ended) (?:before|without)|ended before message_stop|stream stalled|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|you can retry your request)/i;

/**
 * A spent allowance: the subscription window or the account's credit is used
 * up, and waiting minutes does not refill it. Read BEFORE any transient signal,
 * because both halves of the most common shape ride together — a `429` whose
 * sentence says the usage limit was reached is a quota, not a throttle.
 */
const QUOTA_SIGNAL =
  /(usage limit|out of (?:extra )?(?:usage|credits?)|quota|insufficient[_ ](?:balance|credits?|funds)|credit balance|billing|spending limit|payment required)/i;

/**
 * A provider asking the caller to slow down. Transient — the same request
 * succeeds once the window moves — which is exactly what a quota is not; the
 * two are told apart by {@link QUOTA_SIGNAL}, never by the status code alone.
 */
const THROTTLE_SIGNAL = /(rate[ _-]?limit|too many requests)/i;

/**
 * The HTTP status an SDK prints ahead of the provider's sentence (`502 <html>`,
 * `429: Rate limit…`, `500 status code (no body)`). Only a LEADING code is read:
 * a number later in the sentence is a token count, a port, or part of an id.
 */
const LEADING_STATUS = /^(\d{3})(?=[\s:]|$)/;

/**
 * Server-side statuses that say "not now" rather than "not this": the gateway
 * and overload family, including Cloudflare's 52x and Anthropic's 529.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529,
]);

/** This runtime's own report for a provider request that went silent; see `stream-supervision.ts`. */
export const STREAM_STALLED = "Provider stream stalled";

function leadingStatus(sanitized: string): number | undefined {
  const match = LEADING_STATUS.exec(sanitized);
  return match === null ? undefined : Number(match[1]);
}

const ATTENTION_REASON: Record<RuntimeFailure["reason"], AttentionObservation["reason"]> = {
  auth: "auth",
  configuration: "configuration",
  context: "context",
  // Reaches a person only after the runtime has already dropped the reasoning
  // and been refused again, which is the generic dead end with a Retry: the
  // one repair the doc names has been spent.
  reasoning: "runtime-failure",
  model: "runtime-failure",
  aborted: "runtime-failure",
  unknown: "runtime-failure",
};

/**
 * Strip secret-shaped substrings and bound the length. Never returns raw
 * provider text.
 *
 * Unwraps a provider's JSON error envelope first, so what is bounded and
 * redacted is the sentence a person can act on rather than the framing around
 * it. Every 24-character run is still suspect; only one that reads as joined
 * lowercase words is let through, because that is documentation vocabulary
 * and not a key ({@link readsAsWords}).
 */
export function sanitizeDiagnostic(raw: string): string {
  const collapsed = providerSentence(raw)
    .replace(/\s+/g, " ")
    .trim()
    .replace(PREFIXED_SECRET, "[redacted]")
    .replace(OPAQUE_RUN, (run) => (readsAsWords(run) ? run : "[redacted]"));
  return collapsed.length > MAX_DIAGNOSTIC_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : collapsed;
}

/** Which attention a failure deserves. Auth needs the user; the rest is runtime noise. */
export function attentionReasonFor(failure: RuntimeFailure): AttentionObservation["reason"] {
  return ATTENTION_REASON[failure.reason];
}

/**
 * Which of the runtime's recoveries a refusal is asking for.
 *
 * Reasoning is read first because it is the most specific sentence and
 * because the text around it mentions headers and settings that the broader
 * signals could mistake for their own. Auth failures need explicit user
 * recovery; everything else is a model failure.
 *
 * A leading gateway or overload status is a model failure whatever its body
 * says: the body of a 502 is a CDN's HTML page, and whatever words it happens
 * to contain are not the provider refusing anybody's credentials.
 */
export function classifyDiagnostic(sanitized: string): RuntimeFailure["reason"] {
  if (REASONING_SIGNAL.test(sanitized)) return "reasoning";
  if (CONTEXT_SIGNAL.test(sanitized)) return "context";
  const status = leadingStatus(sanitized);
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return "model";
  return AUTH_SIGNAL.test(sanitized) ? "auth" : "model";
}

/**
 * Whether the run died of its transport, or of a provider that could not
 * answer right now, rather than of anything about itself.
 *
 * The reason gate is load-bearing, not decoration: a socket the provider closed
 * over credentials carries both signals, and {@link classifyDiagnostic} has
 * already settled that argument in auth's favour by the time this reads it.
 *
 * A spent allowance is ruled out before anything else is asked, so a quota
 * `429` stays the person's to answer while a throttling `429` — "slow down",
 * which the next window answers — is retried.
 */
export function isTransientTransportFailure(failure: RuntimeFailure): boolean {
  if (failure.reason !== "model") return false;
  const text = failure.message;
  if (QUOTA_SIGNAL.test(text)) return false;
  const status = leadingStatus(text);
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true;
  if (status === 429 || THROTTLE_SIGNAL.test(text)) return true;
  // Any other 4xx is the provider refusing THIS request, and whatever words
  // its body quotes back — a tool's `timeout` parameter, a field named
  // `network` — are about the request, not the wire.
  if (status !== undefined && status >= 400 && status < 500) return false;
  return TRANSPORT_SIGNAL.test(text);
}

/**
 * A credential refresh that never reached the server that would have judged it.
 *
 * Classified as auth, and kept out of {@link isTransientTransportFailure} on
 * purpose: online, a refresh that failed is the person's to repair. The one
 * thing this adds is that the runtime may wait it out while the machine is
 * OFFLINE — a laptop opened hours later with no Wi-Fi finds its token expired
 * and its refresh unable to leave the building, and nothing about the
 * credential has been refused.
 */
export function isUnreachedAuthFailure(failure: RuntimeFailure): boolean {
  return failure.reason === "auth" && TRANSPORT_SIGNAL.test(failure.message);
}

/**
 * How long the provider asked to be left alone, when its sentence says.
 *
 * pi-ai folds a `retry-after` header it would not wait out into the message
 * (`Server requested 120s retry delay (max: 60s)`), and providers state their
 * own (`Please try again in 20s`, `retry after 1.5 seconds`). Headers never
 * reach this runtime otherwise, so the sentence is the only place the hint is.
 */
export function retryHintMs(message: string): number | undefined {
  const requested = /server requested (\d+(?:\.\d+)?)s retry delay/i.exec(message);
  if (requested !== null) return Number(requested[1]) * 1000;
  const stated =
    /(?:try again|retry) (?:in|after) (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i.exec(
      message,
    );
  if (stated === null) return undefined;
  const amount = Number(stated[1]);
  const unit = stated[2].toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("milli")) return amount;
  if (unit.startsWith("m")) return amount * 60_000;
  return amount * 1000;
}

/** Readable text for anything thrown across the Pi boundary. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The bounded recovery reference, or nothing when the session is not persisted. */
export function recoveryRefFor(
  sessionId: string,
  sessionFilePath: string | undefined,
): RuntimeRecoveryRef | undefined {
  return sessionFilePath === undefined ? undefined : { runtime: "pi", sessionId, sessionFilePath };
}

function usageOf(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): SanitizedUsage {
  // Cache reads and writes travel beside `input` rather than folded into it:
  // they are what the provider counts them as, and the sum of all four is the
  // context the model was actually holding when it answered — the number the
  // Session's context-usage surface is built on.
  //
  // Non-finite values are dropped rather than carried: a model with no cost
  // table multiplies through to a NaN total, JSON persists NaN as null, and
  // the recovery marker validator rightly refuses a null where a number
  // belongs. Every field is optional in SanitizedUsage for exactly this — an
  // absent number is honest, a poisoned marker is not (VC-155).
  return {
    ...(Number.isFinite(usage.input) ? { inputTokens: usage.input } : {}),
    ...(Number.isFinite(usage.output) ? { outputTokens: usage.output } : {}),
    ...(Number.isFinite(usage.cacheRead) ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(Number.isFinite(usage.cacheWrite) ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(Number.isFinite(usage.cost.total) ? { costUsd: usage.cost.total } : {}),
  };
}

/**
 * Which of Pi's API families price a request themselves, and which one is
 * merely repeating what a backend told it.
 *
 * Keyed by {@link KnownApi} rather than written as a condition, so a Pi upgrade
 * that adds an API family fails to compile here — which is the only place that
 * failure is cheap. The alternative is a new adapter silently inheriting
 * whichever basis the fallthrough happened to pick, and a report calling a
 * guess a bill.
 *
 * All nine of the direct adapters call Pi's own `calculateCost(model, usage)`,
 * multiplying provider token counts by the local model catalogue. That number
 * is right about consumption and only an estimate of the invoice — most
 * sharply for subscription-backed models, where the list-price value can be
 * calculated for traffic the person is not marginally billed for at all.
 * `pi-messages` is the exception: it copies the backend's own usage event
 * through untouched.
 */
const COST_BASIS_BY_API: Record<KnownApi, CostBasis> = {
  "openai-completions": "catalog-estimate",
  "mistral-conversations": "catalog-estimate",
  "openai-responses": "catalog-estimate",
  "azure-openai-responses": "catalog-estimate",
  "openai-codex-responses": "catalog-estimate",
  "anthropic-messages": "catalog-estimate",
  "bedrock-converse-stream": "catalog-estimate",
  "google-generative-ai": "catalog-estimate",
  "google-vertex": "catalog-estimate",
  "pi-messages": "provider-reported",
};

/**
 * How much to trust a cost from this API family. An unrecognised family — a
 * custom `models.json` provider, or an adapter newer than this build — is
 * `unavailable` rather than a guessed basis: a report that says it does not
 * know is recoverable, and one that quietly assumes is not.
 */
export function costBasisForApi(api: string): CostBasis {
  return COST_BASIS_BY_API[api as KnownApi] ?? "unavailable";
}

/** A measured count, or null when the provider reported nothing usable. */
function measured(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Which model was billed, from whichever Pi shape happens to be at hand. */
export interface BilledModel {
  provider: string;
  model: string;
  api: string;
}

/**
 * One Pi usage block, read as a Volli measurement.
 *
 * The single definition of that conversion, and it is single on purpose:
 * assistant replies and Context Compaction both produce one, and two spellings
 * would be one rule until the first time they disagreed about a NaN.
 *
 * Null means the provider metered nothing at all. Pi seeds every assistant
 * message with an all-zero usage placeholder and fills it when the provider
 * answers, so a block still carrying the seed describes a request nobody made
 * — recording it would pad every request count in every report. A request with
 * real tokens and a zero price is a different thing and is kept: free is a
 * measurement, and only an absent number is an absence.
 *
 * The block itself is optional because Pi's compaction result declares it so.
 * An absent block and an empty one mean the same thing here, which is why both
 * are answered in one place rather than guarded separately by each caller.
 */
export function sessionUsageFrom(
  usage: Usage | undefined,
  model: BilledModel,
  cause: SessionUsage["cause"],
): SessionUsage | null {
  if (usage === undefined) return null;
  const costUsd = measured(usage.cost.total);
  const measurements = {
    inputTokens: measured(usage.input),
    outputTokens: measured(usage.output),
    cacheReadTokens: measured(usage.cacheRead),
    cacheWriteTokens: measured(usage.cacheWrite),
    costUsd,
  };
  if (Object.values(measurements).every((value) => value === null || value === 0)) return null;
  return {
    cause,
    providerId: model.provider,
    modelId: model.model,
    ...measurements,
    // A cost that did not survive the finite check has no basis to report. The
    // tokens beside it are still true and still worth keeping.
    costBasis: costUsd === null ? "unavailable" : costBasisForApi(model.api),
  };
}

/**
 * What one model operation consumed, from any assistant message — settled,
 * tool-use-only, or failed.
 *
 * Deliberately separate from {@link classifyAssistantMessage}, which answers a
 * different question: whether the message says anything worth putting in a
 * transcript. Most agentic spend answers no. A turn is often several tool-use
 * replies and one short sentence, and usage read off the settled message alone
 * would report the sentence and lose the turn. A reply that failed has usually
 * been billed for its prompt before it failed.
 */
export function assistantUsage(message: AssistantMessage): SessionUsage | null {
  return sessionUsageFrom(
    message.usage,
    { provider: message.provider, model: message.model, api: message.api },
    "assistant",
  );
}

/**
 * Project one assistant message after Pi core has appended it to the JSONL
 * sidecar and supplied its stable entry identity.
 */
export function classifyAssistantMessage(
  entryId: string,
  message: AssistantMessage,
): AssistantMessageOutcome {
  if (message.stopReason === "aborted") {
    return {
      kind: "failed",
      failure: {
        reason: "aborted",
        message: sanitizeDiagnostic(message.errorMessage ?? "Run interrupted."),
      },
    };
  }

  if (message.stopReason === "error") {
    const detail = sanitizeDiagnostic(message.errorMessage ?? "The model run failed.");
    return { kind: "failed", failure: { reason: classifyDiagnostic(detail), message: detail } };
  }

  let text = "";
  let reasoning = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
    if (block.type === "thinking") {
      reasoning += block.thinking;
    }
  }

  if (text.length === 0 && reasoning.length === 0) {
    return { kind: "ignored" };
  }

  return {
    kind: "settled",
    message: {
      entryId,
      role: "assistant",
      text,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      model: { providerId: message.provider, modelId: message.model },
      usage: usageOf(message.usage),
    },
  };
}

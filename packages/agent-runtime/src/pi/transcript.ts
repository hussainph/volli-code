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

const MAX_DIAGNOSTIC_LENGTH = 300;

/** Long opaque runs are how provider keys and bearer tokens look in error text. */
const OPAQUE_SECRET = /[A-Za-z0-9_-]{24,}/g;
const PREFIXED_SECRET = /\b(?:sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]+/gi;
const AUTH_SIGNAL =
  /(api[ _-]?key|auth|credential|unauthorized|forbidden|login|sign[ _-]?in|not configured|401|403)/i;
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
 * How a connection that died mid-stream reads once the provider has rethrown
 * it. Deliberately narrower than pi-ai's own retry predicate: everything else a
 * model can fail with — a spent quota, a refused key, a payload it would build
 * the same way again — is answered by a person, and re-sending it just spends
 * another turn arriving at the same sentence.
 */
const TRANSPORT_SIGNAL =
  /(websocket|econnreset|etimedout|econnrefused|socket hang up|fetch failed|network|stream closed before)/i;

const ATTENTION_REASON: Record<RuntimeFailure["reason"], AttentionObservation["reason"]> = {
  auth: "auth",
  configuration: "configuration",
  context: "context",
  model: "runtime-failure",
  aborted: "runtime-failure",
  unknown: "runtime-failure",
};

/** Strip secret-shaped substrings and bound the length. Never returns raw provider text. */
export function sanitizeDiagnostic(raw: string): string {
  const collapsed = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(PREFIXED_SECRET, "[redacted]")
    .replace(OPAQUE_SECRET, "[redacted]");
  return collapsed.length > MAX_DIAGNOSTIC_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : collapsed;
}

/** Which attention a failure deserves. Auth needs the user; the rest is runtime noise. */
export function attentionReasonFor(failure: RuntimeFailure): AttentionObservation["reason"] {
  return ATTENTION_REASON[failure.reason];
}

/** Auth failures need explicit user recovery; everything else is a model failure. */
export function classifyDiagnostic(sanitized: string): RuntimeFailure["reason"] {
  if (CONTEXT_SIGNAL.test(sanitized)) return "context";
  return AUTH_SIGNAL.test(sanitized) ? "auth" : "model";
}

/**
 * Whether the run died of its transport rather than of anything about itself.
 *
 * The reason gate is load-bearing, not decoration: a socket the provider closed
 * over credentials carries both signals, and {@link classifyDiagnostic} has
 * already settled that argument in auth's favour by the time this reads it.
 */
export function isTransientTransportFailure(failure: RuntimeFailure): boolean {
  return failure.reason === "model" && TRANSPORT_SIGNAL.test(failure.message);
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
 *
 * Null means the provider metered nothing at all. That is different from a
 * request that cost nothing, and different again from one whose price this
 * build cannot vouch for — those come back as a record with `costUsd: null`.
 */
export function assistantUsage(message: AssistantMessage): SessionUsage | null {
  const usage: Usage = message.usage;
  const inputTokens = measured(usage.input);
  const outputTokens = measured(usage.output);
  const cacheReadTokens = measured(usage.cacheRead);
  const cacheWriteTokens = measured(usage.cacheWrite);
  const costUsd = measured(usage.cost.total);
  // Pi seeds every assistant message with an all-zero usage placeholder and
  // fills it when the provider answers. A message still carrying the seed was
  // never metered, and recording it would pad every request count with
  // requests nobody made. A request with real tokens and a zero price is a
  // different thing and is kept: free is a measurement.
  const metered =
    (inputTokens ?? 0) !== 0 ||
    (outputTokens ?? 0) !== 0 ||
    (cacheReadTokens ?? 0) !== 0 ||
    (cacheWriteTokens ?? 0) !== 0 ||
    (costUsd ?? 0) !== 0;
  if (!metered) return null;
  return {
    cause: "assistant",
    providerId: message.provider,
    modelId: message.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    // A cost that did not survive the finite check has no basis to report. The
    // tokens beside it are still true and still worth keeping.
    costBasis: costUsd === null ? "unavailable" : costBasisForApi(message.api),
  };
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

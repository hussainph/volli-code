/**
 * Pure projection of settled Pi assistant messages into Volli observations.
 *
 * Pi's durable history is the JSONL session tree, so a settled message is
 * identified by its session entry — not by its position in a live message
 * array. Keeping the projection pure here means the live runtime never has to
 * reason about Pi content shapes, and every mapping arm is testable without a
 * model.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AttentionObservation,
  RuntimeFailure,
  RuntimeRecoveryRef,
  SanitizedUsage,
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
const CONTEXT_SIGNAL = /(context (?:length|limit|window)|too many tokens|maximum tokens)/i;
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
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.cost.total,
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

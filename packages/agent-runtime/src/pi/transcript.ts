/**
 * Pure projection of Pi session entries into Volli observation payloads.
 *
 * Pi's durable history is the JSONL session tree, so a settled message is
 * identified by its session entry — not by its position in a live message
 * array. Keeping the projection pure here means the live runtime never has to
 * reason about Pi content shapes, and every mapping arm is testable without a
 * model.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AttentionObservation,
  RuntimeFailure,
  RuntimeRecoveryRef,
  SanitizedUsage,
  SettledAssistantMessage,
} from "../contracts";

export type SessionEntryOutcome =
  | { kind: "settled"; message: SettledAssistantMessage }
  | { kind: "failed"; failure: RuntimeFailure };

const MAX_DIAGNOSTIC_LENGTH = 300;

/** Long opaque runs are how provider keys and bearer tokens look in error text. */
const OPAQUE_SECRET = /[A-Za-z0-9_-]{24,}/g;
const PREFIXED_SECRET = /\b(?:sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]+/gi;
const AUTH_SIGNAL =
  /(api[ _-]?key|auth|credential|unauthorized|forbidden|login|sign[ _-]?in|401|403)/i;

const ATTENTION_REASON: Record<RuntimeFailure["reason"], AttentionObservation["reason"]> = {
  auth: "auth",
  configuration: "configuration",
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
  return AUTH_SIGNAL.test(sanitized) ? "auth" : "model";
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
  cost: { total: number };
}): SanitizedUsage {
  return { inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost.total };
}

/**
 * Project one durable entry. Returns nothing for entries that are not assistant
 * messages — user turns, tool results, and Pi's own bookkeeping entries.
 */
export function classifySessionEntry(entry: SessionEntry): SessionEntryOutcome | undefined {
  if (entry.type !== "message") {
    return undefined;
  }
  const message = entry.message;
  if (message.role !== "assistant") {
    return undefined;
  }

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

  return {
    kind: "settled",
    message: {
      entryId: entry.id,
      role: "assistant",
      text,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      model: { providerId: message.provider, modelId: message.model },
      usage: usageOf(message.usage),
    },
  };
}

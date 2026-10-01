/** One policy for provider, compaction and runtime diagnostic prose. */
import { redactPayloadSecrets, type SessionRuntimeSpec } from "@volli/shared";
import { redactCredentialText } from "./secrets";
export type DiagnosticRedactionPort = SessionRuntimeSpec["credentialRedaction"];
type RedactionPort = DiagnosticRedactionPort;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonemptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
/**
 * Long enough for a provider's whole refusal, including the sentence that
 * says what to do about it. Anthropic's preserved-thinking 400 runs to about
 * 360 characters once its envelope is off, and the clause that names what
 * changed is the last one; 300 cut it (VC-242).
 */
const MAX_DIAGNOSTIC_LENGTH = 400;

/** Long opaque runs are how provider keys and bearer tokens look in error text. */
const OPAQUE_RUN = /[A-Za-z0-9_-]{24,}/g;
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

/** Extract only the error sentence; never retain envelopes or echoed request bodies.
 * Credential matching runs before bounding, through the VC-481 owner and the
 * shared redactor. Ambiguous structured/request material is withheld, not guessed.
 */
export function safeStopMessage(raw: string, port?: RedactionPort): string {
  const status = /^(\d{3})(?=[\s:]|$)/.exec(raw)?.[1];
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const body = record(JSON.parse(raw.slice(start)));
      raw =
        nonemptyText(record(body["error"])["message"]) ??
        nonemptyText(body["message"]) ??
        "Provider error (no message stated).";
    } catch {
      return "[Provider text withheld: possible request content.]";
    }
  }
  if (
    /[{}]|\b(?:request|body|prompt|input|messages|headers)\s*(?:body\s*)?[:=]|\b(?:echoed|received|submitted|supplied)\s+(?:request|prompt|input|body)\b/i.test(
      raw,
    )
  )
    return "[Provider text withheld: possible request content.]";
  const safe = normalizeDiagnostic(
    redactPayloadSecrets(port === undefined ? raw : redactCredentialText(raw, port)).replace(
      /https?:\/\/\S+/gi,
      "[redacted URL]",
    ),
  );
  return start >= 0 && status !== undefined ? normalizeDiagnostic(`${status} ${safe}`) : safe;
}

function normalizeDiagnostic(raw: string): string {
  const collapsed = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(OPAQUE_RUN, (run) => (readsAsWords(run) ? run : "[redacted]"));
  return collapsed.length > MAX_DIAGNOSTIC_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : collapsed;
}

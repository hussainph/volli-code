/** One policy for provider, compaction and runtime diagnostic prose. */
import {
  isSensitiveKey,
  redactPayloadSecrets,
  type SessionRuntimeSpec,
  type SessionStopCategory,
} from "@volli/shared";
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
/**
 * The machine-local copy of a provider failure (VC-1244) keeps the whole
 * envelope, so it gets room for one; still bounded, so a provider that echoes
 * a request body cannot fill the support report with it.
 */
const MAX_LOCAL_DIAGNOSTIC_LENGTH = 2000;

const WITHHELD = "[Provider text withheld: possible request content.]";

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
 * Provider-minted identifiers that name a tool call, a message, a response or
 * a request (VC-1244): `toolu_…`/`srvtoolu_…` (Anthropic tool use), `call_…`
 * and `fc_…` (OpenAI function calls), `req_…` (request ids), `msg_…` and
 * `resp_…`. They are opaque by design, and they are exactly what a person
 * needs to find the call or quote the request to the provider. No credential
 * format any provider issues begins with one of these prefixes; real keys
 * (`sk-…`, `sk-ant-…`, `ghp_…`, JWTs, bare hex) still redact.
 */
const PROVIDER_ID = /^(?:srvtoolu|toolu|call|fc|req|msg|resp)_[A-Za-z0-9]+$/;
/**
 * Providers' public documentation hosts (VC-1244). An error that says "see
 * https://docs.anthropic.com/…" is pointing at its own fix; a URL anywhere
 * else may carry a signed query or a private host, so it still redacts.
 */
const DOCUMENTATION_HOSTS = [
  "docs.anthropic.com",
  "docs.claude.com",
  "support.anthropic.com",
  "platform.openai.com",
  "help.openai.com",
  "ai.google.dev",
  "cloud.google.com",
  "docs.mistral.ai",
  "docs.x.ai",
  "openrouter.ai",
  "learn.microsoft.com",
  "docs.aws.amazon.com",
];
/** `file://` too: a stack frame's URL names a home directory, never a fix. */
const URL_TEXT = /((?:https?|file):\/\/\S+)/i;
/**
 * Where a stack trace starts inside a provider or SDK sentence: Pi's OAuth
 * errors append `stack=Error: …`, and a stringified error appends `\n    at
 * fn (file:///Users/…)`. A stop sentence ends there; frames name this
 * machine's paths and say nothing a person can act on.
 */
const STACK_TRACE = /(?:[;,]?\s*\bstack=|\n\s*at\s)[\s\S]*$/;
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]'"`>]+$/;

/**
 * What echoed request content looks like, as opposed to a provider naming the
 * request field it rejected. `messages.3.content.0: …`, `messages: text
 * content blocks must be non-empty`, `Input: tools.0.custom.input_schema` and
 * `request body: missing field model` are provider sentences about a path, and
 * every one of them survives (VC-1244). What does not survive is a message
 * structure (`"role": "user"`), a quoted request field holding a value
 * (`"messages": [`, `"content": "…"`), a long
 * quoted span, or a provider saying outright that it is echoing what it got.
 */
const ECHOED_REQUEST = [
  /(["'])role\1\s*:\s*(["'])(?:user|assistant|system|developer|tool)\2/i,
  /(["'])(?:messages|content|text|prompt|input|instructions|arguments)\1\s*:\s*["'[{]/i,
  /"(?:[^"\\]|\\.){120,}"|`[^`]{120,}`/,
  /\b(?:echoed|received|submitted|supplied)\s+(?:request|prompt|input|body)\s*:/i,
];

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

/** A documentation link on a provider's own host, with no userinfo and no query. */
function isDocumentationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    !/[?@]/.test(url) &&
    parsed.port === "" &&
    DOCUMENTATION_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    )
  );
}

function safeUrl(text: string): string {
  const trailing = URL_TRAILING_PUNCTUATION.exec(text)?.[0] ?? "";
  const url = text.slice(0, text.length - trailing.length);
  return isDocumentationUrl(url) ? text : "[redacted URL]";
}

/**
 * The first balanced JSON object in `raw`, with where it starts and ends.
 *
 * SDKs wrap the provider's body in their own prose — `400 {…}`, `Codex error:
 * {…}`, `{…} (request id req_…)` — so the envelope is found by matching braces
 * outside strings rather than by parsing from the first brace to the end.
 * `null` when there is no brace, no balanced object, or the balanced span is
 * not JSON; the text is then read as prose.
 */
export function firstJsonObject(
  raw: string,
): { value: Record<string, unknown>; start: number; end: number } | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: record(JSON.parse(raw.slice(start, index + 1))), start, end: index + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** A field value short and plain enough to name in a summary: a code, never prose. */
function summaryValue(value: unknown): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === "string" && /^[\w.-]{1,64}$/.test(text) ? text : null;
}

/**
 * The provider's own sentence from an error envelope: `error.message`,
 * `message`, `detail` or a string `error`, in that order. An envelope that
 * states none still names what it is — `type`, `code`, `status` — and that
 * summary beats "no message stated" (VC-1244). Nothing else in the object is
 * read: an envelope can carry the request it rejected beside its error.
 */
function envelopeMessage(body: Record<string, unknown>): string {
  const error = record(body["error"]);
  const stated =
    nonemptyText(error["message"]) ??
    nonemptyText(body["message"]) ??
    nonemptyText(body["detail"]) ??
    nonemptyText(body["error"]);
  if (stated !== null) return stated;
  const parts = (["type", "code", "status"] as const).flatMap((field) => {
    const value = summaryValue(error[field]) ?? summaryValue(body[field]);
    return value === null ? [] : [`${field} ${value}`];
  });
  return parts.length === 0
    ? "Provider error (no message stated)."
    : `Provider error (${parts.join(", ")}).`;
}

/** Extract the error sentence; never retain envelopes or echoed request bodies.
 * Credential matching runs before bounding, through the VC-481 owner and the
 * shared redactor. Text that reads as an echoed request is withheld; a
 * provider naming a request path is not (VC-1244).
 */
export function safeStopMessage(raw: string, port?: RedactionPort): string {
  raw = raw.replace(STACK_TRACE, "");
  let text = raw;
  const envelope = firstJsonObject(raw);
  if (envelope !== null) {
    // `503: {…}` keeps the status in front, as `503 …`: the auth and retry
    // classifiers read it there.
    const lead = raw
      .slice(0, envelope.start)
      .trim()
      .replace(/^(\d{3})\s*:$/, "$1");
    const trail = raw.slice(envelope.end).trim();
    text = [lead, envelopeMessage(envelope.value), trail].filter((part) => part !== "").join(" ");
  }
  if (ECHOED_REQUEST.some((pattern) => pattern.test(text))) return WITHHELD;
  return scrubDiagnostic(text, port, MAX_DIAGNOSTIC_LENGTH);
}

/** A typed program exception is not a provider envelope. In particular JSON
 * syntax errors can contain braces; never try to parse the exception as JSON.
 * Redact the complete cause before bounding, independently of display output. */
export function safeProgramErrorMessage(raw: string, port?: RedactionPort): string {
  return scrubDiagnostic(raw, port, MAX_DIAGNOSTIC_LENGTH);
}

/**
 * One failed provider request as this machine saw it (VC-1244). Held by the
 * host in memory for its support report, never written to a Session, an
 * observation, a notice or anything that syncs: `raw` keeps the envelope the
 * Session's own stop sentence was extracted from.
 */
export interface ProviderFailureDiagnostic {
  /** When the failed reply ended, in epoch milliseconds. */
  at: number;
  provider: string;
  model: string;
  category: SessionStopCategory;
  httpStatus: number | null;
  /** {@link localProviderDiagnostic}'s text: credential-redacted and bounded. */
  raw: string;
}

/** Where a runtime hands each {@link ProviderFailureDiagnostic}; must not throw into a turn. */
export type ProviderDiagnosticSink = (diagnostic: ProviderFailureDiagnostic) => void;

/**
 * The provider's failure as it arrived, for this machine's support report only
 * (VC-1244): envelope and all, credential-redacted and bounded, with nothing
 * extracted or withheld. Never a Session fact — the caller hands it to the
 * host's local diagnostics and nowhere else.
 */
export function localProviderDiagnostic(raw: string, port?: RedactionPort): string {
  return scrubDiagnostic(raw, port, MAX_LOCAL_DIAGNOSTIC_LENGTH);
}

/**
 * A JSON field named like a credential (`"password": "…"`, `"api_key": …`).
 * The shared redactor reads `name=value` and `name: value`; an envelope that
 * echoes its request quotes the name, which that assignment rule never sees.
 */
const QUOTED_FIELD = /"([A-Za-z_][\w-]*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,{}[\]"]+)/g;

function redactQuotedFields(text: string): string {
  return text.replace(QUOTED_FIELD, (field: string, name: string, colon: string) =>
    isSensitiveKey(name) ? `"${name}"${colon}"[redacted]"` : field,
  );
}

function scrubDiagnostic(raw: string, port: RedactionPort | undefined, limit: number): string {
  const redacted = redactPayloadSecrets(
    redactQuotedFields(port === undefined ? raw : redactCredentialText(raw, port)),
  );
  const collapsed = redacted
    .replace(/\s+/g, " ")
    .trim()
    .split(URL_TEXT)
    // `split` with a capture group puts each URL at an odd index.
    .map((part, index) =>
      index % 2 === 1
        ? safeUrl(part)
        : part.replace(OPAQUE_RUN, (run) =>
            readsAsWords(run) || PROVIDER_ID.test(run) ? run : "[redacted]",
          ),
    )
    .join("");
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

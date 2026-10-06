/**
 * The structured log's vocabulary (VC-699): one JSON object per line, the same
 * shape on every host and in every viewer.
 *
 * A record carries `ts` (ISO 8601), `level`, `msg` and `component`, then any
 * fields. A field names identifiers and counts, never a secret, a prompt, file
 * contents or a request payload; the host's logger redacts what slips through
 * (`redactLogFields`), but the rule is the caller's first.
 *
 * Correlation travels in well-known fields ({@link LOG_CORRELATION_FIELDS}):
 * a trace minted where a person started an operation (`traceId`), the hop
 * that carried it (`spanId`), and the durable ids it touched (`sessionId`,
 * `turnId`, `commandId`, `ticketId`). A viewer joins lines from several hosts
 * on them; the host never interprets them.
 *
 * Pure: the host's logger (`@volli/host-core/log`), the renderer's viewer and
 * the router's wire schema all read this one module.
 */
import { isSensitiveKey, redactPayloadSecrets } from "./secret-redaction";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Higher is louder. A logger at `info` writes `info`, `warn` and `error`. */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** `value`, when it names a level; otherwise `fallback`. For `VOLLI_LOG_LEVEL` and its kin. */
export function logLevelFrom(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  return isLogLevel(value) ? value : fallback;
}

/** Whether a line at `level` passes a floor of `floor`. */
export function logLevelPasses(level: LogLevel, floor: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[floor];
}

/** What a field may hold once it is written: JSON, nothing else. */
export type LogValue =
  | null
  | boolean
  | number
  | string
  | LogValue[]
  | { [field: string]: LogValue };

/** One line, parsed. The four named keys are always present and never forged by a field. */
export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly component: string;
  readonly [field: string]: LogValue;
}

/** The keys a field can never set: the logger writes them itself. */
export const LOG_RESERVED_KEYS = ["ts", "level", "msg", "component"] as const;

/**
 * The fields a viewer joins lines on, across hosts. Each is an identifier the
 * product already minted (a trace is minted for exactly this), never content.
 */
export const LOG_CORRELATION_FIELDS = [
  "traceId",
  "spanId",
  "sessionId",
  "turnId",
  "commandId",
  "ticketId",
  "projectId",
] as const;
export type LogCorrelationField = (typeof LOG_CORRELATION_FIELDS)[number];

/* --------------------------------------------------------------- tracing */

/**
 * A trace: 16 random bytes as 32 lowercase hex characters, W3C Trace Context's
 * `trace-id` shape, so an exporter can hand it on unchanged. Minted once where
 * a person starts an operation and carried by every hop.
 */
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
/** One hop of a trace (a request, a door crossing): 8 random bytes as 16 hex characters. */
export const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value) && !/^0+$/u.test(value);
}

export function isSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_PATTERN.test(value) && !/^0+$/u.test(value);
}

/** What a request carries across a door: the operation's trace, and the hop that sent it. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * The trace a peer sent, when it is well formed; `null` otherwise. A host
 * never trusts a malformed one into its logs: it mints its own instead.
 */
export function readTraceContext(value: unknown): TraceContext | null {
  if (typeof value !== "object" || value === null) return null;
  const { traceId, spanId } = value as { traceId?: unknown; spanId?: unknown };
  return isTraceId(traceId) && isSpanId(spanId) ? { traceId, spanId } : null;
}

/** Lowercase hex of `bytes`: how trace and span ids are written. */
export function hexOfBytes(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/* ------------------------------------------------------------- redaction */

/** What replaces a value a field may not carry. */
export const LOG_REDACTED = "[redacted]";

/**
 * Bounds on one record's fields, so an accidental payload costs a line, not
 * the log: a string is cut, a deep object is summarised, a long array is cut.
 */
export const LOG_FIELD_BOUNDS = Object.freeze({
  /** Characters in one string (the message included). */
  maxString: 2_000,
  /** Object/array nesting below the record. */
  maxDepth: 5,
  /** Items kept from one array. */
  maxArray: 50,
  /** Keys kept from one object. */
  maxKeys: 50,
});

/**
 * A field whose name says it holds a credential. The shared secret-key rule
 * (`isSensitiveKey`: tokens, passwords, secrets, authorization, credentials,
 * prefixed keys) plus what a log adds: cookies, and a bare `key`, which in a
 * log line is more often a key than a keyboard's.
 */
export function isSensitiveLogKey(name: string): boolean {
  return isSensitiveKey(name) || /cookie|passphrase|^key$|keys?$/iu.test(name);
}

/**
 * One field's value, made safe to write: JSON only, bounded, credentials
 * removed. A sensitive name keeps a number, a boolean or null (a count is
 * not a secret: `inputTokens: 120`) and loses anything else. Strings are
 * scrubbed of credential-shaped text (bearer tokens, prefixed API keys, PEM
 * blocks, URL userinfo) whatever their name. An `Error` keeps its name,
 * message and code, never its cause.
 */
export function redactLogValue(value: unknown, depth = 0): LogValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "string":
      return redactLogText(value);
    case "symbol":
    case "function":
      return `[${typeof value}]`;
  }
  if (value instanceof Error) return redactError(value, depth);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (depth >= LOG_FIELD_BOUNDS.maxDepth) return Array.isArray(value) ? "[array]" : "[object]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, LOG_FIELD_BOUNDS.maxArray)
      .map((item: unknown) => redactLogValue(item, depth + 1));
    if (value.length > LOG_FIELD_BOUNDS.maxArray) {
      items.push(`[+${value.length - LOG_FIELD_BOUNDS.maxArray} more]`);
    }
    return items;
  }
  if (value instanceof Map) return redactLogFields(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return redactLogValue([...value], depth);
  return redactLogFields(value as Record<string, unknown>, depth + 1);
}

/** An object's fields, each through {@link redactLogValue}; sensitive names lose their value. */
export function redactLogFields(
  fields: Readonly<Record<string, unknown>>,
  depth = 0,
): { readonly [field: string]: LogValue } {
  const out: Record<string, LogValue> = {};
  let kept = 0;
  let skipped = 0;
  for (const name of Object.keys(fields)) {
    const value = fields[name];
    if (value === undefined) continue;
    if (kept >= LOG_FIELD_BOUNDS.maxKeys) {
      skipped += 1;
      continue;
    }
    kept += 1;
    out[name] =
      isSensitiveLogKey(name) && !isCountLike(value) ? LOG_REDACTED : redactLogValue(value, depth);
  }
  if (skipped > 0) out["…"] = `[+${skipped} more]`;
  return out;
}

/** A string a log may hold: credential-shaped text replaced, then cut to the bound. */
export function redactLogText(text: string): string {
  const scrubbed = redactPayloadSecrets(text);
  return scrubbed.length <= LOG_FIELD_BOUNDS.maxString
    ? scrubbed
    : `${scrubbed.slice(0, LOG_FIELD_BOUNDS.maxString - 1)}…`;
}

function isCountLike(value: unknown): boolean {
  return value === null || typeof value === "number" || typeof value === "boolean";
}

function redactError(error: Error, depth: number): LogValue {
  const out: Record<string, LogValue> = { name: error.name, message: redactLogText(error.message) };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number")
    out["code"] = redactLogValue(code, depth);
  return out;
}

/* ------------------------------------------------------- host.logs (wire) */

/** One line a host kept, with the cursor that names it (`<instance>:<seq>`, opaque to readers). */
export interface HostLogEntry {
  readonly cursor: string;
  readonly record: LogRecord;
}

/** What a reader asks of a host's recent log: lines after a cursor, at or above a level. */
export interface HostLogsQuery {
  /** Strictly after this cursor; absent, the newest lines. */
  readonly after?: string;
  /** At most this many (the host caps it). */
  readonly limit?: number;
  /** Lines at or above this level only. */
  readonly minLevel?: LogLevel;
}

/**
 * Lines, oldest first. `gap` says lines after the reader's cursor are gone
 * (evicted from the host's bounded memory, the host restarted, or more than
 * one answer holds): a reader never mistakes a gap for silence. `cursor` is
 * the newest line the host holds, to follow from.
 */
export interface HostLogsBatch {
  readonly entries: readonly HostLogEntry[];
  readonly gap: boolean;
  readonly cursor: string;
}

/* ------------------------------------------------- the renderer's lines */

/**
 * A line the renderer forwards to main's log (VC-699): its warnings, errors
 * and the host link's state changes. Main names it `renderer:<area>`, adds
 * the time, redacts it like any line, and bounds how many a window may send.
 */
export interface RendererLogEntry {
  readonly level: LogLevel;
  /** Where in the renderer: `console`, `window`, `host-link`, a feature's name. Lowercase, dotted or dashed. */
  readonly area: string;
  readonly msg: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  /** The operation it belongs to, when the renderer knows it. */
  readonly traceId?: string;
}

const RENDERER_AREA = /^[a-z][a-z0-9.-]{0,63}$/u;

/** The entry a renderer sent, when it is one; null otherwise. Main trusts nothing else. */
export function readRendererLogEntry(value: unknown): RendererLogEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { level, area, msg, fields, traceId } = value as Record<string, unknown>;
  if (!isLogLevel(level) || typeof area !== "string" || !RENDERER_AREA.test(area)) return null;
  if (typeof msg !== "string") return null;
  if (
    fields !== undefined &&
    (typeof fields !== "object" || fields === null || Array.isArray(fields))
  ) {
    return null;
  }
  return {
    level,
    area,
    msg,
    ...(fields === undefined ? {} : { fields: fields as Record<string, unknown> }),
    ...(isTraceId(traceId) ? { traceId } : {}),
  };
}

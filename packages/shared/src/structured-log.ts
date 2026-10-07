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
 * message, code and stack (scrubbed and cut), never its cause.
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
export function redactLogText(
  text: string,
  maxLength: number = LOG_FIELD_BOUNDS.maxString,
): string {
  // Scrubbed whole, then cut: cutting first could split a PEM block or a
  // token, and leave a half the scrubber no longer recognises.
  const scrubbed = redactQuotedAssignments(redactPayloadSecrets(text));
  return scrubbed.length <= maxLength ? scrubbed : `${scrubbed.slice(0, maxLength - 1)}…`;
}

/**
 * JSON-quoted credential assignments (`"token":"…"`, `"password": 123`): what
 * a stringified object leaves behind, which the shell-shaped scrubber does not
 * read as an assignment. Linear: the value is one JSON string or one bare
 * token; an object or array value is not consumed, so its own keys are read.
 */
const QUOTED_ASSIGNMENT =
  /"([A-Za-z_][\w.-]{0,63})"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,{}[\]"][^\s,}\]]*)/gu;

function redactQuotedAssignments(text: string): string {
  if (!text.includes('"')) return text;
  return text.replace(QUOTED_ASSIGNMENT, (match, name: string, separator: string) =>
    isSensitiveLogKey(name) ? `"${name}"${separator}"${LOG_REDACTED}"` : match,
  );
}

function isCountLike(value: unknown): boolean {
  return value === null || typeof value === "number" || typeof value === "boolean";
}

/**
 * Bounds on an `Error`'s strings in a log line. Each is scrubbed like any
 * other string (bearer tokens, prefixed keys, JWTs, URL credentials and query
 * tokens, quoted assignments) and cut: an error's text is the commonest way a
 * payload reaches a log.
 */
export const LOG_ERROR_BOUNDS = Object.freeze({
  /** `error.name`: a class name, normally a word. */
  maxName: 120,
  /** `error.message`. */
  maxMessage: 1_000,
  /** `error.stack`: where it was thrown. The first line repeats the message, scrubbed the same way. */
  maxStack: 2_000,
});

/**
 * An `Error` as a log field: `{name, message, code?, stack?}`, every string
 * scrubbed and cut ({@link LOG_ERROR_BOUNDS}). Never its cause, never any
 * other property: an error object is a common carrier of request payloads.
 *
 * The stack is kept on purpose (where it was thrown is the point of logging
 * an error), scrubbed and cut like the message it repeats.
 */
function redactError(error: Error, depth: number): LogValue {
  const out: Record<string, LogValue> = {
    name: redactLogText(String(error.name), LOG_ERROR_BOUNDS.maxName),
    message: redactLogText(String(error.message), LOG_ERROR_BOUNDS.maxMessage),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    out["code"] = typeof code === "number" ? redactLogValue(code, depth) : redactLogText(code, 120);
  }
  if (typeof error.stack === "string") {
    out["stack"] = redactLogText(error.stack, LOG_ERROR_BOUNDS.maxStack);
  }
  return out;
}

/** What a generic door keeps of an error it cannot vouch for: a class name and a stable code. */
export interface LogErrorSummary {
  readonly name: string;
  readonly code?: string | number;
}

const ERROR_NAME = /^[A-Za-z_$][\w$.]{0,63}$/u;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/u;

/**
 * An error, reduced to what is safe to log when nothing is known about where
 * its message came from: its class name when it looks like one, and its code
 * when it is a short identifier. Never its message, its stack or anything it
 * carries. For generic doors (an IPC failure, a renderer's console, a socket
 * request), whose errors may quote a file, a prompt or a request.
 */
export function logErrorSummary(error: unknown): LogErrorSummary {
  if (typeof error !== "object" || error === null) {
    return { name: typeof error === "string" ? "string" : typeof error };
  }
  const { name, code } = error as { name?: unknown; code?: unknown };
  const summary: { name: string; code?: string | number } = {
    name: typeof name === "string" && ERROR_NAME.test(name) ? name : "Error",
  };
  if (typeof code === "number" && Number.isFinite(code)) summary.code = code;
  else if (typeof code === "string" && ERROR_CODE.test(code)) summary.code = code;
  return summary;
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
 * A query as a door hands it to the host (VC-712): the reader's
 * {@link HostLogsQuery} plus the door's own byte budget. Never on the wire: a
 * reader cannot widen it; the door sets it from its frame bound.
 */
export interface HostLogsRead extends HostLogsQuery {
  /**
   * The largest answer, or followed batch, in UTF-8 bytes of its JSON (the
   * door's frame budget). The host selects the newest lines that fit, and an
   * answer that had to leave lines out says so (`gap`). Absent (the desktop's
   * in-process IPC): bounded by count alone.
   */
  readonly maxBytes?: number;
}

/**
 * Lines, oldest first. `gap` says lines after the reader's cursor are gone
 * (evicted from the host's bounded memory, the host restarted, or more than
 * one answer holds), or that lines it asked for were left out to keep the
 * answer inside the door's byte budget ({@link HostLogsRead.maxBytes}, a
 * tail included): a reader never mistakes a gap for silence. `cursor` is the
 * newest line the host holds, to follow from (a followed batch's: its own
 * newest line).
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
 *
 * Its shape is narrow on purpose. A message (one line, cut), and flat fields
 * of identifiers and counts: a string, a number, a boolean, or an error's
 * summary ({@link LogErrorSummary}). Nothing nested, nothing of unknown shape:
 * a console argument is never forwarded as data.
 */
export interface RendererLogEntry {
  readonly level: LogLevel;
  /** Where in the renderer: `console`, `window`, `host-link`, a feature's name. Lowercase, dotted or dashed. */
  readonly area: string;
  readonly msg: string;
  readonly fields?: Readonly<Record<string, RendererLogFieldValue>>;
  /** The operation it belongs to, when the renderer knows it. */
  readonly traceId?: string;
}

export type RendererLogFieldValue = string | number | boolean | null | LogErrorSummary;

/** The renderer's bounds, applied on both sides of the IPC door. */
export const RENDERER_LOG_BOUNDS = Object.freeze({
  /** Characters of the message, its first line only. */
  maxMsg: 300,
  /** Characters of one string field. */
  maxString: 200,
  /** Fields kept from one entry. */
  maxFields: 24,
});

const RENDERER_AREA = /^[a-z][a-z0-9.-]{0,63}$/u;
const RENDERER_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

/**
 * A renderer line's message: its first line, scrubbed, cut. A message is a
 * diagnostic sentence; whatever followed a newline (a stack, a dump) is not.
 */
export function rendererLogMessage(msg: string): string {
  const newline = msg.search(/[\r\n]/u);
  return redactLogText(newline === -1 ? msg : msg.slice(0, newline), RENDERER_LOG_BOUNDS.maxMsg);
}

/**
 * A renderer line's fields, made flat and safe: a credential-named field
 * loses its value, a string is scrubbed and cut, an `Error` (or anything
 * error-shaped) becomes its summary, and anything else (an object, an array,
 * a function) is dropped and counted. Run before the entry is serialised, in
 * the renderer, and again by main, which trusts nothing a window sends.
 */
export function rendererLogFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, RendererLogFieldValue> {
  const out: Record<string, RendererLogFieldValue> = {};
  let kept = 0;
  let dropped = 0;
  for (const name of Object.keys(fields)) {
    const value = fields[name];
    if (value === undefined) continue;
    if (kept >= RENDERER_LOG_BOUNDS.maxFields || !RENDERER_FIELD.test(name)) {
      dropped += 1;
      continue;
    }
    const safe = rendererFieldValue(name, value);
    if (safe === undefined) {
      dropped += 1;
      continue;
    }
    out[name] = safe;
    kept += 1;
  }
  if (dropped > 0) out["droppedFields"] = dropped;
  return out;
}

function rendererFieldValue(name: string, value: unknown): RendererLogFieldValue | undefined {
  if (isSensitiveLogKey(name) && !isCountLike(value)) return LOG_REDACTED;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return redactLogText(value, RENDERER_LOG_BOUNDS.maxString);
  if (value instanceof Error || isErrorShaped(value)) return logErrorSummary(value);
  return undefined;
}

function isErrorShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes("name") && keys.every((key) => key === "name" || key === "code");
}

/** The entry a renderer sent, made safe; null when it is not one. Main trusts nothing else. */
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
    msg: rendererLogMessage(msg),
    ...(fields === undefined
      ? {}
      : { fields: rendererLogFields(fields as Record<string, unknown>) }),
    ...(isTraceId(traceId) ? { traceId } : {}),
  };
}

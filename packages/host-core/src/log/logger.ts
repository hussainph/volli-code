/**
 * The host's logger port (VC-699): one JSON object per line, levelled,
 * component-named, correlated.
 *
 * A {@link Logger} formats nothing below its level: the level check runs
 * before a field is read, so a `debug` line on a hot path costs a comparison
 * when debug is off. A line that passes is built once ({@link buildLogRecord}:
 * the ambient correlation context, then the logger's own fields, then the
 * call's), redacted (`redactLogFields`), serialised once, and handed to the
 * {@link LogSink}: stdout for hostd's journal, a rotating file and an
 * in-memory ring for the desktop. Sinks never block: a sink that writes to
 * disk buffers.
 *
 * The host stays tenant-agnostic: host-core names no destination. A host
 * installs its sink once (`installHostLog`, `./root`), and every module's
 * logger resolves it at write time.
 */
import {
  LOG_CORRELATION_FIELDS,
  LOG_RESERVED_KEYS,
  logLevelPasses,
  redactLogFields,
  redactLogText,
  type LogLevel,
  type LogRecord,
  type LogValue,
} from "@volli/shared";

import { logContext } from "./context";

/** What a call passes: identifiers and counts. Never a secret, a prompt or a payload. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Where formatted lines go. `line` is `record` serialised, without its newline. */
export interface LogSink {
  write(record: LogRecord, line: string): void;
}

export interface Logger {
  /** The component every line from this logger names. */
  readonly component: string;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger whose lines also carry `fields`; a `component` field renames it. */
  child(fields: LogFields & { readonly component?: string }): Logger;
  /** Whether a line at `level` would be written: for a caller whose fields cost something to build. */
  enabled(level: LogLevel): boolean;
}

/** The destination and floor a logger writes through. */
export interface LogRoot {
  readonly level: LogLevel;
  readonly sink: LogSink;
  readonly now?: () => Date;
}

/**
 * One line's ceiling. Past it the line keeps its four named keys and its
 * correlation fields, and says how much it dropped: a log line is never a
 * transport for a payload.
 */
export const MAX_LOG_LINE_BYTES = 16 * 1024;

/** A logger over a fixed root: for a host's own boot, before or beside `installHostLog`. */
export function createLogger(
  options: LogRoot & { readonly component: string; readonly fields?: LogFields },
): Logger {
  const root: LogRoot = { level: options.level, sink: options.sink, now: options.now };
  return loggerOver(() => root, options.component, options.fields ?? {});
}

/** A logger that asks `resolve` for its root at every write. */
export function loggerOver(
  resolve: () => LogRoot,
  component: string,
  fields: LogFields = {},
): Logger {
  const emit =
    (level: LogLevel) =>
    (msg: string, callFields?: LogFields): void => {
      const root = resolve();
      if (!logLevelPasses(level, root.level)) return;
      const record = buildLogRecord({
        level,
        msg,
        component,
        now: (root.now ?? defaultNow)(),
        fields: [logContext(), fields, callFields ?? {}],
      });
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch {
        /* v8 ignore next 2 -- redaction leaves only JSON values; this guards a sink from a throw if it ever does not. */
        return;
      }
      root.sink.write(...bounded(record, line));
    };
  return {
    component,
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: ({ component: next, ...more }) =>
      loggerOver(resolve, next ?? component, { ...fields, ...more }),
    enabled: (level) => logLevelPasses(level, resolve().level),
  };
}

/**
 * One record: the named keys first, then the merged fields with a later layer
 * winning, every one redacted. A field can never forge `ts`, `level`, `msg`
 * or `component`.
 */
export function buildLogRecord(input: {
  readonly level: LogLevel;
  readonly msg: string;
  readonly component: string;
  readonly now: Date;
  readonly fields: readonly LogFields[];
}): LogRecord {
  const merged: Record<string, unknown> = {};
  for (const layer of input.fields) Object.assign(merged, layer);
  for (const key of LOG_RESERVED_KEYS) delete merged[key];
  return {
    ts: input.now.toISOString(),
    level: input.level,
    component: input.component,
    msg: redactLogText(input.msg),
    ...redactLogFields(merged),
  };
}

/** Characters a correlation identifier may have in a cut line: every real id is far shorter. */
const MAX_CUT_IDENTIFIER = 128;

/**
 * A line within {@link MAX_LOG_LINE_BYTES}, or the record cut to what
 * correlates it. The cut line is bounded by construction: the four named
 * keys (component and message cut), and each correlation field only when it
 * is a number or a short identifier. Every part is bounded in characters, and
 * UTF-8 spends at most three bytes on one, so the cut line fits the ceiling
 * whatever the fields held.
 */
function bounded(record: LogRecord, line: string): [LogRecord, string] {
  // UTF-8 spends at most three bytes per UTF-16 unit: a short line needs no count.
  if (line.length * 3 <= MAX_LOG_LINE_BYTES) return [record, line];
  const bytes = new TextEncoder().encode(line).byteLength;
  if (bytes <= MAX_LOG_LINE_BYTES) return [record, line];
  const kept: Record<string, LogValue> = {};
  for (const key of LOG_CORRELATION_FIELDS) {
    const value = record[key];
    if (typeof value === "number" || typeof value === "boolean") kept[key] = value;
    else if (typeof value === "string" && value.length <= MAX_CUT_IDENTIFIER) kept[key] = value;
  }
  const cut: LogRecord = {
    ts: record.ts,
    level: record.level,
    component: record.component.slice(0, MAX_CUT_IDENTIFIER),
    msg: record.msg.slice(0, 512),
    ...kept,
    truncated: true,
    bytes,
  };
  return [cut, JSON.stringify(cut)];
}

function defaultNow(): Date {
  return new Date();
}

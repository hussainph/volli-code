/**
 * The dev log viewer's model (VC-699): lines from every source, merged in time
 * order, filtered, and written back out as JSON lines.
 *
 * Pure: the viewer component holds the state and the sources feed it. A
 * source is this Mac (main, the in-process host and the renderer, read over
 * IPC) or a remote host (read over its host link's `host.logs`); every line
 * keeps the label of the machine that wrote it.
 */
import { logLevelPasses, type HostLogEntry, type LogLevel, type LogRecord } from "@volli/shared";

/** One line as the viewer holds it. */
export interface ViewerLine {
  /** Unique across sources: `<source>:<cursor>`. */
  readonly key: string;
  readonly source: string;
  readonly record: LogRecord;
}

/** At most this many lines are held; the oldest go first. */
export const VIEWER_LINE_CAP = 20_000;
/** At most this many matching lines are drawn: the newest. */
export const VIEWER_RENDER_CAP = 1_000;

export interface LogFilter {
  readonly minLevel: LogLevel;
  /** Empty: every component. */
  readonly component: string;
  readonly traceId: string;
  readonly sessionId: string;
  readonly ticketId: string;
  /** Matched against the message and every field, case-insensitively. */
  readonly text: string;
  /** Empty: every source. */
  readonly source: string;
}

export const EMPTY_FILTER: LogFilter = Object.freeze({
  minLevel: "debug",
  component: "",
  traceId: "",
  sessionId: "",
  ticketId: "",
  text: "",
  source: "",
});

/** A source's entries as viewer lines. */
export function linesOf(source: string, entries: readonly HostLogEntry[]): ViewerLine[] {
  return entries.map(({ cursor, record }) => ({ key: `${source}:${cursor}`, source, record }));
}

/**
 * `incoming` merged into `held` by time (`ts`, then arrival), dropping lines
 * already held and the oldest past `cap`. A source's lines arrive in order and
 * mostly after everything held, so the common case is an append.
 */
export function mergeLines(
  held: readonly ViewerLine[],
  incoming: readonly ViewerLine[],
  cap: number = VIEWER_LINE_CAP,
): ViewerLine[] {
  if (incoming.length === 0) return held as ViewerLine[];
  const seen = new Set(held.map((line) => line.key));
  const fresh = incoming.filter((line) => !seen.has(line.key));
  const last = held.at(-1)?.record.ts ?? "";
  const merged =
    fresh.every((line) => line.record.ts >= last) && isSorted(fresh)
      ? [...held, ...fresh]
      : [...held, ...fresh].toSorted((a, b) =>
          a.record.ts < b.record.ts ? -1 : a.record.ts > b.record.ts ? 1 : 0,
        );
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

function isSorted(lines: readonly ViewerLine[]): boolean {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.record.ts < lines[index - 1]!.record.ts) return false;
  }
  return true;
}

/** Whether a line passes every filter that is set. */
export function lineMatches(line: ViewerLine, filter: LogFilter): boolean {
  const { record } = line;
  if (!logLevelPasses(record.level, filter.minLevel)) return false;
  if (filter.source !== "" && line.source !== filter.source) return false;
  if (filter.component !== "" && record.component !== filter.component) return false;
  if (filter.traceId !== "" && record["traceId"] !== filter.traceId) return false;
  if (filter.sessionId !== "" && record["sessionId"] !== filter.sessionId) return false;
  if (filter.ticketId !== "" && record["ticketId"] !== filter.ticketId) return false;
  if (filter.text !== "") {
    const needle = filter.text.toLowerCase();
    if (!JSON.stringify(record).toLowerCase().includes(needle)) return false;
  }
  return true;
}

export function filterLines(lines: readonly ViewerLine[], filter: LogFilter): ViewerLine[] {
  return lines.filter((line) => lineMatches(line, filter));
}

/** Every component the held lines name, sorted. */
export function componentsOf(lines: readonly ViewerLine[]): string[] {
  return [...new Set(lines.map((line) => line.record.component))].toSorted();
}

/** What one trace spans: its lines, the machines it crossed, and how long it ran. */
export interface TraceSummary {
  readonly lines: number;
  readonly sources: readonly string[];
  readonly firstTs: string | null;
  readonly lastTs: string | null;
  readonly durationMs: number | null;
}

export function traceSummary(lines: readonly ViewerLine[], traceId: string): TraceSummary {
  const traced = lines.filter((line) => line.record["traceId"] === traceId);
  const firstTs = traced[0]?.record.ts ?? null;
  const lastTs = traced.at(-1)?.record.ts ?? null;
  return {
    lines: traced.length,
    sources: [...new Set(traced.map((line) => line.source))],
    firstTs,
    lastTs,
    durationMs:
      firstTs === null || lastTs === null ? null : Date.parse(lastTs) - Date.parse(firstTs),
  };
}

/** The lines as JSON lines, each naming its source: what Copy and Export write. */
export function toJsonl(lines: readonly ViewerLine[]): string {
  return lines.map((line) => JSON.stringify({ source: line.source, ...line.record })).join("\n");
}

/** The fields a row shows as chips, in order, when present. */
export const ROW_ID_FIELDS = ["traceId", "sessionId", "turnId", "commandId", "ticketId"] as const;

/** Fields worth reading inline after the message, when present: what happened, never who. */
export const ROW_DETAIL_FIELDS = [
  "step",
  "operation",
  "intent",
  "to",
  "status",
  "reason",
  "cause",
  "durationMs",
  "code",
] as const;

/** A row's inline detail: `step=probe durationMs=570`. */
export function rowDetail(record: LogRecord): string {
  return ROW_DETAIL_FIELDS.filter((field) => {
    const value = record[field];
    return typeof value === "string" || typeof value === "number";
  })
    .map((field) => `${field}=${String(record[field])}`)
    .join(" ");
}

/** A record's fields, without the four the row already shows. */
export function recordFields(record: LogRecord): Record<string, unknown> {
  const { ts: _ts, level: _level, component: _component, msg: _msg, ...fields } = record;
  return fields;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `HH:MM:SS.mmm` in local time, for a row. */
export function clockOf(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

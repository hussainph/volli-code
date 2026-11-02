/**
 * The perf store's hook into the stall monitors (VC-1092): a log sink that
 * keeps the stall lines and lets every other line pass by.
 *
 * The main stall monitor (`log/stall.ts`) and the renderer stall log each
 * write one line per stall; a sink beside the log file sees the same record
 * in memory as it is written, so the store ingests every stall without a
 * second call site in either monitor and without ever reading a log file
 * back. Whatever the monitors add to their lines later (a `label`, a
 * `sessionId`, a new attribution) reaches the store by the field names read
 * here, and a field a line lacks is simply absent from its row.
 *
 * The sink's cost on the logging path is two string comparisons for any other
 * line, and for a stall line building one small row and pushing it onto the
 * store's buffer: the write to disk happens later, off this path.
 *
 * What it reads, and nothing else:
 *
 * - `main-stall` / `main stall`: `durationMs`, `attribution` (the row's
 *   `kind`), `door` and `operation` (from the door call's context or the
 *   line's own fields; an unattributed stall is filed under
 *   `unattributed/unattributed`, as the hourly roll-up files it),
 *   `sessionId`, and as a hint `lastDoor`/`lastOperation` (an unattributed
 *   stall's last door call) or `parentDoor`/`parentOperation`.
 * - `renderer-stall` / `renderer stall`: `durationMs`, `kind` (`frame` or
 *   `input`), `operation`, `label` and `window`, under `door: "renderer"`.
 */
import type { LogRecord } from "@volli/shared";

import type { LogSink } from "../log/logger";
import type { PerfStallInput, PerfStore } from "./store";

const UNATTRIBUTED = "unattributed";

function text(record: LogRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(record: LogRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pair(door: string | null, operation: string | null): string | null {
  return door === null || operation === null ? null : `${door}/${operation}`;
}

/** A `main stall` line as a row, or null when it lacks a duration or a time. */
export function mainStallRow(record: LogRecord): PerfStallInput | null {
  const durationMs = number(record, "durationMs");
  const at = Date.parse(record.ts);
  if (durationMs === null || !Number.isFinite(at)) return null;
  const kind = text(record, "attribution") ?? "unknown";
  const unattributed = kind === UNATTRIBUTED;
  return {
    at,
    process: "main",
    kind,
    door: unattributed ? UNATTRIBUTED : (text(record, "door") ?? "unknown"),
    operation: unattributed ? UNATTRIBUTED : (text(record, "operation") ?? "unknown"),
    sessionId: text(record, "sessionId"),
    durationMs,
    hint:
      pair(text(record, "lastDoor"), text(record, "lastOperation")) ??
      pair(text(record, "parentDoor"), text(record, "parentOperation")),
  };
}

/** A `renderer stall` line as a row, or null when it lacks a duration or a time. */
export function rendererStallRow(record: LogRecord): PerfStallInput | null {
  const durationMs = number(record, "durationMs");
  const at = Date.parse(record.ts);
  if (durationMs === null || !Number.isFinite(at)) return null;
  return {
    at,
    process: "renderer",
    kind: text(record, "kind") ?? "unknown",
    door: "renderer",
    operation: text(record, "operation") ?? "unknown",
    label: text(record, "label"),
    windowId: number(record, "window"),
    durationMs,
  };
}

/** A sink that records every stall line into `store` and ignores everything else. */
export function perfStallSink(store: Pick<PerfStore, "record">): LogSink {
  return {
    write(record) {
      let row: PerfStallInput | null = null;
      if (record.component === "main-stall") {
        if (record.msg === "main stall") row = mainStallRow(record);
      } else if (record.component === "renderer-stall") {
        if (record.msg === "renderer stall") row = rendererStallRow(record);
      }
      if (row !== null) store.record(row);
    },
  };
}

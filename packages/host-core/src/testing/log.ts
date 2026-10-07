/**
 * Test support for the structured log (VC-699): capture what host loggers
 * write, as records, for the length of one test.
 *
 * ```ts
 * const log = captureHostLog();
 * afterEach(() => log.restore());
 * // …
 * expect(log.records).toContainEqual(expect.objectContaining({ component: "pty", msg: "spawn failed" }));
 * ```
 */
import type { LogLevel, LogRecord } from "@volli/shared";

import { installHostLog } from "../log/root";

export interface CapturedHostLog {
  /** Every record written since the capture began, in order. */
  readonly records: LogRecord[];
  /** The records one component wrote. */
  of(component: string): LogRecord[];
  /** Puts back whatever was installed before. */
  restore(): void;
}

/** Installs a capturing root at `level` (default `debug`): every host logger writes into it. */
export function captureHostLog(level: LogLevel = "debug"): CapturedHostLog {
  const records: LogRecord[] = [];
  const restore = installHostLog({ level, sink: { write: (record) => records.push(record) } });
  return {
    records,
    of: (component) => records.filter((record) => record.component === component),
    restore,
  };
}

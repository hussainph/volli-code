/**
 * The sinks every host composes from (VC-699). A sink takes a finished line
 * and never throws back into the code that logged it.
 */
import type { LogRecord } from "@volli/shared";

import type { LogSink } from "./logger";

/** One JSON line per record, newline-terminated: hostd's stdout, a pipe, a test's array. */
export function jsonLineSink(write: (line: string) => void): LogSink {
  return {
    write(_record, line) {
      try {
        write(`${line}\n`);
      } catch {
        // A closed stdout must not take the host down with the line.
      }
    },
  };
}

/** Every record to each sink in turn; one that throws does not stop the rest. */
export function teeSinks(...sinks: readonly LogSink[]): LogSink {
  return {
    write(record, line) {
      for (const sink of sinks) {
        try {
          sink.write(record, line);
        } catch {
          // Each sink owns its failure; the others still get the line.
        }
      }
    },
  };
}

const CONSOLE_METHOD = { debug: "debug", info: "info", warn: "warn", error: "error" } as const;

/**
 * A readable line on the console: `[component] msg` and the fields. For a
 * developer's terminal (`pnpm dev`) and for code no host has wired yet, never
 * a production destination.
 */
export function consoleSink(
  target: Pick<Console, "debug" | "info" | "warn" | "error"> = console,
): LogSink {
  return {
    write(record: LogRecord) {
      const { ts: _ts, level, component, msg, ...fields } = record;
      const text = `[${component}] ${msg}`;
      const method = target[CONSOLE_METHOD[level]].bind(target);
      if (Object.keys(fields).length === 0) method(text);
      else method(text, fields);
    },
  };
}

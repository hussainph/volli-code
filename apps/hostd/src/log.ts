/**
 * Structured logs: one JSON object per line, on stdout.
 *
 * systemd's journal and `launchd`'s log file both take a line stream, and a
 * JSON line is something `jq` and a log shipper read without a parser of our
 * own. The logger itself is host-core's (`@volli/host-core/log`, VC-699): every
 * line carries `ts` (ISO 8601), `level`, `component` and `msg`, the trace of
 * the request it belongs to, and its fields, redacted. A field never carries a
 * secret, a key byte or a request payload: callers pass identifiers and counts.
 */
import { format } from "node:util";

import { createLogger, jsonLineSink, type Logger } from "@volli/host-core/log";
import type { LogLevel } from "@volli/shared";

export { logLevelFrom } from "@volli/shared";
export type { LogLevel };

export type LogFields = Readonly<Record<string, unknown>>;

/** What hostd's own modules ask of a logger: the four levels. */
export type HostdLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

/** A JSON-lines logger for `component`, writing through `write`. */
export function createJsonLogger(options: {
  level: LogLevel;
  write: (line: string) => void;
  now?: () => Date;
  component?: string;
}): Logger {
  return createLogger({
    level: options.level,
    sink: jsonLineSink(options.write),
    now: options.now,
    component: options.component ?? "hostd",
  });
}

const line = (args: unknown[]): string => format(...args);

/**
 * Sends `console.*` through the logger, so anything still writing to the
 * console (a dependency, a line host-core has not moved yet) arrives as JSON
 * too rather than as bare text in the middle of the stream.
 */
export function routeConsole(logger: HostdLogger, target: Console = console): void {
  target.debug = (...args: unknown[]) => logger.debug(line(args), { source: "console" });
  target.log = (...args: unknown[]) => logger.info(line(args), { source: "console" });
  target.info = (...args: unknown[]) => logger.info(line(args), { source: "console" });
  target.warn = (...args: unknown[]) => logger.warn(line(args), { source: "console" });
  target.error = (...args: unknown[]) => logger.error(line(args), { source: "console" });
}

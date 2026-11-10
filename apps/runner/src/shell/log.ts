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

import {
  createLogRing,
  hostLogger,
  installHostLog,
  jsonLineSink,
  teeSinks,
  type Logger,
  type LogRing,
} from "@volli/host-core/log";
import type { LogLevel } from "@volli/shared";

import type { ShellIdentity } from "./identity";

export { logLevelFrom } from "@volli/shared";
export type { LogLevel };

/** What the shell's modules ask of a logger: the four levels. */
export type ShellLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

export interface ProcessLog {
  /** The daemon's own logger, its component the identity's file prefix. */
  readonly logger: Logger;
  /** The recent lines, bounded, in memory (VC-699): what `host.logs` reads. */
  readonly ring: LogRing;
}

/**
 * One destination for every line this process writes: the daemon's own and
 * every host-core module's, JSON lines through `write` (stdout, for the
 * journal), with the recent ones kept in memory too.
 */
export function installProcessLog(
  identity: ShellIdentity,
  level: LogLevel,
  write: (line: string) => void,
): ProcessLog {
  const ring = createLogRing();
  installHostLog({ level, sink: teeSinks(jsonLineSink(write), ring) });
  return { logger: hostLogger(identity.filePrefix), ring };
}

const line = (args: unknown[]): string => format(...args);

/**
 * Sends `console.*` through the logger, so anything still writing to the
 * console (a dependency, a line host-core has not moved yet) arrives as JSON
 * too rather than as bare text in the middle of the stream.
 */
export function routeConsole(logger: ShellLogger, target: Console = console): void {
  target.debug = (...args: unknown[]) => logger.debug(line(args), { source: "console" });
  target.log = (...args: unknown[]) => logger.info(line(args), { source: "console" });
  target.info = (...args: unknown[]) => logger.info(line(args), { source: "console" });
  target.warn = (...args: unknown[]) => logger.warn(line(args), { source: "console" });
  target.error = (...args: unknown[]) => logger.error(line(args), { source: "console" });
}

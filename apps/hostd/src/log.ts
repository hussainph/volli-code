/**
 * Structured logs: one JSON object per line, on stdout.
 *
 * systemd's journal and `launchd`'s log file both take a line stream, and a
 * JSON line is something `jq` and a log shipper read without a parser of our
 * own. Every line carries `ts` (ISO 8601), `level` and `msg`; anything else is
 * a field. A field never carries a secret, a key byte or a request payload:
 * callers pass identifiers and counts.
 */
import { format } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Readonly<Record<string, unknown>>;

export interface HostdLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** `VOLLI_HOSTD_LOG_LEVEL`, or `info` when unset or unrecognised. */
export function logLevelFrom(value: string | undefined): LogLevel {
  return value !== undefined && value in RANK ? (value as LogLevel) : "info";
}

export function createJsonLogger(options: {
  level: LogLevel;
  write: (line: string) => void;
  now?: () => Date;
}): HostdLogger {
  const now = options.now ?? (() => new Date());
  const floor = RANK[options.level];
  const emit =
    (level: LogLevel) =>
    (msg: string, fields: LogFields = {}): void => {
      if (RANK[level] < floor) return;
      // `ts`, `level` and `msg` are written last so a field can never forge them.
      options.write(
        `${JSON.stringify({ ...fields, ts: now().toISOString(), level, msg }, jsonSafe)}\n`,
      );
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** Errors become their message; everything else serialises as JSON would. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "bigint") return value.toString();
  return value;
}

const line = (args: unknown[]): string => format(...args);

/**
 * Sends `console.*` through the logger, so host-core's own `console.error`
 * and `console.info` lines arrive as JSON too rather than as bare text in the
 * middle of the stream.
 */
export function routeConsole(logger: HostdLogger, target: Console = console): void {
  target.debug = (...args: unknown[]) => logger.debug(line(args), { source: "console" });
  target.log = (...args: unknown[]) => logger.info(line(args), { source: "console" });
  target.info = (...args: unknown[]) => logger.info(line(args), { source: "console" });
  target.warn = (...args: unknown[]) => logger.warn(line(args), { source: "console" });
  target.error = (...args: unknown[]) => logger.error(line(args), { source: "console" });
}

/**
 * The logger this package writes to: the same shape as hostd's (`log.ts`),
 * one call per line with a message and flat fields, so VC-699's shared
 * logger drops in without a change here.
 *
 * Every line carries `component: "host-install"` and the host it is about.
 * No line ever carries a secret: a sudo password travels on a child's stdin
 * and is never a field, a command line or an error message; keys are public
 * halves or fingerprints.
 */
export type LogFields = Readonly<Record<string, unknown>>;

export interface InstallLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export const LOG_COMPONENT = "host-install";

/** `base`, with `component` and `fields` on every line; a call's own fields cannot replace them. */
export function componentLogger(base: InstallLogger, fields: LogFields = {}): InstallLogger {
  const bound = { ...fields, component: LOG_COMPONENT };
  const at =
    (level: keyof InstallLogger) =>
    (msg: string, own: LogFields = {}): void =>
      base[level](msg, { ...own, ...bound });
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** Says nothing. For callers with no log to give. */
export const SILENT_LOGGER: InstallLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

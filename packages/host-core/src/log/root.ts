/**
 * The host's one log destination (VC-699).
 *
 * Every host-core module takes its logger from {@link hostLogger}, named for
 * its component, at module scope. The logger resolves the installed root at
 * each write, so a module never holds a destination: the host installs one,
 * once, at boot ({@link installHostLog}: hostd's stdout, the desktop's file and
 * ring), and every module's lines go there from then on.
 *
 * Before a host installs anything (a unit test, a bench, a script), lines go
 * to the console at `warn` (or `VOLLI_LOG_LEVEL`): warnings and errors still
 * reach a terminal, and a test run is not a transcript of every Session fact.
 */
import { logLevelFrom, type LogLevel } from "@volli/shared";

import { consoleSink } from "./sinks";
import { loggerOver, type LogFields, type Logger, type LogRoot } from "./logger";

const CONSOLE_ROOT: LogRoot = Object.freeze({
  level: logLevelFrom(process.env["VOLLI_LOG_LEVEL"], "warn"),
  sink: consoleSink(),
});

let root: LogRoot = CONSOLE_ROOT;

/**
 * Makes `next` the destination for every host logger. Returns the undo: it
 * restores what was installed before, unless something replaced `next` since.
 */
export function installHostLog(next: LogRoot): () => void {
  const previous = root;
  root = next;
  return () => {
    if (root === next) root = previous;
  };
}

/** The level the installed root writes at. */
export function hostLogLevel(): LogLevel {
  return root.level;
}

/** A logger for one component, writing wherever the host installed its root. */
export function hostLogger(component: string, fields?: LogFields): Logger {
  return loggerOver(() => root, component, fields);
}

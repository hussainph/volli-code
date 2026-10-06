/**
 * The renderer's lines, written to this Mac's log by main (VC-699).
 *
 * Its own console warnings and errors, uncaught errors and unhandled
 * rejections go there as `renderer:console` and `renderer:window`, beside
 * main's and the host's lines, so one view shows what failed on every side
 * of an operation. A feature that wants a line of its own (a host link's
 * state, an install step) asks {@link rendererLog} for its area.
 *
 * Fire-and-forget: a line never waits, and a failure to send one is never
 * anyone's error. Main bounds how many a window may send.
 */
import type { LogLevel, RendererLogEntry } from "@volli/shared";

/** The preload door: `window.api.log`. */
export interface RendererLogDoor {
  write(entry: RendererLogEntry): void;
}

export type RendererLogger = {
  readonly [Level in LogLevel]: (
    msg: string,
    fields?: Readonly<Record<string, unknown>>,
    traceId?: string,
  ) => void;
};

function door(): RendererLogDoor | null {
  return (globalThis as { window?: { api?: { log?: RendererLogDoor } } }).window?.api?.log ?? null;
}

/** A logger for one area of the renderer. */
export function rendererLog(
  area: string,
  target: () => RendererLogDoor | null = door,
): RendererLogger {
  const send =
    (level: LogLevel) =>
    (msg: string, fields?: Readonly<Record<string, unknown>>, traceId?: string): void => {
      try {
        target()?.write({
          level,
          area,
          msg,
          ...(fields === undefined ? {} : { fields }),
          ...(traceId === undefined ? {} : { traceId }),
        });
      } catch {
        // A line that cannot be sent is not an error anyone can act on.
      }
    };
  return { debug: send("debug"), info: send("info"), warn: send("warn"), error: send("error") };
}

/** Console arguments as one line of text: what a person reading the log would see. */
export function consoleText(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

interface ForwardingTarget {
  readonly console: Pick<Console, "warn" | "error">;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: "unhandledrejection",
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}

/**
 * Sends this window's console warnings and errors, uncaught errors and
 * unhandled rejections to main's log. The console still prints them. Returns
 * the undo.
 */
export function installRendererLogForwarding(
  target: ForwardingTarget = globalThis as unknown as ForwardingTarget,
  sink: () => RendererLogDoor | null = door,
): () => void {
  const consoleLog = rendererLog("console", sink);
  const windowLog = rendererLog("window", sink);
  const { warn, error } = target.console;
  target.console.warn = (...args: unknown[]) => {
    warn.apply(target.console, args);
    consoleLog.warn(consoleText(args));
  };
  target.console.error = (...args: unknown[]) => {
    error.apply(target.console, args);
    consoleLog.error(consoleText(args));
  };
  const onError = (event: ErrorEvent): void =>
    windowLog.error(event.message, {
      error: event.error instanceof Error ? event.error : undefined,
      source: event.filename,
      line: event.lineno,
    });
  const onRejection = (event: PromiseRejectionEvent): void =>
    windowLog.error("unhandled rejection", { reason: consoleText([event.reason]) });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.console.warn = warn;
    target.console.error = error;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

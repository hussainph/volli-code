/**
 * The renderer's lines, written to this Mac's log by main (VC-699).
 *
 * Its own console warnings and errors, uncaught errors and unhandled
 * rejections go there as `renderer:console` and `renderer:window`, beside
 * main's and the host's lines, so one view shows what failed on every side
 * of an operation. A feature that wants a line of its own (a host link's
 * state, an install step) asks {@link rendererLog} for its area.
 *
 * Never content: a console call sends only its message (its first argument,
 * when that is text: first line, scrubbed, cut) and an error's summary;
 * the values a developer passed after it never leave the window. An uncaught
 * error or rejection sends its class name and code, never its message.
 * Messages known to quote a file are not sent at all.
 *
 * Fire-and-forget: a line never waits, and a failure to send one is never
 * anyone's error. Main bounds how many a window may send.
 */
import {
  logErrorSummary,
  rendererLogFields,
  rendererLogMessage,
  type LogLevel,
  type RendererLogEntry,
} from "@volli/shared";

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

/**
 * A logger for one area of the renderer. Its message and fields are made
 * safe here, before anything is serialised for IPC: a credential-named field
 * loses its value, strings are scrubbed and cut, an error becomes its
 * summary, and a nested value is dropped (`rendererLogFields`). Main does the
 * same again on arrival.
 */
export function rendererLog(
  area: string,
  target: () => RendererLogDoor | null = door,
): RendererLogger {
  const send =
    (level: LogLevel) =>
    (msg: string, fields?: Readonly<Record<string, unknown>>, traceId?: string): void => {
      try {
        const sink = target();
        if (sink === null) return;
        sink.write({
          level,
          area,
          msg: rendererLogMessage(msg),
          ...(fields === undefined ? {} : { fields: rendererLogFields(fields) }),
          ...(traceId === undefined ? {} : { traceId }),
        });
      } catch {
        // A line that cannot be sent is not an error anyone can act on.
      }
    };
  return { debug: send("debug"), info: send("info"), warn: send("warn"), error: send("error") };
}

/**
 * Console messages that quote what a person is working on, and so never
 * leave the window: the editor's tokenizer quoting a line of the file it was
 * highlighting (`shiki-monaco.ts` no longer does; Monaco's own TextMate
 * support still can).
 */
const CONTENT_BEARING_CONSOLE = [/tokeni[sz]ing line/iu];

/**
 * What a console call may send to the log: its message, when its first
 * argument is text (the sentence a developer wrote, never the values after
 * it), and how many arguments followed. An error among them is sent as its
 * summary: class name and code, never its message. Anything else of unknown
 * shape is never sent. Null when the call should not be forwarded at all.
 */
export function consoleEntry(
  args: readonly unknown[],
): { msg: string; fields: Record<string, unknown> } | null {
  const [first, ...rest] = args;
  const error = args.find((arg): arg is Error => arg instanceof Error);
  let msg: string;
  if (typeof first === "string") {
    if (CONTENT_BEARING_CONSOLE.some((pattern) => pattern.test(first))) return null;
    // A format string's substitutions (`%s`, `%o`) are values: left unfilled.
    msg = first;
  } else if (first instanceof Error) {
    msg = "console error object";
  } else {
    msg = "console message";
  }
  const fields: Record<string, unknown> = {
    args: typeof first === "string" ? rest.length : args.length,
  };
  if (error !== undefined) fields["error"] = logErrorSummary(error);
  return { msg, fields };
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
    const entry = consoleEntry(args);
    if (entry !== null) consoleLog.warn(entry.msg, entry.fields);
  };
  target.console.error = (...args: unknown[]) => {
    error.apply(target.console, args);
    const entry = consoleEntry(args);
    if (entry !== null) consoleLog.error(entry.msg, entry.fields);
  };
  // An uncaught error's message is the error's own text, which may quote
  // anything: the log keeps its summary and where it was thrown.
  const onError = (event: ErrorEvent): void =>
    windowLog.error("uncaught error", {
      error: logErrorSummary(event.error),
      source: event.filename,
      line: event.lineno,
    });
  const onRejection = (event: PromiseRejectionEvent): void =>
    windowLog.error("unhandled rejection", { reason: logErrorSummary(event.reason) });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.console.warn = warn;
    target.console.error = error;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** A host link's log event (`@volli/host-protocol/client-link`'s `HostLinkLogEvent`), structurally. */
export interface HostLinkLogLine {
  readonly kind: string;
  readonly traceId: string;
  readonly [field: string]: unknown;
}

const LINK_TROUBLE = new Set(["unreachable", "refused", "fenced"]);

/**
 * A host link's `log` option (VC-699): each state change, wake, resume and
 * resnapshot as a `renderer:host-link` line under the link's trace, so the
 * viewer shows a lid close and reopen beside the host's own lines. Pass it
 * when creating a link: `createHostLink({ …, traceId, log: hostLinkLog("box") })`.
 */
export function hostLinkLog(
  host: string,
  target: () => RendererLogDoor | null = door,
): (event: HostLinkLogLine) => void {
  const log = rendererLog("host-link", target);
  return ({ kind, traceId, ...fields }) => {
    const trouble =
      kind === "resnapshot" || (kind === "state" && LINK_TROUBLE.has(String(fields["to"])));
    log[trouble ? "warn" : "info"](
      kind === "state" ? "link state" : kind,
      { host, ...fields },
      traceId,
    );
  };
}

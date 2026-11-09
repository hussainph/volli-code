/**
 * The ambient correlation context (VC-699): which operation a line belongs to.
 *
 * A door (the WebSocket, Electron IPC, the agent socket) opens a context for
 * each request with {@link withTrace}: the trace the client minted when it
 * started the operation, or one minted here when it sent none, plus the door
 * and its connection. Lines logged on that request's own promise chain carry
 * those fields, because `AsyncLocalStorage` follows the promise chains and
 * timers the request starts. Code deeper in adds what it knows with
 * {@link withLogContext} (`sessionId`, `turnId`, `commandId`).
 *
 * **What it does not do on its own.** Anything long-lived a request happens
 * to start (an executor's attachment, its event listeners, an interval)
 * would inherit that request's trace forever, and log later, unrelated work
 * under it. Such producers start detached ({@link withRootLogContext}: their
 * own identifiers, no trace), and the work they do on a command's behalf is
 * joined to that command's trace explicitly (`./correlation`), or carries no
 * trace at all. A line never claims a trace it cannot vouch for.
 *
 * Only identifiers ride here, never content.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { hexOfBytes, readTraceContext, type TraceContext } from "@volli/shared";

/** Correlation fields: identifiers and small scalars only. An undefined one is left out of lines. */
export type LogContextFields = Readonly<Record<string, string | number | boolean | undefined>>;

const storage = new AsyncLocalStorage<LogContextFields>();
const EMPTY: LogContextFields = Object.freeze({});

/** The fields of the operation running now; empty outside any. */
export function logContext(): LogContextFields {
  return storage.getStore() ?? EMPTY;
}

/** Runs `fn` with `fields` added to the current context (a later field wins). */
export function withLogContext<Result>(fields: LogContextFields, fn: () => Result): Result {
  const current = storage.getStore();
  return storage.run(current === undefined ? { ...fields } : { ...current, ...fields }, fn);
}

/**
 * Runs `fn` in a fresh root context holding only `fields`: nothing of the
 * operation running now (its trace, span, door or connection) is inherited,
 * by `fn` or by anything it starts. For a long-lived producer a request
 * happens to start, and for work done on behalf of a different operation
 * than the one running.
 */
export function withRootLogContext<Result>(fields: LogContextFields, fn: () => Result): Result {
  return storage.run({ ...fields }, fn);
}

/** A fresh trace id: 16 random bytes, W3C `trace-id` shaped. */
export function mintTraceId(): string {
  return hexOfBytes(randomBytes(16));
}

/** A fresh span id: 8 random bytes, W3C `parent-id` shaped. */
export function mintSpanId(): string {
  return hexOfBytes(randomBytes(8));
}

/** The trace of the operation running now, if a door opened one. */
export function currentTrace(): TraceContext | null {
  return readTraceContext(storage.getStore());
}

/**
 * One timed span of main-thread work (VC-1073, VC-1090): a door call
 * ({@link withTrace}) or a labelled piece of work no door starts
 * ({@link withMainSpan}: a Session's runtime, a host timer, a broadcast).
 * Labels are code-owned identifiers (a channel, a verb, a timer name),
 * never content.
 */
export interface MainSpan {
  /** `"door"` for a {@link withTrace} call, `"span"` for a {@link withMainSpan}. */
  readonly kind: "door" | "span";
  readonly door: string;
  readonly operation: string;
  readonly sessionId: string | undefined;
  /** The span this one runs inside, if any: the parent hint. */
  readonly parent: MainSpan | null;
  /** A span nested in this one already reported this stall: the innermost wins. */
  readonly nestedStall: boolean;
}

/** The labels a {@link withMainSpan} takes. */
export interface MainSpanLabels {
  readonly door: string;
  readonly operation: string;
  readonly sessionId?: string | undefined;
}

/**
 * Told how long each span held the event loop: the synchronous part of its
 * `fn`, from entry to its return or throw, and of that the part no nested
 * span covered (`selfMs`). A door span is reported inside the call's own
 * context, so a line written then carries its trace. Returns whether it
 * logged this span as a stall, so the spans around it do not log it again.
 * It must not throw.
 */
export type MainSpanObserver = (syncMs: number, selfMs: number, span: MainSpan) => boolean;

interface SpanFrame {
  readonly kind: "door" | "span";
  readonly door: string;
  readonly operation: string;
  readonly sessionId: string | undefined;
  readonly parent: SpanFrame | null;
  nestedStall: boolean;
  nestedMs: number;
}

let spanObserver: MainSpanObserver | null = null;
/** The innermost span running now. */
let openSpan: SpanFrame | null = null;

/**
 * Installs the one observer every span reports to (the main stall monitor).
 * Returns the undo, which removes it unless something replaced it since.
 * With none installed, a span costs one null check.
 */
export function observeMainSpans(observer: MainSpanObserver): () => void {
  spanObserver = observer;
  return () => {
    if (spanObserver === observer) spanObserver = null;
  };
}

/**
 * Times the synchronous part of `fn` as main-thread work with these labels
 * (VC-1090), for work no door starts: a Session's runtime, a host timer, a
 * fan-out to windows. Opens no log context and mints nothing: two clock
 * reads while the stall monitor runs, one null check otherwise. `fn` runs
 * unchanged and its result (a promise too) is returned as is; only the part
 * before its first `await` is timed.
 */
export function withMainSpan<Result>(labels: MainSpanLabels, fn: () => Result): Result {
  const observer = spanObserver;
  if (observer === null) return fn();
  return timedSpan(observer, "span", labels.door, labels.operation, labels.sessionId, fn);
}

/** A context field as a label, or `"unknown"`. */
function label(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

/**
 * Opens a door's context for one request. The trace is, in order: the one
 * the peer sent (when well formed), the one already running (an in-process
 * door inside another operation), or a fresh one. The span is the peer's
 * request, or a fresh one.
 */
export function withTrace<Result>(
  incoming: unknown,
  fields: LogContextFields,
  fn: () => Result,
): Result {
  const sent = readTraceContext(incoming);
  const running = currentTrace();
  const observer = spanObserver;
  return withLogContext(
    {
      traceId: sent?.traceId ?? running?.traceId ?? mintTraceId(),
      spanId: sent?.spanId ?? mintSpanId(),
      ...fields,
    },
    observer === null
      ? fn
      : () => {
          const sessionId = fields["sessionId"];
          return timedSpan(
            observer,
            "door",
            label(fields["door"]),
            label(fields["operation"]),
            typeof sessionId === "string" ? sessionId : undefined,
            fn,
          );
        },
  );
}

/** Runs `fn` unchanged as the innermost span, then tells `observer` how long it ran synchronously. */
function timedSpan<Result>(
  observer: MainSpanObserver,
  kind: "door" | "span",
  door: string,
  operation: string,
  sessionId: string | undefined,
  fn: () => Result,
): Result {
  const parent = openSpan;
  const frame: SpanFrame = {
    kind,
    door,
    operation,
    sessionId,
    parent,
    nestedStall: false,
    nestedMs: 0,
  };
  openSpan = frame;
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    const syncMs = performance.now() - startedAt;
    openSpan = parent;
    const stalled = observer(syncMs, Math.max(0, syncMs - frame.nestedMs), frame);
    if (parent !== null) {
      parent.nestedMs += syncMs;
      if (stalled || frame.nestedStall) parent.nestedStall = true;
    }
  }
}

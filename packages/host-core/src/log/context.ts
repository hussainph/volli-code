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
  return withLogContext(
    {
      traceId: sent?.traceId ?? running?.traceId ?? mintTraceId(),
      spanId: sent?.spanId ?? mintSpanId(),
      ...fields,
    },
    fn,
  );
}

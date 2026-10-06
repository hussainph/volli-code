/**
 * Traces minted in the renderer (VC-699): where a person starts an operation.
 *
 * A request to main or to a host carries `{ traceId, spanId }` beside it; the
 * host writes the trace on every log line it writes for that request, so one
 * operation can be followed across this Mac and every host it reached. A
 * caller that knows the operation (a flow of several requests) passes its
 * trace id; otherwise each request is its own.
 */
import { hexOfBytes, isTraceId, type TraceContext } from "@volli/shared";

function randomHex(bytes: number): string {
  for (;;) {
    const hex = hexOfBytes(crypto.getRandomValues(new Uint8Array(bytes)));
    // All-zero is W3C's "invalid"; at these widths it never repeats.
    /* v8 ignore next -- a 2^-64 draw; the loop is the whole of its handling. */
    if (!/^0+$/u.test(hex)) return hex;
  }
}

/** A fresh trace id for an operation a person just started. */
export function mintTraceId(): string {
  return randomHex(16);
}

/** One request's trace: the operation's when the caller names a valid one, else a fresh one. */
export function traceFor(operation?: unknown): TraceContext {
  return { traceId: isTraceId(operation) ? operation : mintTraceId(), spanId: randomHex(8) };
}

/** The trace id a tRPC operation's context names (`{ context: { trace: { traceId } } }`). */
export function contextTraceId(context: Readonly<Record<string, unknown>> | undefined): unknown {
  const trace = context?.["trace"];
  return typeof trace === "object" && trace !== null
    ? (trace as { traceId?: unknown }).traceId
    : undefined;
}

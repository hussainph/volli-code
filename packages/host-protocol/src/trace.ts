/**
 * Request tracing on the wire (VC-699; HP § Tracing and logs).
 *
 * A Client mints a trace when a person starts an operation ("Add a host",
 * sending a message) and a span for each request it sends on that
 * operation's behalf. Both ride beside the request, never inside it: one
 * optional top-level field of the JSON-RPC frame, {@link HOST_TRACE_FIELD},
 * next to `id`, `method` and `params`. So:
 *
 * - **Additive.** Procedure inputs and outputs, and so the committed schema,
 *   do not change. A host that predates the field ignores it (tRPC's frame
 *   parser reads only the keys it knows); a Client that sends none gets a
 *   trace the host minted at its door.
 * - **Identifiers only.** `{ traceId, spanId }`: W3C Trace Context's shapes
 *   (32 and 16 lowercase hex), random, meaning nothing but "these lines
 *   belong together". A malformed one is ignored, never logged.
 * - **The host echoes it** in every log line it writes while serving that
 *   request (the Session runtime, the agent turn the request opened, git,
 *   the follow-up queue), joined with the Session, turn and command ids, so
 *   one trace can be followed across a Client and every host it reached.
 *
 * The connection's hello frame may carry one too: the handshake's own lines
 * (connected, refused, closed) then belong to the operation that connected.
 *
 * Web Crypto only: Node, browsers and mobile alike.
 */

/** The JSON-RPC frame's optional trace field. Its value is a {@link HostTrace}. */
export const HOST_TRACE_FIELD = "volliTrace";

/** What {@link HOST_TRACE_FIELD} holds. */
export interface HostTrace {
  /** The operation: 32 lowercase hex characters, never all zero. */
  readonly traceId: string;
  /** This request: 16 lowercase hex characters, never all zero. */
  readonly spanId: string;
}

/** Whether `value` has a trace id's shape (the host judges it again before it logs it). */
export function isTraceIdShaped(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

/** A fresh trace for an operation a person just started, with its first span. */
export function mintHostTrace(): HostTrace {
  return { traceId: randomHex(16), spanId: randomHex(8) };
}

/** The next request's span on an operation already traced. */
export function nextHostSpan(trace: Pick<HostTrace, "traceId">): HostTrace {
  return { traceId: trace.traceId, spanId: randomHex(8) };
}

function randomHex(bytes: number): string {
  for (;;) {
    const values = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
    // All-zero is W3C's "invalid"; at these widths it never repeats twice.
    if (values.some((value) => value !== 0)) {
      let hex = "";
      for (const value of values) hex += value.toString(16).padStart(2, "0");
      return hex;
    }
  }
}

/**
 * `frame` (one JSON-RPC message, as sent) with `trace` beside its id. A frame
 * that already names a trace keeps it.
 */
export function withHostTrace<Frame extends object>(frame: Frame, trace: HostTrace): Frame {
  return HOST_TRACE_FIELD in frame ? frame : { ...frame, [HOST_TRACE_FIELD]: trace };
}

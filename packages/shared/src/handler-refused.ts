/**
 * The brand a door's policy refusal carries at the host's handler map
 * (VC-668; HP § Command catalog, "One handler map").
 *
 * Every invocation of the map runs a door's policy before the handler
 * (`@volli/host-core/handlers`, `invokeHandler`). When the policy refuses, the
 * handler is never reached and the invocation throws an error carrying this
 * brand; each door says so in its own vocabulary: a router answers
 * `FORBIDDEN` / `verb-refused`, the agent socket `FORBIDDEN_ACTOR`, the
 * desktop's legacy IPC channel `{ ok: false, error }`. Lives here, beside
 * {@link OPERATION_UNAVAILABLE}, so host-core brands it and session-rpc reads
 * it without either depending on the other. A well-known symbol, so the brand
 * matches across module instances.
 */
export const HANDLER_REFUSED: unique symbol = Symbol.for("@volli/handler-refused");

/** A call a door's policy did not admit to its handler. */
export interface HandlerRefused {
  readonly [HANDLER_REFUSED]: true;
  readonly message: string;
  /** What the caller can do about it, when the policy knows. */
  readonly hint: string | null;
}

/** The error the map throws for {@link HandlerRefused}; the message is the client's. */
export class HandlerRefusedError extends Error implements HandlerRefused {
  readonly [HANDLER_REFUSED] = true as const;
  readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = "HandlerRefusedError";
    this.hint = hint;
  }
}

/** Whether a thrown value is a {@link HandlerRefused}. */
export function isHandlerRefused(value: unknown): value is HandlerRefused {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<HandlerRefused>)[HANDLER_REFUSED] === true
  );
}

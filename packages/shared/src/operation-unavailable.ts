/**
 * The brand a handler's "this host cannot answer that now" carries (VC-668).
 *
 * A handler in the host's map (`@volli/host-core/handlers`) is total: every
 * catalog key has one, on every host. What a host lacks this launch (no
 * database, no Model Access, no Session runtime) is that handler's answer, not
 * a missing port, so the handler throws an error carrying this brand and every
 * door says so in its own vocabulary: a router answers
 * `NOT_IMPLEMENTED` / `operation-unavailable`, the socket `APP_UNREACHABLE`.
 * Lives here, beside
 * {@link COMMAND_INTENT_CONFLICT}, so host-core brands it without depending on
 * a protocol package. A well-known symbol, so the brand matches across module
 * instances.
 */
export const OPERATION_UNAVAILABLE: unique symbol = Symbol.for("@volli/operation-unavailable");

/** An operation this host cannot perform now, whoever asks. */
export interface OperationUnavailable {
  readonly [OPERATION_UNAVAILABLE]: true;
}

/** The error a handler throws for {@link OperationUnavailable}; the message is the client's. */
export class OperationUnavailableError extends Error implements OperationUnavailable {
  readonly [OPERATION_UNAVAILABLE] = true as const;

  constructor(message: string) {
    super(message);
    this.name = "OperationUnavailableError";
  }
}

/** Whether a thrown value is an {@link OperationUnavailable}. */
export function isOperationUnavailable(value: unknown): value is OperationUnavailable {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OperationUnavailable>)[OPERATION_UNAVAILABLE] === true
  );
}

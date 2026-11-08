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

/**
 * The brand an operation stopped before it answered carries: a person or a
 * newer request cancelled it, so nothing failed and there is nothing to fix
 * but asking again. A router answers `CLIENT_CLOSED_REQUEST` /
 * `operation-cancelled`, never `operation-unavailable`, so a support log does
 * not read a cancel as a missing feature.
 */
export const OPERATION_CANCELLED: unique symbol = Symbol.for("@volli/operation-cancelled");

/** An operation that was cancelled before it answered. */
export interface OperationCancelled {
  readonly [OPERATION_CANCELLED]: true;
}

/** The error a handler throws for {@link OperationCancelled}; the message is the client's. */
export class OperationCancelledError extends Error implements OperationCancelled {
  readonly [OPERATION_CANCELLED] = true as const;

  constructor(message: string) {
    super(message);
    this.name = "OperationCancelledError";
  }
}

/** Whether a thrown value is an {@link OperationCancelled}. */
export function isOperationCancelled(value: unknown): value is OperationCancelled {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OperationCancelled>)[OPERATION_CANCELLED] === true
  );
}

/**
 * Commands as persisted intent (`docs/plans/host-protocol.md` § Commands). The
 * model is the Session engine's, which already ships: a client-minted id makes
 * acceptance idempotent, and a durable receipt says what became of it.
 *
 * - A replay with the same id and the same intent answers with the stored
 *   receipt and records nothing new.
 * - A replay with the same id and a different intent is refused
 *   `command-conflict` (`SessionEngineConflictError`).
 */

/** The idempotency key every intent-recording mutation carries. New clients mint a UUIDv4. */
export interface HostCommandRequest<Command> {
  readonly commandId: string;
  readonly command: Command;
}

/**
 * The receipt vocabulary, verbatim from `CommandReceipt` in `@volli/shared`
 * (`session-rpc` pins the two together):
 *
 * - `accepted`: the intent is durable and was handed on. It is not yet done.
 * - `completed`: the effect is recorded. This is what the brief calls "applied".
 * - `rejected`: refused, with a code.
 * - `unreconciled`: delivery could not be confirmed, and the host is recovering.
 *
 * `docs/BOUNDARIES.md` rule 4 applies: `accepted` is local acceptance, not finality.
 */
export const HOST_RECEIPT_STATUSES = ["accepted", "rejected", "completed", "unreconciled"] as const;
export type HostReceiptStatus = (typeof HOST_RECEIPT_STATUSES)[number];

/**
 * What an intent-recording mutation answers with. `throughSequence` is the
 * durable cursor the answer was read at. A client that also holds the stream
 * waits for its subscription to pass it, and only then treats the projection
 * as including this command.
 */
export interface HostCommandResult<Receipt extends { readonly status: HostReceiptStatus }> {
  readonly receipt: Receipt | null;
  readonly throughSequence: number;
}

/** Persisted intent and receipts reuse the Session engine command model. */

/** The idempotency key every intent-recording mutation carries. New clients mint a UUIDv4. */
export interface HostCommandRequest<Command> {
  readonly commandId: string;
  readonly command: Command;
}

/** CommandReceipt statuses: accepted is durable, completed is applied; rejected is refused,
 * unreconciled is uncertain. BOUNDARIES rule 4 still applies. */
export const HOST_RECEIPT_STATUSES = ["accepted", "rejected", "completed", "unreconciled"] as const;
export type HostReceiptStatus = (typeof HOST_RECEIPT_STATUSES)[number];

/** Minimum command answer; throughSequence is scoped to its durable resource stream. */
export interface HostCommandResult<Receipt extends { readonly status: HostReceiptStatus }> {
  readonly receipt: Receipt | null;
  readonly throughSequence: number;
}

/**
 * The brand a command-intent conflict carries (HP § Commands; VC-564 A2). A
 * well-known symbol, so one realm's brand matches across module instances.
 */
export const COMMAND_INTENT_CONFLICT: unique symbol = Symbol.for(
  "@volli/host-protocol/command-intent-conflict",
);

/**
 * A command id already recorded, sent again with a different intent: the one
 * conflict a client causes, which every router answers `CONFLICT` /
 * `command-conflict`. Any area's intent ledger implements it on the error it
 * throws for that case, and only that case; the router recognizes the
 * brand, never a ledger's own classes. Every other conflict is a fact about
 * the ledger and keeps its own answer.
 */
export interface CommandIntentConflict {
  readonly [COMMAND_INTENT_CONFLICT]: true;
}

/** Whether a thrown value is a {@link CommandIntentConflict}. */
export function isCommandIntentConflict(value: unknown): value is CommandIntentConflict {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<CommandIntentConflict>)[COMMAND_INTENT_CONFLICT] === true
  );
}

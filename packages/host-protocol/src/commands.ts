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

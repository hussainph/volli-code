/** A historical ledger allowance, never a decision waiting on a person. */
export interface ApprovalUsedObservation {
  kind: "approval-used";
  toolCallId: string;
  approvalId: string;
  summary: string;
  asked: string;
  occurredAt: number;
}

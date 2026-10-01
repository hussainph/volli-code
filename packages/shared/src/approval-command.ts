import type { AuthorityApproval } from "./approvals";

/** Person-authored ledger mutations; no command can create a grant. */
export interface ApprovalCommand {
  commandId: string;
  kind: "approval.revoke" | "approval.restore";
  approvalId: string;
}

export interface ApprovalMutationEvent {
  id: string;
  commandId: string;
  kind: "approval.revoked" | "approval.restored";
  approvalId: string;
  occurredAt: number;
  approval: AuthorityApproval;
}

export type ApprovalCommandReceipt =
  | {
      commandId: string;
      status: "accepted";
      eventId: string;
      approval: AuthorityApproval;
    }
  | {
      commandId: string;
      status: "rejected";
      code: "APPROVAL_NOT_FOUND" | "APPROVAL_COMMAND_CONFLICT";
    };

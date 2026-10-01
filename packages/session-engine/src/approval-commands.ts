import type {
  ApprovalCommand,
  ApprovalCommandReceipt,
  ApprovalMutationEvent,
  AuthorityApproval,
} from "@volli/shared";

/** The host owns transactionality; this command boundary owns intent and immutable outcomes. */
export interface ApprovalCommandStore {
  transact<T>(run: () => T): T;
  read(commandId: string): { command: ApprovalCommand; receipt: ApprovalCommandReceipt } | null;
  approval(approvalId: string): AuthorityApproval | null;
  commit(
    command: ApprovalCommand,
    receipt: ApprovalCommandReceipt,
    event: ApprovalMutationEvent | null,
  ): void;
}

export function executeApprovalCommand(
  store: ApprovalCommandStore,
  command: ApprovalCommand,
  now: () => number,
): ApprovalCommandReceipt {
  return store.transact(() => {
    const prior = store.read(command.commandId);
    if (prior !== null) {
      return prior.command.kind === command.kind && prior.command.approvalId === command.approvalId
        ? prior.receipt
        : { commandId: command.commandId, status: "rejected", code: "APPROVAL_COMMAND_CONFLICT" };
    }
    const approval = store.approval(command.approvalId);
    if (approval === null) {
      const receipt = {
        commandId: command.commandId,
        status: "rejected",
        code: "APPROVAL_NOT_FOUND",
      } as const;
      store.commit(command, receipt, null);
      return receipt;
    }
    const event: ApprovalMutationEvent = {
      id: `approval-command:${command.commandId}`,
      commandId: command.commandId,
      kind: command.kind === "approval.revoke" ? "approval.revoked" : "approval.restored",
      approvalId: command.approvalId,
      occurredAt: now(),
      approval,
    };
    const receipt = {
      commandId: command.commandId,
      status: "accepted",
      eventId: event.id,
      approval,
    } as const;
    store.commit(command, receipt, event);
    return receipt;
  });
}

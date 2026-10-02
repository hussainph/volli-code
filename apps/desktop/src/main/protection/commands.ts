import type Database from "better-sqlite3";
import type { ApprovalCommand, ApprovalCommandReceipt, ApprovalMutationEvent } from "@volli/shared";
import { executeApprovalCommand, type ApprovalCommandStore } from "@volli/session-engine";
import { getApproval, restoreApproval, revokeApproval } from "../db/authority-approvals-repo";
import { prepared } from "../db/prepared";

/** App-owned SQLite implementation of the portable Command → Event → Projection boundary. */
export function commandApproval(
  db: Database.Database,
  command: ApprovalCommand,
  now: () => number,
): ApprovalCommandReceipt {
  const store: ApprovalCommandStore = {
    transact: (run) => db.transaction(run)(),
    read: (commandId) => {
      const row = prepared<[string], { command: string; receipt: string }>(
        db,
        "SELECT command, receipt FROM authority_approval_commands WHERE command_id = ?",
      ).get(commandId);
      return row === undefined
        ? null
        : {
            command: JSON.parse(row.command) as ApprovalCommand,
            receipt: JSON.parse(row.receipt) as ApprovalCommandReceipt,
          };
    },
    approval: (id) => getApproval(db, id),
    commit: (intent, receipt, event) => {
      prepared(
        db,
        "INSERT INTO authority_approval_commands (command_id, command, receipt) VALUES (?, ?, ?)",
      ).run(intent.commandId, JSON.stringify(intent), JSON.stringify(receipt));
      if (event === null) return;
      prepared(
        db,
        "INSERT INTO authority_approval_events (id, command_id, payload, created_at) VALUES (?, ?, ?, ?)",
      ).run(event.id, intent.commandId, JSON.stringify(event), event.occurredAt);
      projectApprovalEvent(db, event);
    },
  };
  return executeApprovalCommand(store, command, now);
}

function projectApprovalEvent(db: Database.Database, event: ApprovalMutationEvent): void {
  if (event.kind === "approval.revoked") revokeApproval(db, event.approvalId, event.occurredAt);
  else restoreApproval(db, event.approvalId);
}

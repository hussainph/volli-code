/**
 * The door Settings and Configure speak to protection through (VC-480): the
 * listing and revoking remembered approvals.
 *
 * Writing a row is not here. Rows are written in main from a person's answer on
 * a card, so the renderer — and anything that could impersonate it — can revoke
 * but never grant.
 */
import type Database from "better-sqlite3";

import { PROTECTION_CHANNELS, PROTECTION_IPC } from "../ipc-descriptors";
import type { ProtectionIpcChannel } from "../../ipc/contract";
import {
  registerDegradedIpcHandlers,
  registerGuardedIpcHandlers,
  type IpcHandlerTable,
} from "../ipc-registry";
import { listApprovals, countApprovedRequests } from "../db/authority-approvals-repo";

import { commandApproval } from "./commands";

export function registerProtectionIpcHandlers(
  db: Database.Database | null,
  unavailableReason: string = "Protection settings are unavailable.",
  now: () => number = Date.now,
): void {
  if (db === null) {
    registerDegradedIpcHandlers(PROTECTION_CHANNELS, unavailableReason);
    return;
  }
  const handlers: IpcHandlerTable<ProtectionIpcChannel> = {
    "volli:protection-approvals": (projectId) => ({
      ok: true,
      approvals: listApprovals(db, projectId),
      passedRequestCount: countApprovedRequests(db, projectId),
    }),
    "volli:protection-revoke": (approvalId, commandId) => {
      const receipt = commandApproval(db, { kind: "approval.revoke", approvalId, commandId }, now);
      return receipt.status === "accepted"
        ? { ok: true, approval: receipt.approval, receipt }
        : {
            ok: false,
            error:
              receipt.code === "APPROVAL_COMMAND_CONFLICT"
                ? "That command ID belongs to a different action."
                : "That approval is gone.",
          };
    },
    "volli:protection-restore": (approvalId, commandId) => {
      const receipt = commandApproval(db, { kind: "approval.restore", approvalId, commandId }, now);
      return receipt.status === "accepted"
        ? { ok: true, approval: receipt.approval, receipt }
        : {
            ok: false,
            error:
              receipt.code === "APPROVAL_COMMAND_CONFLICT"
                ? "That command ID belongs to a different action."
                : "That approval can't be restored.",
          };
    },
  };
  registerGuardedIpcHandlers(PROTECTION_IPC, handlers);
}

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
import { listApprovals, restoreApproval, revokeApproval } from "../db/authority-approvals-repo";

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
    }),
    "volli:protection-revoke": (approvalId) => {
      const approval = revokeApproval(db, approvalId, now());
      return approval === null
        ? { ok: false, error: "That approval is already gone." }
        : { ok: true, approval };
    },
    "volli:protection-restore": (approvalId) => {
      const approval = restoreApproval(db, approvalId);
      return approval === null
        ? { ok: false, error: "That approval can't be restored." }
        : { ok: true, approval };
    },
  };
  registerGuardedIpcHandlers(PROTECTION_IPC, handlers);
}

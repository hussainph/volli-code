/**
 * The audit trail: one `auditLog` row per change worth answering "who did
 * this, and when" about (membership, invites, policy, Workspace settings, account deletion,
 * sharing a Session, team secrets, a moved project shown, hidden or rescued).
 *
 * Each row names its Actor and what changed. `detail` is written only through
 * {@link audit}, from the typed entries below, and never holds a secret or an
 * invite token.
 */

import type { GenericDatabaseWriter } from "convex/server";

import { newId, type Actor } from "@volli/shared/cloud";

import type { DataModel } from "../_generated/dataModel.js";

export type AuditKind =
  | "workspace.created"
  | "workspace.renamed"
  | "policy.updated"
  | "invite.created"
  | "invite.reissued"
  | "invite.revoked"
  | "invite.accepted"
  | "member.joined"
  | "member.rejoined"
  | "member.role_changed"
  | "member.suspended"
  | "member.unsuspended"
  | "member.removed"
  | "member.left"
  | "account.deletion_requested"
  | "account.deletion_cancelled"
  | "session.shared"
  | "secret.created"
  | "secret.updated"
  | "secret.exposure_changed"
  | "secret.removed"
  | "project.imported"
  | "project.import_uncommitted"
  | "project.import_rescue_aborted"
  | "project.import_reassigned";

export type AuditTargetKind =
  | "workspace"
  | "policy"
  | "invite"
  | "member"
  | "user"
  | "session"
  | "secret"
  | "project";

/** A JSON-safe value for an audit row's `detail`. */
export type AuditValue =
  | string
  | number
  | boolean
  | null
  | AuditValue[]
  | { [key: string]: AuditValue };

export interface AuditEntry {
  workspaceId: string | null;
  actor: Actor;
  kind: AuditKind;
  targetKind: AuditTargetKind;
  targetId: string;
  at: number;
  /** What changed. Never a secret or a token. */
  detail: { [key: string]: AuditValue };
}

export async function audit(
  ctx: { db: GenericDatabaseWriter<DataModel> },
  entry: AuditEntry,
): Promise<void> {
  await ctx.db.insert("auditLog", { id: newId("auditEntry"), ...entry });
}

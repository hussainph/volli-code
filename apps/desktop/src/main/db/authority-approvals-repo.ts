/**
 * The remembered approvals of VC-480: rows the Approved actions list shows and
 * the gate reads.
 *
 * App-owned, written only from the person's answer on a card (or a revoke from
 * the list). The runtime is handed `findCoveringApproval` through a read port
 * and has no way to author a row.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  approvalCovers,
  describeApproval,
  type ApprovalDecision,
  type ApprovalOperation,
  type ApprovalProvenance,
  type ApprovalRowScope,
  type ApprovalScope,
  type AuthorityApproval,
} from "@volli/shared";

import { prepared } from "./prepared";

interface ApprovalRow {
  id: string;
  project_id: string;
  scope: ApprovalRowScope;
  session_id: string | null;
  operation: ApprovalOperation;
  key: string;
  rule: string;
  provenance: string;
  created_at: number;
  use_count: number;
  last_used_at: number | null;
  last_used_session_id: string | null;
  revoked_at: number | null;
}

function parseProvenance(raw: string, sessionId: string | null): ApprovalProvenance {
  try {
    const value = JSON.parse(raw) as Partial<ApprovalProvenance>;
    return {
      sessionId: value.sessionId ?? sessionId ?? "",
      sessionTitle: value.sessionTitle ?? null,
      ticketDisplayId: value.ticketDisplayId ?? null,
      asked: value.asked ?? "",
      reason: value.reason ?? "",
      interactionId: value.interactionId ?? "",
    };
  } catch {
    return {
      sessionId: sessionId ?? "",
      sessionTitle: null,
      ticketDisplayId: null,
      asked: "",
      reason: "",
      interactionId: "",
    };
  }
}

function toApproval(row: ApprovalRow): AuthorityApproval {
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope,
    sessionId: row.session_id,
    operation: row.operation,
    key: row.key,
    summary: describeApproval({ operation: row.operation, key: row.key }),
    rule: row.rule,
    createdAt: row.created_at,
    provenance: parseProvenance(row.provenance, row.session_id),
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    lastUsedBySessionId: row.scope === "session" ? row.last_used_session_id : null,
  };
}

export interface NewApproval {
  projectId: string;
  scope: ApprovalRowScope;
  /** Required for a `session` row, null for a `project` row. */
  sessionId: string | null;
  approval: ApprovalScope;
  rule: string;
  provenance: ApprovalProvenance;
  now: number;
}

/** Reuses an identical live grant, preserving its provenance and use history, or writes one row. */
export function insertApproval(db: Database.Database, input: NewApproval): AuthorityApproval {
  if (input.approval.key === null) throw new Error("This approval cannot be remembered.");
  const existing = prepared<[string, string, string | null, string, string], ApprovalRow>(
    db,
    `SELECT * FROM authority_approvals
      WHERE project_id = ? AND scope = ? AND session_id IS ?
        AND operation = ? AND key = ? AND revoked_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
  ).get(
    input.projectId,
    input.scope,
    input.scope === "session" ? input.sessionId : null,
    input.approval.operation,
    input.approval.key,
  );
  if (existing !== undefined) return toApproval(existing);
  const id = randomUUID();
  prepared(
    db,
    `INSERT INTO authority_approvals
       (id, project_id, scope, session_id, operation, key, rule, provenance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.scope,
    input.scope === "session" ? input.sessionId : null,
    input.approval.operation,
    input.approval.key,
    input.rule,
    JSON.stringify(input.provenance),
    input.now,
  );
  return toApproval(
    prepared<[string], ApprovalRow>(db, "SELECT * FROM authority_approvals WHERE id = ?").get(id)!,
  );
}

/** Live rows for a project, newest first. */
export function listApprovals(db: Database.Database, projectId: string): AuthorityApproval[] {
  return prepared<[string], ApprovalRow>(
    db,
    `SELECT * FROM authority_approvals
      WHERE project_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC, id`,
  )
    .all(projectId)
    .map(toApproval);
}

/** Soft-deletes a grant and any identical legacy duplicates. Returns the selected live row, or null. */
export function revokeApproval(
  db: Database.Database,
  id: string,
  now: number,
): AuthorityApproval | null {
  return db.transaction(() => {
    const row = prepared<[string], ApprovalRow>(
      db,
      "SELECT * FROM authority_approvals WHERE id = ? AND revoked_at IS NULL",
    ).get(id);
    if (row === undefined) return null;
    prepared(
      db,
      `UPDATE authority_approvals SET revoked_at = ?
        WHERE project_id = ? AND scope = ? AND session_id IS ?
          AND operation = ? AND key = ? AND revoked_at IS NULL`,
    ).run(now, row.project_id, row.scope, row.session_id, row.operation, row.key);
    return toApproval(row);
  })();
}

/** Undo of a revoke: the same row, the same id and provenance. */
export function restoreApproval(db: Database.Database, id: string): AuthorityApproval | null {
  const result = prepared(
    db,
    "UPDATE authority_approvals SET revoked_at = NULL WHERE id = ? AND revoked_at IS NOT NULL",
  ).run(id);
  if (result.changes === 0) return null;
  return toApproval(
    prepared<[string], ApprovalRow>(db, "SELECT * FROM authority_approvals WHERE id = ?").get(id)!,
  );
}

/**
 * The live row that covers `scope` for a Session, or null.
 *
 * `sessionIds` is the asking Session first and then any ancestors whose "this
 * Session" approvals it inherits; project rows apply to everyone. Read on every
 * call and never cached, so a revoke applies from the very next one.
 */
export function findCoveringApproval(
  db: Database.Database,
  input: { projectId: string; sessionIds: readonly string[] },
  scope: ApprovalScope,
): AuthorityApproval | null {
  if (scope.key === null) return null;
  const rows = prepared<[string, string, string], ApprovalRow>(
    db,
    `SELECT * FROM authority_approvals
      WHERE project_id = ? AND operation = ? AND revoked_at IS NULL
        AND (scope = 'project' OR session_id IN (SELECT value FROM json_each(?)))
      ORDER BY scope DESC, created_at`,
  ).all(input.projectId, scope.operation, JSON.stringify(input.sessionIds));
  const hit = rows.find((row) => approvalCovers({ operation: row.operation, key: row.key }, scope));
  return hit === undefined ? null : toApproval(hit);
}

/** Counts one use. `bySessionId` is recorded only when it is not the approving Session. */
export function recordApprovalUse(
  db: Database.Database,
  id: string,
  bySessionId: string,
  now: number,
): void {
  prepared(
    db,
    `UPDATE authority_approvals
        SET use_count = use_count + 1, last_used_at = ?,
            last_used_session_id = CASE WHEN scope = 'session' AND session_id IS NOT ? THEN ? ELSE NULL END
      WHERE id = ?`,
  ).run(now, bySessionId, bySessionId, id);
}

/** Appends one decision: who authorised a gated call, before it ran. */
export function insertDecision(
  db: Database.Database,
  input: { projectId: string; sessionId: string; decision: ApprovalDecision; now: number },
): void {
  const { decision } = input;
  prepared(
    db,
    `INSERT INTO authority_decisions
       (id, project_id, session_id, tool_call_id, tool, authoriser, rule, summary, asked, approval_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.projectId,
    input.sessionId,
    decision.toolCallId,
    decision.tool,
    decision.authoriser,
    decision.rule,
    decision.summary,
    decision.asked,
    decision.approvalId,
    input.now,
  );
}

/** A decision as read back, newest first. */
export interface StoredDecision {
  id: string;
  sessionId: string;
  toolCallId: string;
  authoriser: string;
  rule: string;
  summary: string;
  asked: string;
  approvalId: string | null;
  createdAt: number;
}

export function listDecisions(db: Database.Database, sessionId: string): StoredDecision[] {
  return prepared<
    [string],
    {
      id: string;
      session_id: string;
      tool_call_id: string;
      authoriser: string;
      rule: string;
      summary: string;
      asked: string;
      approval_id: string | null;
      created_at: number;
    }
  >(db, "SELECT * FROM authority_decisions WHERE session_id = ? ORDER BY created_at DESC, id")
    .all(sessionId)
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      authoriser: row.authoriser,
      rule: row.rule,
      summary: row.summary,
      asked: row.asked,
      approvalId: row.approval_id,
      createdAt: row.created_at,
    }));
}

/** One completed call may consume several grants; the request total counts it just once. */
export function recordApprovalCompletion(
  db: Database.Database,
  input: {
    projectId: string;
    sessionId: string;
    toolCallId: string;
    approvalIds: readonly string[];
    inheritedFrom: readonly string[];
    now: number;
  },
): void {
  db.transaction(() => {
    const inserted = prepared(
      db,
      `INSERT OR IGNORE INTO authority_approval_completions
      (project_id, session_id, tool_call_id, approval_ids, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.projectId,
      input.sessionId,
      input.toolCallId,
      JSON.stringify(input.approvalIds),
      input.now,
    );
    if (inserted.changes === 0) return;
    for (const id of input.approvalIds) {
      recordApprovalUse(db, id, input.sessionId, input.now);
      // A different caller alone is not proof of inheritance. Only a verified ancestor grant is.
      prepared(
        db,
        `UPDATE authority_approvals SET last_used_session_id = NULL
        WHERE id = ? AND (scope != 'session' OR session_id NOT IN (SELECT value FROM json_each(?)))`,
      ).run(id, JSON.stringify(input.inheritedFrom));
    }
  })();
}

export function countApprovedRequests(db: Database.Database, projectId: string): number {
  return prepared<[string], { count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM authority_approval_completions WHERE project_id = ?",
  ).get(projectId)!.count;
}

/** Mutation commands may read a revoked row for replay/undo, but the gate never does. */
export function getApproval(db: Database.Database, id: string): AuthorityApproval | null {
  const row = prepared<[string], ApprovalRow>(
    db,
    "SELECT * FROM authority_approvals WHERE id = ?",
  ).get(id);
  return row === undefined ? null : toApproval(row);
}

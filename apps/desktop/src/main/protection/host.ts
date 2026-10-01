/**
 * The host half of protection mode for one attachment (VC-480): the ledger the
 * gate reads and the one door that writes it.
 *
 * Built by main per attach and activated by the pinned Protection state.
 * Everything here touches the app-owned database; the runtime is
 * handed `covers` and `decided` and nothing else, and `remember` is called by
 * the adapter from a person's answer, never from the runtime.
 *
 * A Session's own approvals belong to that Session. Reading goes up the parent
 * chain (a subagent sees its parent's live set, so a revoke on the parent
 * applies to the child), but writing never goes the other way: a child's
 * "allow for this Session" is the child's, and the parent cannot see it.
 */
import type Database from "better-sqlite3";
import type { ApprovalScope } from "@volli/shared";

import {
  findCoveringApproval,
  insertApproval,
  insertDecision,
  recordApprovalCompletion,
} from "../db/authority-approvals-repo";
import type { PiProtection } from "../session-runtime/pi-adapter";

export interface ProtectionHostInput {
  db: Database.Database;
  now: () => number;
  projectId: string;
  sessionId: string;
  /** Ancestors whose "this Session" approvals this Session reads through to. */
  inheritedFrom: readonly string[];
  sessionTitle: string | null;
  ticketDisplayId: string | null;
  /** Diagnostics seam: a decision or row that could not be written is reported, never swallowed. */
  onError?: (error: unknown) => void;
}

export function createProtection(input: ProtectionHostInput): PiProtection {
  const { db, now, projectId, sessionId } = input;
  const onError = input.onError ?? ((error: unknown) => console.warn("[volli] protection:", error));
  const sessionIds = [sessionId, ...input.inheritedFrom];
  const pendingUses = new Map<string, Set<string>>();
  return {
    covers(scope: ApprovalScope) {
      const hit = findCoveringApproval(db, { projectId, sessionIds }, scope);
      if (hit === null) return null;
      return { approvalId: hit.id, summary: hit.summary };
    },
    decided(decision) {
      try {
        insertDecision(db, { projectId, sessionId, decision, now: now() });
        if (decision.authoriser === "policy:ledger" && decision.approvalId !== null) {
          const ids = pendingUses.get(decision.toolCallId) ?? new Set<string>();
          ids.add(decision.approvalId);
          pendingUses.set(decision.toolCallId, ids);
        }
      } catch (error) {
        onError(error);
        // No execution may proceed without its pre-execution decision record.
        throw error;
      }
    },
    completed(toolCallId) {
      const ids = pendingUses.get(toolCallId);
      if (ids === undefined) return;
      try {
        recordApprovalCompletion(db, {
          projectId,
          sessionId,
          toolCallId,
          approvalIds: [...ids],
          inheritedFrom: input.inheritedFrom,
          now: now(),
        });
        pendingUses.delete(toolCallId);
      } catch (error) {
        // Keep the pending accounting for an idempotent retry. Work already succeeded.
        onError(error);
      }
    },
    remember(grant) {
      // A multi-scope answer is remembered in full or not at all.
      db.transaction(() => {
        const remembered = new Set<string>();
        for (const scope of grant.scopes) {
          if (scope.key === null) continue;
          const identity = JSON.stringify([scope.operation, scope.key]);
          if (remembered.has(identity)) continue;
          remembered.add(identity);
          insertApproval(db, {
            projectId,
            scope: grant.scope,
            sessionId: grant.scope === "session" ? sessionId : null,
            approval: scope,
            rule: grant.rule,
            provenance: {
              sessionId,
              sessionTitle: input.sessionTitle,
              ticketDisplayId: input.ticketDisplayId,
              asked: grant.asked,
              reason: grant.reason,
              interactionId: grant.interactionId,
            },
            now: now(),
          });
        }
      })();
    },
  };
}

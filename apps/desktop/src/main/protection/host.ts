/**
 * The host half of protection mode for one attachment (VC-480): the ledger the
 * gate reads and the one door that writes it.
 *
 * Built by main per attach, only when the experiment is on and the project is
 * protected. Everything here touches the app-owned database; the runtime is
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
  recordApprovalUse,
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
  return {
    covers(scope: ApprovalScope) {
      const hit = findCoveringApproval(db, { projectId, sessionIds }, scope);
      if (hit === null) return null;
      recordApprovalUse(db, hit.id, sessionId, now());
      return { approvalId: hit.id, summary: hit.summary };
    },
    decided(decision) {
      try {
        insertDecision(db, { projectId, sessionId, decision, now: now() });
      } catch (error) {
        onError(error);
      }
    },
    remember(grant) {
      for (const scope of grant.scopes) {
        if (scope.key === null) continue;
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
    },
  };
}

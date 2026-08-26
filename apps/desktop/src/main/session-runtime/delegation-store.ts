/**
 * The durable half of in-ticket delegation (VC-183).
 *
 * `delegation-policy.ts` beside this file decides what a grant means; this
 * writes and reads it. The split is the one the two implemented ports already
 * drew: `SessionGrantPorts` is birth, `TicketSessionDelegationClaims` is the
 * fan-out ledger the tool door spends.
 *
 * No renderer or agent-socket write reaches this store: only Session birth
 * persists a grant, and only a bound named tool may consume an
 * already-persisted one.
 */
import type Database from "better-sqlite3";
import { isVerbToolKey } from "@volli/shared";
import type { RuntimeSessionRole } from "@volli/shared";

import {
  assertDelegation,
  claimedDelegation,
  claimKey,
  cloneDelegation,
  cloneDelegationDefaults,
  isDelegationChildren,
  isDelegationDepth,
  isNonNegativeInteger,
} from "./delegation-policy";
import type {
  DelegationClaimRef,
  SessionGrantBirth,
  SessionGrantPorts,
  TicketDelegationClaim,
  TicketSessionDelegation,
  TicketSessionDelegationClaims,
} from "./delegation-policy";

interface StartGrantRow {
  scope: string;
  max_depth: number;
  max_children: number;
}

interface DelegationRow extends StartGrantRow {
  /** Null once the Ticket is deleted; the grant outlives it, refusing. */
  ticket_id: string | null;
  parent_session_id: string | null;
  depth: number;
}

interface ClaimRow {
  ticket_id: string;
  create_command_id: string;
  child_session_id: string | null;
}

export class TicketSessionDelegationStore
  implements SessionGrantPorts, TicketSessionDelegationClaims
{
  /** Claims that this process has accepted but has not yet linked to a child. */
  readonly #inFlightClaims = new Set<string>();

  constructor(private readonly db: Database.Database) {}

  resolveBirth(input: {
    role: RuntimeSessionRole;
    ticketId: string | null;
    delegation?: TicketSessionDelegation;
  }): SessionGrantBirth {
    if (input.role === "project") {
      if (input.delegation !== undefined) {
        throw new Error("A Project Session cannot inherit Ticket delegation ancestry");
      }
      return { grants: [], delegation: null };
    }
    // The Role and the Ticket are one fact on start (`ticketId !== null` IS the
    // Role), so a `ticket` Role with no Ticket is a caller that has already
    // lost track of which Session it is minting.
    if (input.ticketId === null) {
      throw new Error("A Ticket Session needs a Ticket before grants can resolve");
    }
    const delegation = input.delegation ?? cloneDelegationDefaults();
    assertDelegation(delegation);
    // At the depth cap we still retain ancestry for future own-children grants,
    // but do not offer a tool whose next call must fail. Availability remains
    // the enforcement boundary.
    return {
      grants: delegation.depth < delegation.maxDepth ? ["session.start"] : [],
      delegation: cloneDelegation(delegation),
    };
  }

  recordBirth(sessionId: string, birth: SessionGrantBirth): void {
    this.db.transaction(() => {
      if (birth.delegation === null) {
        if (birth.grants.length !== 0) {
          throw new Error("A Session without delegation ancestry cannot receive a verb grant");
        }
        return;
      }
      assertDelegation(birth.delegation);
      const session = this.db
        .prepare("SELECT ticket_id FROM sessions WHERE id = ?")
        .get(sessionId) as { ticket_id: string | null } | undefined;
      if (session === undefined || session.ticket_id === null) {
        throw new Error("A delegation grant can only be recorded for an existing Ticket Session");
      }
      this.recordDelegation(sessionId, session.ticket_id, birth.delegation);
      this.recordGrants(sessionId, birth);
      const { parentSessionId, claimToolCallId } = birth.delegation;
      if (parentSessionId !== null && claimToolCallId !== null) {
        this.completeClaim(
          { parentSessionId, toolCallId: claimToolCallId },
          { ticketId: session.ticket_id, childSessionId: sessionId },
        );
      }
    })();
  }

  startGrantScope(sessionId: string): "own-ticket" | null {
    return this.readStartGrant(sessionId)?.scope ?? null;
  }

  /** The grant a tool door may consume, fail-closed for missing or malformed stored data. */
  readStartGrant(
    sessionId: string,
  ): { scope: "own-ticket"; maxDepth: number; maxChildren: number } | null {
    const row = this.db
      .prepare(
        `SELECT scope, max_depth, max_children
           FROM session_verb_grants
          WHERE session_id = ? AND verb = 'session.start'`,
      )
      .get(sessionId) as StartGrantRow | undefined;
    if (
      row === undefined ||
      row.scope !== "own-ticket" ||
      !isDelegationDepth(row.max_depth) ||
      !isDelegationChildren(row.max_children)
    ) {
      return null;
    }
    return { scope: "own-ticket", maxDepth: row.max_depth, maxChildren: row.max_children };
  }

  claimStart(
    input: DelegationClaimRef & { ticketId: string; createCommandId: string },
  ): TicketDelegationClaim {
    if (input.toolCallId.length === 0) throw new Error("A delegation claim needs a tool call id");
    if (input.createCommandId.length === 0) {
      throw new Error("A delegation claim needs the create command id its start will write");
    }
    const key = claimKey(input);
    return this.db.transaction(() => {
      // A process crash can land after the claim but before Session Engine
      // creates its command. On the next process, there is no in-flight call
      // and no durable child evidence, so reclaim only that abandoned slot.
      // Current-process claims stay protected by the in-memory set until their
      // create command exists or the caller proves the start never happened.
      this.clearAbandonedClaims(input.parentSessionId);
      const parent = this.readDelegationGrant(input.parentSessionId);
      if (
        parent === null ||
        parent.ticket_id !== input.ticketId ||
        parent.scope !== "own-ticket" ||
        parent.depth >= parent.max_depth
      ) {
        return { ok: false, reason: "not-granted" } as const;
      }
      const granted = {
        depth: parent.depth,
        maxDepth: parent.max_depth,
        maxChildren: parent.max_children,
      };
      // A replay cannot smuggle in a different Ticket: the grant check above
      // already refused every `ticketId` but the one on the ancestry row, and
      // this claim was inserted under that same check. There is no third value
      // left for the stored row to disagree with.
      if (this.readClaim(input) !== undefined) {
        this.#inFlightClaims.add(key);
        return { ok: true, delegation: claimedDelegation(granted, input) } as const;
      }
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM session_delegation_claims WHERE parent_session_id = ?",
        )
        .get(input.parentSessionId) as { count: number };
      if (count.count >= parent.max_children) {
        return { ok: false, reason: "limit", maxChildren: parent.max_children } as const;
      }
      this.db
        .prepare(
          `INSERT INTO session_delegation_claims
             (parent_session_id, tool_call_id, ticket_id, create_command_id, child_session_id, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          input.parentSessionId,
          input.toolCallId,
          input.ticketId,
          input.createCommandId,
          Date.now(),
        );
      this.#inFlightClaims.add(key);
      return { ok: true, delegation: claimedDelegation(granted, input) } as const;
    })();
  }

  releaseIfUnstarted(input: DelegationClaimRef): void {
    const key = claimKey(input);
    this.db.transaction(() => {
      const claim = this.readClaim(input);
      if (claim === undefined) {
        this.#inFlightClaims.delete(key);
        return;
      }
      // A Session Engine create command is durable evidence that a retry must
      // preserve the slot: it can replay the same child and finish recording
      // its birth grant after a crash or a later start failure.
      if (this.createCommandExists(claim.create_command_id)) {
        this.#inFlightClaims.delete(key);
        return;
      }
      this.deletePendingClaim(input);
      this.#inFlightClaims.delete(key);
    })();
  }

  private clearAbandonedClaims(parentSessionId: string): void {
    const pending = this.db
      .prepare(
        `SELECT tool_call_id, create_command_id
           FROM session_delegation_claims
          WHERE parent_session_id = ? AND child_session_id IS NULL`,
      )
      .all(parentSessionId) as Array<{ tool_call_id: string; create_command_id: string }>;
    for (const row of pending) {
      const ref = { parentSessionId, toolCallId: row.tool_call_id };
      if (this.#inFlightClaims.has(claimKey(ref))) continue;
      if (this.createCommandExists(row.create_command_id)) continue;
      this.deletePendingClaim(ref);
    }
  }

  private createCommandExists(createCommandId: string): boolean {
    return (
      this.db
        .prepare("SELECT session_id FROM session_commands WHERE id = ?")
        .get(createCommandId) !== undefined
    );
  }

  private readClaim(ref: DelegationClaimRef): ClaimRow | undefined {
    return this.db
      .prepare(
        `SELECT ticket_id, create_command_id, child_session_id
           FROM session_delegation_claims
          WHERE parent_session_id = ? AND tool_call_id = ?`,
      )
      .get(ref.parentSessionId, ref.toolCallId) as ClaimRow | undefined;
  }

  private deletePendingClaim(ref: DelegationClaimRef): void {
    this.db
      .prepare(
        `DELETE FROM session_delegation_claims
          WHERE parent_session_id = ? AND tool_call_id = ? AND child_session_id IS NULL`,
      )
      .run(ref.parentSessionId, ref.toolCallId);
  }

  private recordDelegation(
    sessionId: string,
    ticketId: string,
    delegation: TicketSessionDelegation,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT ticket_id, parent_session_id, depth
           FROM session_delegations
          WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { ticket_id: string | null; parent_session_id: string | null; depth: number }
      | undefined;
    if (existing !== undefined) {
      if (
        existing.ticket_id !== ticketId ||
        existing.parent_session_id !== delegation.parentSessionId ||
        existing.depth !== delegation.depth
      ) {
        throw new Error(`Session ${sessionId} already has different delegation ancestry`);
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_delegations (session_id, ticket_id, parent_session_id, depth)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, ticketId, delegation.parentSessionId, delegation.depth);
  }

  private recordGrants(sessionId: string, birth: SessionGrantBirth): void {
    for (const grant of birth.grants) {
      // `session.start` is the only grant this build's schema can store, and
      // `isVerbToolKey` is not a second opinion on that — it is the vocabulary
      // check every other name has to pass before it could ever be added here.
      if (grant !== "session.start") {
        const known = isVerbToolKey(grant) ? "is not a Session delegation grant" : "is not a verb";
        throw new Error(`${grant} ${known} this build can record`);
      }
    }
    const wantsStart = birth.grants.includes("session.start");
    const existing = this.readStartGrant(sessionId);
    if (!wantsStart) {
      if (existing !== null) {
        throw new Error(`Session ${sessionId} already has an unexpected start grant`);
      }
      return;
    }
    const delegation = birth.delegation;
    if (delegation === null) throw new Error("A start grant needs delegation ancestry");
    if (existing !== null) {
      if (
        existing.maxDepth !== delegation.maxDepth ||
        existing.maxChildren !== delegation.maxChildren
      ) {
        throw new Error(`Session ${sessionId} already has a different start grant`);
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_verb_grants (session_id, verb, scope, max_depth, max_children)
         VALUES (?, 'session.start', 'own-ticket', ?, ?)`,
      )
      .run(sessionId, delegation.maxDepth, delegation.maxChildren);
  }

  private completeClaim(
    ref: DelegationClaimRef,
    opened: { ticketId: string; childSessionId: string },
  ): void {
    const existing = this.readClaim(ref);
    if (existing === undefined || existing.ticket_id !== opened.ticketId) {
      throw new Error("The delegation claim that opened this Session was not found");
    }
    if (existing.child_session_id !== null && existing.child_session_id !== opened.childSessionId) {
      throw new Error("A delegation claim cannot open two Sessions");
    }
    if (existing.child_session_id === null) {
      this.db
        .prepare(
          `UPDATE session_delegation_claims
              SET child_session_id = ?
            WHERE parent_session_id = ? AND tool_call_id = ?`,
        )
        .run(opened.childSessionId, ref.parentSessionId, ref.toolCallId);
    }
    this.#inFlightClaims.delete(claimKey(ref));
  }

  private readDelegationGrant(sessionId: string): DelegationRow | null {
    const row = this.db
      .prepare(
        `SELECT d.ticket_id, d.parent_session_id, d.depth, g.scope, g.max_depth, g.max_children
           FROM session_delegations d
           JOIN session_verb_grants g ON g.session_id = d.session_id
          WHERE d.session_id = ? AND g.verb = 'session.start'`,
      )
      .get(sessionId) as DelegationRow | undefined;
    if (
      row === undefined ||
      row.scope !== "own-ticket" ||
      !isNonNegativeInteger(row.depth) ||
      !isDelegationDepth(row.max_depth) ||
      !isDelegationChildren(row.max_children)
    ) {
      return null;
    }
    return row;
  }
}

export function createTicketSessionDelegationStore(
  db: Database.Database,
): TicketSessionDelegationStore {
  return new TicketSessionDelegationStore(db);
}

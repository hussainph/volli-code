/**
 * Durable birth grants for Ticket Session delegation.
 *
 * The Verb Registry key remains `session.start`. Its narrower authority is not
 * encoded into a second key: the per-Session row carries `scope: own-ticket`,
 * and the tool door reads that scope against its bound caller identity. That
 * keeps provider tool projection, Registry validation, and durable grant data
 * in their separate jobs.
 */
import type Database from "better-sqlite3";
import { isVerbToolKey } from "@volli/shared";
import type { RuntimeSessionRole, VerbToolKey } from "@volli/shared";

/**
 * The role-default grant, recorded per Session rather than added to the Ticket
 * Role bundle. One child generation lets an executor enlist a reviewer, fixer,
 * or parallel implementer; three direct children bound the worktree fan-out.
 */
/** The largest supported ancestor chain: at most 1 + 3 + 9 Sessions. */
export const MAX_TICKET_SESSION_DELEGATION_DEPTH = 2;
/** Per-parent cap, kept small enough that the shared worktree stays legible. */
export const MAX_TICKET_SESSION_DELEGATION_CHILDREN = 3;

export const DEFAULT_TICKET_SESSION_DELEGATION = Object.freeze({
  maxDepth: 1,
  maxChildren: 3,
});

/** The ancestry and limits frozen into one Ticket Session at its birth. */
export interface TicketSessionDelegation {
  parentSessionId: string | null;
  /** Root Sessions are depth zero; a child is its parent's depth plus one. */
  depth: number;
  maxDepth: number;
  maxChildren: number;
  /** The parent tool call whose durable claim opened this child, if any. */
  claimToolCallId: string | null;
}

/** What the Session-start seam needs before it resolves the frozen tool surface. */
export interface SessionGrantBirth {
  /** Canonical Verb Registry keys that feed resolveAgentToolSurface. */
  grants: readonly VerbToolKey[];
  /** Null for a Project Session; retained even when a child reaches the depth cap. */
  delegation: TicketSessionDelegation | null;
}

/**
 * The narrow birth seam the Sessions facade owns. It derives policy before a
 * Session exists, then records exactly that answer before any attachment can
 * receive the resolved tool surface.
 */
export interface SessionGrantPorts {
  resolveBirth(input: {
    role: RuntimeSessionRole;
    ticketId: string | null;
    delegation?: TicketSessionDelegation;
  }): SessionGrantBirth;
  recordBirth(sessionId: string, birth: SessionGrantBirth): void;
}

export type TicketDelegationClaim =
  | { ok: true; delegation: TicketSessionDelegation }
  | { ok: false; reason: "not-granted" | "limit" };

/** The tool-door half: a durable, idempotent unit of the parent grant's fan-out. */
export interface TicketSessionDelegationClaims {
  claimStart(input: {
    parentSessionId: string;
    ticketId: string;
    toolCallId: string;
  }): TicketDelegationClaim;
  /** Release only a claim proved not to have created a durable Session. */
  releaseIfUnstarted(input: {
    parentSessionId: string;
    toolCallId: string;
    createCommandId: string;
  }): void;
}

interface StartGrantRow {
  scope: string;
  max_depth: number;
  max_children: number;
}

interface DelegationRow extends StartGrantRow {
  ticket_id: string;
  parent_session_id: string | null;
  depth: number;
}

interface ClaimRow {
  ticket_id: string;
  child_session_id: string | null;
}

/**
 * The app-owned grants store. No renderer or agent-socket write reaches it:
 * only Session birth persists a grant, and only a bound named tool may consume
 * an already-persisted one.
 */
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
    if (input.ticketId === null) {
      throw new Error("A Ticket Session needs a Ticket before grants can resolve");
    }
    const delegation = input.delegation ?? {
      parentSessionId: null,
      depth: 0,
      maxDepth: DEFAULT_TICKET_SESSION_DELEGATION.maxDepth,
      maxChildren: DEFAULT_TICKET_SESSION_DELEGATION.maxChildren,
      claimToolCallId: null,
    };
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
      if (birth.delegation.parentSessionId !== null && birth.delegation.claimToolCallId !== null) {
        this.completeClaim({
          parentSessionId: birth.delegation.parentSessionId,
          ticketId: session.ticket_id,
          toolCallId: birth.delegation.claimToolCallId,
          childSessionId: sessionId,
        });
      }
    })();
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

  claimStart(input: {
    parentSessionId: string;
    ticketId: string;
    toolCallId: string;
  }): TicketDelegationClaim {
    if (input.toolCallId.length === 0) throw new Error("A delegation claim needs a tool call id");
    const key = claimKey(input.parentSessionId, input.toolCallId);
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
      const existing = this.db
        .prepare(
          `SELECT ticket_id, child_session_id
             FROM session_delegation_claims
            WHERE parent_session_id = ? AND tool_call_id = ?`,
        )
        .get(input.parentSessionId, input.toolCallId) as ClaimRow | undefined;
      if (existing !== undefined) {
        if (existing.ticket_id !== input.ticketId) {
          throw new Error("A replayed delegation call cannot change its Ticket");
        }
        this.#inFlightClaims.add(key);
        return {
          ok: true,
          delegation: claimedDelegation(parent, input.parentSessionId, input.toolCallId),
        } as const;
      }
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM session_delegation_claims WHERE parent_session_id = ?",
        )
        .get(input.parentSessionId) as { count: number };
      if (count.count >= parent.max_children) return { ok: false, reason: "limit" } as const;
      this.db
        .prepare(
          `INSERT INTO session_delegation_claims
             (parent_session_id, tool_call_id, ticket_id, child_session_id, created_at)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(input.parentSessionId, input.toolCallId, input.ticketId, Date.now());
      this.#inFlightClaims.add(key);
      return {
        ok: true,
        delegation: claimedDelegation(parent, input.parentSessionId, input.toolCallId),
      } as const;
    })();
  }

  releaseIfUnstarted(input: {
    parentSessionId: string;
    toolCallId: string;
    createCommandId: string;
  }): void {
    const key = claimKey(input.parentSessionId, input.toolCallId);
    this.db.transaction(() => {
      // A Session Engine create command is durable evidence that a retry must
      // preserve the slot: it can replay the same child and finish recording
      // its birth grant after a crash or a later start failure.
      const created = this.db
        .prepare("SELECT session_id FROM session_commands WHERE id = ?")
        .get(input.createCommandId);
      if (created !== undefined) {
        this.#inFlightClaims.delete(key);
        return;
      }
      this.db
        .prepare(
          `DELETE FROM session_delegation_claims
            WHERE parent_session_id = ? AND tool_call_id = ? AND child_session_id IS NULL`,
        )
        .run(input.parentSessionId, input.toolCallId);
      this.#inFlightClaims.delete(key);
    })();
  }

  private clearAbandonedClaims(parentSessionId: string): void {
    const pending = this.db
      .prepare(
        `SELECT tool_call_id
           FROM session_delegation_claims
          WHERE parent_session_id = ? AND child_session_id IS NULL`,
      )
      .all(parentSessionId) as Array<{ tool_call_id: string }>;
    for (const { tool_call_id: toolCallId } of pending) {
      if (this.#inFlightClaims.has(claimKey(parentSessionId, toolCallId))) continue;
      const created = this.db
        .prepare("SELECT session_id FROM session_commands WHERE id = ?")
        .get(createCommandId(parentSessionId, toolCallId));
      if (created !== undefined) continue;
      this.db
        .prepare(
          `DELETE FROM session_delegation_claims
            WHERE parent_session_id = ? AND tool_call_id = ? AND child_session_id IS NULL`,
        )
        .run(parentSessionId, toolCallId);
    }
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
      | { ticket_id: string; parent_session_id: string | null; depth: number }
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
    const wantsStart = birth.grants.includes("session.start");
    for (const grant of birth.grants) {
      if (!isVerbToolKey(grant) || grant !== "session.start") {
        throw new Error(`${grant} is not a Session delegation grant this build can record`);
      }
    }
    const existing = this.readStartGrant(sessionId);
    if (!wantsStart) {
      if (existing !== null)
        throw new Error(`Session ${sessionId} already has an unexpected start grant`);
      return;
    }
    const delegation = birth.delegation;
    if (delegation === null) throw new Error("A start grant needs delegation ancestry");
    if (existing !== null) {
      if (
        existing.scope !== "own-ticket" ||
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

  private completeClaim(input: {
    parentSessionId: string;
    ticketId: string;
    toolCallId: string;
    childSessionId: string;
  }): void {
    const existing = this.db
      .prepare(
        `SELECT ticket_id, child_session_id
           FROM session_delegation_claims
          WHERE parent_session_id = ? AND tool_call_id = ?`,
      )
      .get(input.parentSessionId, input.toolCallId) as ClaimRow | undefined;
    if (existing === undefined || existing.ticket_id !== input.ticketId) {
      throw new Error("The delegation claim that opened this Session was not found");
    }
    if (existing.child_session_id !== null && existing.child_session_id !== input.childSessionId) {
      throw new Error("A delegation claim cannot open two Sessions");
    }
    if (existing.child_session_id === null) {
      this.db
        .prepare(
          `UPDATE session_delegation_claims
              SET child_session_id = ?
            WHERE parent_session_id = ? AND tool_call_id = ?`,
        )
        .run(input.childSessionId, input.parentSessionId, input.toolCallId);
    }
    this.#inFlightClaims.delete(claimKey(input.parentSessionId, input.toolCallId));
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

function claimedDelegation(
  parent: DelegationRow,
  parentSessionId: string,
  toolCallId: string,
): TicketSessionDelegation {
  return {
    parentSessionId,
    depth: parent.depth + 1,
    maxDepth: parent.max_depth,
    maxChildren: parent.max_children,
    claimToolCallId: toolCallId,
  };
}

function cloneDelegation(delegation: TicketSessionDelegation): TicketSessionDelegation {
  return { ...delegation };
}

function assertDelegation(value: TicketSessionDelegation): void {
  if (!isNonNegativeInteger(value.depth))
    throw new Error("Delegation depth must be a whole number");
  if (!isDelegationDepth(value.maxDepth)) {
    throw new Error("Delegation max depth exceeds the hard ceiling");
  }
  if (!isDelegationChildren(value.maxChildren)) {
    throw new Error("Delegation max children exceeds the hard ceiling");
  }
  if (value.depth === 0 && value.parentSessionId !== null) {
    throw new Error("A root delegation cannot name a parent Session");
  }
  if (value.depth > 0 && value.parentSessionId === null) {
    throw new Error("A child delegation must name its parent Session");
  }
  if (value.depth > value.maxDepth) {
    throw new Error("Delegation depth cannot exceed its frozen max depth");
  }
  if (value.parentSessionId === null && value.claimToolCallId !== null) {
    throw new Error("A root delegation cannot name a parent tool claim");
  }
  if (value.parentSessionId !== null && value.claimToolCallId === null) {
    throw new Error("A child delegation must name the parent tool claim that opened it");
  }
  if (value.claimToolCallId !== null && value.claimToolCallId.length === 0) {
    throw new Error("A delegation claim id cannot be empty");
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isDelegationDepth(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_TICKET_SESSION_DELEGATION_DEPTH;
}

function isDelegationChildren(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_TICKET_SESSION_DELEGATION_CHILDREN;
}

function claimKey(parentSessionId: string, toolCallId: string): string {
  return `${parentSessionId}:${toolCallId}`;
}

function createCommandId(parentSessionId: string, toolCallId: string): string {
  return `${claimKey(parentSessionId, toolCallId)}:create`;
}

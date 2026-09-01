/**
 * What in-ticket delegation MEANS, with no database in the room (VC-183).
 *
 * The rules over a Ticket Session's `session.start` grant — its ancestry, its
 * two limits, and the ports the rest of main reaches it through — are decidable
 * from values alone. They live here so the store beside this file is only the
 * durable half: SQL, transactions, and the claim ledger.
 *
 * The Verb Registry key stays `session.start`. Its narrower authority is not
 * encoded into a second key: the grant carries `scope: own-ticket` separately,
 * and the tool door reads that scope against its bound caller identity. That
 * keeps provider tool projection, Registry validation, and durable grant data
 * in their separate jobs.
 */
import type { RuntimeSessionRole, VerbToolKey } from "@volli/shared";

/**
 * The largest delegation chain this build will record.
 *
 * One generation: a root Ticket Session may enlist reviewers, fixers or
 * parallel implementers, and none of them may enlist anyone. Raising it is a
 * migration (`session_verb_grants.max_depth` pins the same number), which is
 * the point — a fork-bomb bound that a caller could widen at runtime would not
 * be a bound.
 */
export const MAX_TICKET_SESSION_DELEGATION_DEPTH = 1;

/**
 * Per-parent allowance, kept small enough that the shared worktree stays
 * legible.
 *
 * An allowance, not a wall (VC-204): this is what a Ticket Session may spend on
 * its own authority. The end of it is judged by the project's budget posture —
 * `ask` parks the next start in front of the person driving, whose "once" is
 * recorded as one extension row in the claims ledger; `refuse` keeps the old
 * hard stop. What no posture changes is that the Session cannot widen this
 * number itself: the stored grant is pinned by a schema CHECK, and extensions
 * are written only from a person's answer through the interaction ledger.
 */
export const MAX_TICKET_SESSION_DELEGATION_CHILDREN = 3;

/**
 * The role-default grant, recorded per Session rather than added to the Ticket
 * Role bundle. Both values equal the hard ceilings above today; they are stated
 * separately because they answer different questions — what a new root Session
 * is handed, versus what any stored row is allowed to say.
 */
export const DEFAULT_TICKET_SESSION_DELEGATION = Object.freeze({
  maxDepth: MAX_TICKET_SESSION_DELEGATION_DEPTH,
  maxChildren: MAX_TICKET_SESSION_DELEGATION_CHILDREN,
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

/**
 * One tool call's claim on a fan-out slot, named the same way in every method
 * that handles one. The pair is an identity, not two loose strings: `claimKey`
 * and the claims table's primary key are both exactly this.
 */
export interface DelegationClaimRef {
  parentSessionId: string;
  toolCallId: string;
}

export type TicketDelegationClaim =
  | { ok: true; delegation: TicketSessionDelegation }
  | { ok: false; reason: "not-granted" }
  /**
   * `allowed` is the whole current allowance — the born grant plus every
   * person-approved extension — so a refusal can name the real number rather
   * than the born one after "once" has already been said.
   */
  | { ok: false; reason: "limit"; allowed: number };

/** The tool-door half: a durable, idempotent unit of the parent grant's fan-out. */
export interface TicketSessionDelegationClaims {
  /**
   * Whether this Session was BORN with a scoped start grant, regardless of what
   * Role it presents as today.
   *
   * The door needs the born answer rather than the live one. Deleting a Ticket
   * sets `sessions.ticket_id` to NULL, so a Ticket Session can later attach as
   * a ticketless — that is, `project` Role — Session while its frozen tool
   * surface still names `session.start`. Reading the durable grant is what
   * keeps that Session inside the bound it was granted under.
   */
  startGrantScope(sessionId: string): "own-ticket" | null;
  claimStart(
    input: DelegationClaimRef & {
      ticketId: string;
      /** The Session Engine command id the start about to run will write. */
      createCommandId: string;
    },
  ): TicketDelegationClaim;
  /** Release only a claim proved not to have created a durable Session. */
  releaseIfUnstarted(input: DelegationClaimRef): void;
  /**
   * Record one person-approved slot past the born allowance (VC-204).
   *
   * Written only after the person driving answered "once" to this call's
   * budget ask — never from any agent-reachable path — and keyed by the asking
   * tool call so a replayed call finds its extension rather than earning a
   * second. The slot belongs to the parent, not the call: if the start it was
   * granted for never became durable, the next attempt spends it without
   * asking again, which is what the person's "one more" meant.
   */
  recordExtension(input: DelegationClaimRef): void;
}

/** The claims table's primary key, as one string. */
export function claimKey({ parentSessionId, toolCallId }: DelegationClaimRef): string {
  return `${parentSessionId}:${toolCallId}`;
}

/** The child ancestry one accepted claim confers. */
export function claimedDelegation(
  parent: { depth: number; maxDepth: number; maxChildren: number },
  ref: DelegationClaimRef,
): TicketSessionDelegation {
  return {
    parentSessionId: ref.parentSessionId,
    depth: parent.depth + 1,
    maxDepth: parent.maxDepth,
    maxChildren: parent.maxChildren,
    claimToolCallId: ref.toolCallId,
  };
}

export function cloneDelegation(delegation: TicketSessionDelegation): TicketSessionDelegation {
  return { ...delegation };
}

/** The ancestry a Ticket Session with no delegating parent is born holding. */
export function cloneDelegationDefaults(): TicketSessionDelegation {
  return {
    parentSessionId: null,
    depth: 0,
    maxDepth: DEFAULT_TICKET_SESSION_DELEGATION.maxDepth,
    maxChildren: DEFAULT_TICKET_SESSION_DELEGATION.maxChildren,
    claimToolCallId: null,
  };
}

/**
 * Every way an ancestry value can be internally incoherent, refused loudly.
 *
 * Called on both sides of the durable boundary — before a birth is recorded and
 * after a row is read back — because the two failures it catches are different:
 * a caller bug on the way in, and stale or hand-edited data on the way out.
 */
export function assertDelegation(value: TicketSessionDelegation): void {
  if (!isNonNegativeInteger(value.depth)) {
    throw new Error("Delegation depth must be a whole number");
  }
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

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function isDelegationDepth(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_TICKET_SESSION_DELEGATION_DEPTH;
}

export function isDelegationChildren(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_TICKET_SESSION_DELEGATION_CHILDREN;
}

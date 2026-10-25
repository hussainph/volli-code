/**
 * The Actor (v1): who did a board or Session fact in Volli Cloud.
 *
 * Attribution names the PERSON, not the membership: every arm that names a
 * human carries a `userId`, and membership is resolved at read time. That is
 * what lets attribution survive a project moving Workspace, a Member being
 * suspended or removed, and account deletion (the user row stays as a
 * tombstone that renders "Deleted user").
 *
 * - `person`: a person acting through a client.
 * - `agent`: an agent acting for the Session owner. `userId` IS the owner, so
 *   "Hussain · via agent" filters with Hussain's own work.
 * - `automation`: an Automation run, acting with its armer's credentials.
 * - `volli`: Volli's own machinery. `runnerId` is set when a runner did it on
 *   its own (a Working copy report, a trim it ran) and `onBehalfOf` names the
 *   person whose work it was. A runner is never an actor in its own right,
 *   because it always works for its owner.
 * - `legacy`: rows migrated from a local profile where no person can be named.
 *
 * Closed on write, open on read: a writer can only build these five arms, and
 * {@link readActor} turns an arm this build does not know into
 * {@link UnknownActor} (rendered "Unknown") instead of failing the read. A
 * malformed field inside a KNOWN arm is corruption and still throws.
 */

import { parseId, readId, type RunnerId, type SessionId, type TicketId, type UserId } from "./ids";

export const ACTOR_KINDS = ["person", "agent", "automation", "volli", "legacy"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** The client a person acted through. */
export const CLIENT_KINDS = ["desktop", "web", "phone", "cli", "runner"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** Why Volli's own machinery acted. */
export const VOLLI_REASONS = [
  "retention",
  "merge_watch",
  "migration",
  "watch_notice",
  "subagent_notice",
  "relaunch_recovery",
  "scheduled_resume",
  "supervision",
  "browser_notice",
  "shell_notice",
  "worktree_notice",
  "auto_title",
  "policy",
  "billing",
] as const;
export type VolliReason = (typeof VOLLI_REASONS)[number];

/** What a migrated local actor token was, where no person could be named. */
export const LEGACY_ACTOR_TOKENS = ["user", "session", "automation", "unauthenticated"] as const;
export type LegacyActorToken = (typeof LEGACY_ACTOR_TOKENS)[number];

export interface PersonActor {
  kind: "person";
  userId: UserId;
  via?: ClientKind;
}

export interface AgentActor {
  kind: "agent";
  /** The Session owner the agent acts for. */
  userId: UserId;
  sessionId: SessionId;
  ticketId?: TicketId | null;
}

export interface AutomationActor {
  kind: "automation";
  /** The person who armed or created the Automation. */
  userId: UserId;
  automationId: string;
  runId: string;
  sessionId?: SessionId;
}

export interface VolliActor {
  kind: "volli";
  reason: VolliReason;
  onBehalfOf?: UserId;
  runnerId?: RunnerId;
}

export interface LegacyActor {
  kind: "legacy";
  was: LegacyActorToken;
  /** Kept verbatim from the local row; not necessarily a UUID. */
  sessionId?: string;
}

export type Actor = PersonActor | AgentActor | AutomationActor | VolliActor | LegacyActor;

/** An actor arm written by a newer build. Renders as "Unknown"; never written. */
export interface UnknownActor {
  kind: "unknown";
  /** The stored kind, when it was a string. */
  storedKind: string | null;
}

/** Thrown for a malformed field inside a known actor arm: corruption, not evolution. */
export class MalformedActorError extends Error {
  readonly code = "malformed_actor";
  constructor(detail: string) {
    super(`Malformed actor: ${detail}`);
    this.name = "MalformedActorError";
  }
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function field(row: Record<string, unknown>, name: string): unknown {
  return row[name];
}

function requireString(row: Record<string, unknown>, name: string): string {
  const value = field(row, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedActorError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireUser(row: Record<string, unknown>, name: string): UserId {
  try {
    return parseId("user", field(row, name));
  } catch {
    throw new MalformedActorError(`${name} must be a user id`);
  }
}

function optionalId<K extends "user" | "session" | "runner">(
  row: Record<string, unknown>,
  name: string,
  kind: K,
) {
  const value = field(row, name);
  if (value === undefined) return undefined;
  const id = readId(kind, value);
  if (id === null) throw new MalformedActorError(`${name} must be a ${kind} id when present`);
  return id;
}

/**
 * Reads a stored actor. Unknown arms become {@link UnknownActor}; a malformed
 * known arm throws {@link MalformedActorError}. Fields this build does not
 * know are dropped, so a newer optional field never fails an older reader.
 */
export function readActor(value: unknown): Actor | UnknownActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedActorError("not an object");
  }
  const row = value as Record<string, unknown>;
  const kind = row["kind"];
  switch (kind) {
    case "person": {
      const userId = requireUser(row, "userId");
      const via = row["via"];
      if (via !== undefined && typeof via !== "string") {
        throw new MalformedActorError("via must be a string when present");
      }
      // `via` is decoration: a client kind this build does not know reads as
      // absent (an unnamed client), which is true, rather than as corruption.
      return includes(CLIENT_KINDS, via)
        ? { kind: "person", userId, via }
        : { kind: "person", userId };
    }
    case "agent": {
      const sessionId = parseAgentSession(row);
      const ticketId = row["ticketId"];
      const actor: AgentActor = { kind: "agent", userId: requireUser(row, "userId"), sessionId };
      if (ticketId === null) actor.ticketId = null;
      else if (ticketId !== undefined) {
        const parsed = readId("ticket", ticketId);
        if (parsed === null) throw new MalformedActorError("ticketId must be a ticket id or null");
        actor.ticketId = parsed;
      }
      return actor;
    }
    case "automation": {
      const sessionId = optionalId(row, "sessionId", "session");
      return {
        kind: "automation",
        userId: requireUser(row, "userId"),
        automationId: requireString(row, "automationId"),
        runId: requireString(row, "runId"),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    }
    case "volli": {
      const reason = row["reason"];
      if (typeof reason !== "string") throw new MalformedActorError("reason must be a string");
      const onBehalfOf = optionalId(row, "onBehalfOf", "user");
      const runnerId = optionalId(row, "runnerId", "runner");
      // A reason this build does not know is a newer variant: read it as
      // Unknown rather than guess which of ours it is closest to.
      if (!includes(VOLLI_REASONS, reason)) return { kind: "unknown", storedKind: "volli" };
      return {
        kind: "volli",
        reason,
        ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
        ...(runnerId === undefined ? {} : { runnerId }),
      };
    }
    case "legacy": {
      const was = row["was"];
      if (!includes(LEGACY_ACTOR_TOKENS, was)) {
        throw new MalformedActorError("was must be a legacy actor token");
      }
      const sessionId = row["sessionId"];
      if (sessionId !== undefined && typeof sessionId !== "string") {
        throw new MalformedActorError("sessionId must be a string when present");
      }
      return { kind: "legacy", was, ...(sessionId === undefined ? {} : { sessionId }) };
    }
    default:
      return { kind: "unknown", storedKind: typeof kind === "string" ? kind : null };
  }
}

function parseAgentSession(row: Record<string, unknown>): SessionId {
  const sessionId = readId("session", row["sessionId"]);
  if (sessionId === null) throw new MalformedActorError("sessionId must be a session id");
  return sessionId;
}

/**
 * The person a fact is attributed to, for "filter by person" and for
 * membership checks: the human arms' `userId`, Volli's `onBehalfOf`, or
 * `null` when no person can be named.
 */
export function actorUserId(actor: Actor | UnknownActor): UserId | null {
  switch (actor.kind) {
    case "person":
    case "agent":
    case "automation":
      return actor.userId;
    case "volli":
      return actor.onBehalfOf ?? null;
    case "legacy":
    case "unknown":
      return null;
  }
}

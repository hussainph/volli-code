/**
 * The pure pieces of the row → record mapping: actor
 * attribution, fractional position keys and derived ids. No database, no
 * filesystem; `sources.ts` calls these per row.
 */
import { createHash } from "node:crypto";
import { MIGRATION_PLACEHOLDERS, type Actor, type JsonValue } from "./records";

const USER = MIGRATION_PLACEHOLDERS.userId;
const RUNNER = MIGRATION_PLACEHOLDERS.runnerId;

// ---- Actor v1 ---------------------------------------------------------------

/** The local actor a stored token or JSON names, read as tolerantly as `events-repo.ts` reads it. */
export interface LocalActor {
  kind: "user" | "session" | "automation" | "unauthenticated";
  sessionId: string | null;
  ticketId: string | null;
}

/**
 * Reads a `ticket_events.actor` / `labels.merged_by` value: a bare token, or
 * JSON for the kinds that carry a Session. Follows `events-repo.ts`'s
 * `parseActor`, including its one asymmetry: an unreadable value reads as the
 * user, because that is how today's app has always shown it.
 */
export function parseLocalActor(stored: string): LocalActor {
  if (stored === "user") return { kind: "user", sessionId: null, ticketId: null };
  if (stored === "automation" || stored === "session" || stored === "unauthenticated") {
    return { kind: stored, sessionId: null, ticketId: null };
  }
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown> | null;
    const kind = parsed?.kind;
    if (kind === "user" || kind === "unauthenticated") {
      return { kind, sessionId: null, ticketId: null };
    }
    if (kind === "session" || kind === "automation") {
      return {
        kind,
        sessionId: typeof parsed?.sessionId === "string" ? parsed.sessionId : null,
        ticketId: typeof parsed?.ticketId === "string" ? parsed.ticketId : null,
      };
    }
  } catch {
    // A plain token we do not know: falls through to the user, as today.
  }
  return { kind: "user", sessionId: null, ticketId: null };
}

/**
 * Reads a `ticket_comments.actor` / `ticket_signals.actor` value beside its
 * row's `session_id` column. These columns hold the actor KIND as a bare token
 * (`user`, `session`, `automation`, `unauthenticated`) or a pre-Session
 * harness author (`agent:<harnessId>`); the Session, when there is one, rides
 * in the separate column.
 */
export function parseColumnActor(stored: string, sessionId: string | null): LocalActor {
  if (stored === "session" || stored.startsWith("agent:")) {
    return { kind: "session", sessionId, ticketId: null };
  }
  if (stored === "automation" || stored === "unauthenticated") {
    return { kind: stored, sessionId, ticketId: null };
  }
  return { kind: "user", sessionId: null, ticketId: null };
}

/** What `toActor` needs to know beyond the local actor itself. */
export interface ActorContext {
  /** The Automation Run whose Session this is, when an Automation started it. */
  automationRunOf(sessionId: string): { automationId: string | null; runId: string } | undefined;
  /** The board event kind, for an automation actor no Session explains. */
  eventKind?: string;
}

/**
 * The mapping from today's actors to cloud Actors.
 *
 * - `user` → `person` (the migrating person; a local profile has one).
 * - `session` with its Session → `agent` acting for that person.
 * - `automation` with a Session an Automation Run started → `automation`.
 * - `automation` with no Session: the PR merge watch and the retention pass
 *   are Volli's own machinery acting for the person, so `volli` with the
 *   reason the event kind names. Any other is `legacy`: nothing says why.
 * - `unauthenticated`, or a Session-kind actor that lost its Session id →
 *   `legacy`, the one arm for a row no person can be named for.
 */
export function toActor(local: LocalActor, context: ActorContext): Actor {
  switch (local.kind) {
    case "user":
      return { kind: "person", userId: USER };
    case "unauthenticated":
      return { kind: "legacy", was: "unauthenticated" };
    case "session":
      if (local.sessionId === null) return { kind: "legacy", was: "session" };
      return {
        kind: "agent",
        userId: USER,
        sessionId: local.sessionId,
        ...(local.ticketId === null ? {} : { ticketId: local.ticketId }),
      };
    case "automation": {
      if (local.sessionId !== null) {
        const run = context.automationRunOf(local.sessionId);
        if (run !== undefined && run.automationId !== null) {
          return {
            kind: "automation",
            userId: USER,
            automationId: run.automationId,
            runId: run.runId,
            sessionId: local.sessionId,
          };
        }
        return { kind: "legacy", was: "automation", sessionId: local.sessionId };
      }
      const reason = volliReasonFor(context.eventKind);
      if (reason === null) return { kind: "legacy", was: "automation" };
      return { kind: "volli", reason, onBehalfOf: USER, runnerId: RUNNER };
    }
  }
}

function volliReasonFor(kind: string | undefined): "retention" | "merge_watch" | null {
  if (kind === "pr_merged") return "merge_watch";
  if (kind === "worktree_reclaimed" || kind === "worktree_trimmed") return "retention";
  return null;
}

// ---- fractional position keys -----------------------------------------------

/** `fractional-indexing`'s base-62 digit alphabet. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The `index`-th (0-based) key of `generateNKeysBetween(null, null, n)` from
 * `fractional-indexing` (Greenspan's algorithm): `a0`, `a1`, … `az`,
 * `b00`, `b01`, … Successive integer keys, each sorting after the last, so a
 * column's old integer order becomes key order and the board's own generator can
 * insert between any two of them.
 *
 * Kept here rather than taking the dependency because migration only ever
 * needs this one sequence; `transform.test.ts` pins it against values the
 * library produces.
 */
export function sequentialPositionKey(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`bad key index ${index}`);
  let remaining = index;
  // Head `a` holds 62 one-digit keys, `b` 62² two-digit keys, and so on; 62⁹
  // already exceeds every safe integer, so the walk never reaches past `i`.
  for (let width = 1; ; width += 1) {
    const capacity = DIGITS.length ** width;
    if (remaining < capacity) {
      let digits = "";
      let value = remaining;
      for (let place = 0; place < width; place += 1) {
        digits = DIGITS[value % DIGITS.length]! + digits;
        value = Math.floor(value / DIGITS.length);
      }
      return String.fromCharCode("a".charCodeAt(0) + width - 1) + digits;
    }
    remaining -= capacity;
  }
}

// ---- derived ids ------------------------------------------------------------

/**
 * The UUIDv5 namespace for records the export makes that have no source row.
 *
 * DURABLE, not live: a re-run of the export, and the importer's "skip rows
 * whose digest matches" rule, both depend on the same input
 * naming the same id. Changing this constant or any `derivedId` input
 * spelling duplicates every derived record on the next import.
 */
export const MIGRATION_DERIVED_ID_NAMESPACE = "5b0f6c0e-3c1f-4f7a-9c43-6f2a1d3e8b57";

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/** RFC 9562 UUIDv5 of `parts` joined by `\u0000` under {@link MIGRATION_DERIVED_ID_NAMESPACE}. */
export function derivedId(...parts: readonly string[]): string {
  const hash = createHash("sha1")
    .update(uuidBytes(MIGRATION_DERIVED_ID_NAMESPACE))
    .update(parts.join("\u0000"), "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id of a project's primary repo, derived from the project id. */
export function primaryRepoId(projectId: string): string {
  return derivedId("project-repo", projectId, "primary");
}

/** The id of a ticket's Working copy on the migrating Mac, derived from the ticket id. */
export function workingCopyId(ticketId: string): string {
  return derivedId("working-copy", ticketId, "primary");
}

/** The id of a config entry made from a column or a setting. */
export function configEntryId(scope: string, kind: string, name: string): string {
  return derivedId("config-entry", scope, kind, name);
}

// ---- small helpers ----------------------------------------------------------

/** The last path segment, `/` or `\` separated; the whole string when it has none. */
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segment = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  return segment === "" ? path : segment;
}

/** Parses a JSON column, or answers `undefined` when the text is not JSON. */
export function parseJsonColumn(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** The PR number a GitHub-style pull URL names, or null. */
export function pullRequestNumber(url: string): number | null {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match === null ? null : Number(match[1]);
}

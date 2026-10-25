/**
 * The activity feed reader: board events, newest first, across one or more
 * projects of one Workspace, filtered for the viewer and folded into feed
 * items (`ActivityFold` in `@volli/shared/cloud`).
 *
 * There is no feed store (A3 §2.9). A project's history is its
 * `by_project_seq` range; a Workspace's is a k-way merge of its projects'
 * ranges by `occurredAt` (each project's own order stays its `seq`). Every
 * stream is read lazily, one event at a time, so a page reads only what it
 * shows plus each project's next event.
 *
 * Pages follow Convex's pagination contract with a cursor of our own:
 * - `cursor` is where the previous page stopped: per project, the lowest
 *   `seq` already shown (events below it come next), plus the time of the
 *   last event shown. A project that joined the scope after the cursor was
 *   minted (created, or moved in) has no bound: its events count as newer
 *   than the cursor when at or after that time, and its older history waits
 *   for a fresh load rather than interleaving out of order.
 * - `endCursor` pins a loaded page to where it ended, so it grows at the top
 *   as new events arrive instead of sliding down and leaving a gap before the
 *   next page. A client pins each page once it requests the one after it.
 * - A page ends only where a folded run ends: once `numItems` items are full,
 *   it keeps taking events while they join the last item. So the pages a
 *   client concatenates are exactly the fold of the whole history.
 * - A page reads at most {@link MAX_FEED_SCAN} events (hidden ones count),
 *   and returns what it has with `isDone: false` when it hits that bound.
 *
 * What the viewer may see: the caller has already checked that they are an
 * active Member of the Workspace, which covers every board event; an event
 * of a deleted ticket is left out, and so is one naming a Session the
 * viewer cannot see (see {@link sessionVisibility}).
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError } from "convex/values";

import {
  ActivityFold,
  activityTicketIds,
  activityUserIds,
  actorUserId,
  canSeeSession,
  readActivityEvent,
  renderTicketKey,
  type ActivityEvent,
  type ActivityPage,
  type ActivityPersonRef,
  type ActivityTicketRef,
  type MembershipFacts,
  type PolicyFacts,
  type ProjectId,
  type TicketId,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";
import type { Viewer } from "./auth";

type Reader = { db: GenericDatabaseReader<DataModel> };

/** The most events one page reads, hidden ones included. */
export const MAX_FEED_SCAN = 2000;

/** The most items a page may ask for. */
export const MAX_FEED_ITEMS = 200;

export type FeedErrorCode = "invalid_cursor" | "invalid_page_size";

export function feedError(
  code: FeedErrorCode,
  message: string,
): ConvexError<{
  code: FeedErrorCode;
  message: string;
}> {
  return new ConvexError({ code, message });
}

// ── the cursor ───────────────────────────────────────────────────────────────

/**
 * Where a page stopped. `bounds[projectId]` is the lowest `seq` shown so far
 * (or, for a project with nothing shown, one past its newest event then): the
 * next page shows that project's events below it. `at` is the time of the
 * last event shown. `done` records that nothing was left below.
 */
export interface FeedCursor {
  at: number;
  bounds: Record<string, number>;
  done: boolean;
}

const CURSOR_VERSION = 1;

export function encodeFeedCursor(cursor: FeedCursor): string {
  return JSON.stringify({ v: CURSOR_VERSION, at: cursor.at, b: cursor.bounds, d: cursor.done });
}

/** A cursor this feed minted, or `invalid_cursor`. */
export function decodeFeedCursor(text: string): FeedCursor {
  const invalid = () => feedError("invalid_cursor", "That page cursor is not valid here.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (typeof raw !== "object" || raw === null) throw invalid();
  const { v: version, at, b: bounds, d: done } = raw as Record<string, unknown>;
  if (version !== CURSOR_VERSION || typeof at !== "number" || typeof done !== "boolean") {
    throw invalid();
  }
  if (typeof bounds !== "object" || bounds === null || Array.isArray(bounds)) throw invalid();
  for (const value of Object.values(bounds)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalid();
  }
  return { at, bounds: bounds as Record<string, number>, done };
}

// ── visibility ───────────────────────────────────────────────────────────────

/**
 * Whether the viewer may see a board event that names a Session: the Session
 * is live, belongs to the event's project, and is the viewer's own, shared,
 * or the Workspace shares everything (`canSeeSession`, with `shareAll`
 * applied at read time). A Session id carried only as attribution (an agent
 * Actor, a `session` origin) does not hide the change: only the payload's own
 * `sessionId` does. Each Session is read once per page.
 *
 * VC-899 (A4) adds `visibleBoardEvents` with the same rule; once it is on
 * main this check delegates to it, so the feed and a ticket's history filter
 * through one function.
 */
export function sessionVisibility(
  ctx: Reader,
  viewer: Viewer,
  membership: MembershipFacts,
  policy: PolicyFacts,
): (event: ActivityEvent) => Promise<boolean> {
  const verdicts = new Map<string, boolean>();
  return async (event) => {
    const sessionId = (event.payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") return true;
    const key = `${event.projectId}:${sessionId}`;
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique();
      verdict =
        session !== null &&
        session.deletedAt === null &&
        session.projectId === event.projectId &&
        canSeeSession(
          viewer,
          { ownerUserId: session.ownerUserId as UserId, visibility: session.visibility },
          { workspaceId: membership.workspaceId },
          membership,
          policy,
        );
      verdicts.set(key, verdict);
    }
    return verdict;
  };
}

// ── the read ─────────────────────────────────────────────────────────────────

export interface FeedScope {
  viewer: Viewer;
  workspaceId: WorkspaceId;
  /** The projects whose history the feed shows: live projects of the Workspace. */
  projects: readonly Doc<"projects">[];
  /** Whether the viewer may see an event (Session visibility). */
  canSee: (event: ActivityEvent) => Promise<boolean>;
}

export interface FeedFilter {
  /** Only what this person did (the human an Actor names, agents and Automations included). */
  person: string | null;
  /** Only events at or after this time. */
  since: number | null;
}

export interface FeedPageOptions {
  numItems: number;
  cursor: string | null;
  endCursor?: string | null;
}

interface Stream {
  project: Doc<"projects">;
  iterator: AsyncIterator<Doc<"boardEvents">>;
  head: Doc<"boardEvents"> | null;
  /** Lower time bound for a project the pinning cursor did not know. */
  notBefore: number | null;
  /** The lowest `seq` consumed on this page. */
  lowest: number | null;
}

/** Newest first across projects: time, then `seq`, then project id (a stable tie-break). */
function newer(a: Doc<"boardEvents">, b: Doc<"boardEvents">): boolean {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt > b.occurredAt;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.projectId > b.projectId;
}

/** One page of the feed over `scope`. */
export async function readFeed(
  ctx: Reader,
  scope: FeedScope,
  filter: FeedFilter,
  options: FeedPageOptions,
): Promise<ActivityPage> {
  const { numItems } = options;
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_FEED_ITEMS) {
    throw feedError("invalid_page_size", `Ask for 1 to ${MAX_FEED_ITEMS} items.`);
  }
  const cursor = options.cursor === null ? null : decodeFeedCursor(options.cursor);
  const end =
    options.endCursor === undefined || options.endCursor === null
      ? null
      : decodeFeedCursor(options.endCursor);

  const streams: Stream[] = [];
  for (const project of scope.projects) {
    const upper = cursor === null ? null : cursor.bounds[project.id];
    // A project the cursor did not know joined later: nothing of it is below the cursor.
    if (cursor !== null && upper === undefined) continue;
    const lower = end === null ? null : end.bounds[project.id];
    const range = ctx.db
      .query("boardEvents")
      .withIndex("by_project_seq", (q) => {
        const inProject = q.eq("projectId", project.id);
        const bounded =
          lower === null || lower === undefined ? inProject : inProject.gte("seq", lower);
        return upper === null || upper === undefined ? bounded : bounded.lt("seq", upper);
      })
      .order("desc");
    const iterator = range[Symbol.asyncIterator]();
    const notBefore = end !== null && lower === undefined ? end.at : null;
    const stream: Stream = { project, iterator, head: null, notBefore, lowest: null };
    await advance(stream, filter);
    streams.push(stream);
  }

  const tickets = new Map<string, Doc<"tickets"> | null>();
  const ticketRow = async (ticketId: string) => {
    if (!tickets.has(ticketId)) {
      const row = await ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", ticketId))
        .unique();
      tickets.set(ticketId, row === null || row.deletedAt !== null ? null : row);
    }
    return tickets.get(ticketId)!;
  };
  const visible = async (row: Doc<"boardEvents">): Promise<ActivityEvent | null> => {
    const event = readActivityEvent(row);
    if (event === null) return null;
    if (filter.person !== null && actorUserId(event.actor) !== filter.person) return null;
    if (event.ticketId !== null && (await ticketRow(event.ticketId)) === null) return null;
    return (await scope.canSee(event)) ? event : null;
  };

  const fold = new ActivityFold();
  let scanned = 0;
  let lastAt: number | null = null;
  let exhausted = false;
  for (;;) {
    let next: Stream | null = null;
    for (const stream of streams) {
      if (stream.head !== null && (next === null || newer(stream.head, next.head!))) next = stream;
    }
    if (next === null) {
      exhausted = true;
      break;
    }
    if (scanned >= MAX_FEED_SCAN) break;
    const row = next.head!;
    const event = await visible(row);
    // A full page ends where a run ends; a pinned page reads to its end.
    if (end === null && event !== null && fold.items.length >= numItems && !fold.joins(event)) {
      break;
    }
    scanned += 1;
    next.lowest = row.seq;
    lastAt = row.occurredAt;
    if (event !== null) fold.add(event);
    await advance(next, filter);
  }

  // A pinned page is done when it reached its end and nothing was left below that end.
  const isDone = exhausted && (end === null || end.done);
  let continueCursor: string;
  if (end !== null && exhausted) {
    continueCursor = options.endCursor!;
  } else {
    const bounds: Record<string, number> = {};
    for (const stream of streams) {
      const bound =
        stream.lowest ??
        (stream.head === null ? null : stream.head.seq + 1) ??
        (cursor === null ? 1 : cursor.bounds[stream.project.id]!);
      bounds[stream.project.id] = bound;
    }
    continueCursor = encodeFeedCursor({ at: lastAt ?? cursor?.at ?? 0, bounds, done: isDone });
  }

  return {
    page: fold.items,
    ...(await references(ctx, scope, fold.items, ticketRow)),
    continueCursor,
    isDone,
  };
}

/** Pulls a stream's next event within its bounds and the filter's time window. */
async function advance(stream: Stream, filter: FeedFilter): Promise<void> {
  const result = await stream.iterator.next();
  const row = result.done === true ? null : result.value;
  const floor = Math.max(filter.since ?? -Infinity, stream.notBefore ?? -Infinity);
  stream.head = row !== null && row.occurredAt >= floor ? row : null;
}

/** The tickets and people a page's items name, resolved for display. */
async function references(
  ctx: Reader,
  scope: FeedScope,
  items: ActivityPage["page"],
  ticketRow: (ticketId: string) => Promise<Doc<"tickets"> | null>,
): Promise<Pick<ActivityPage, "tickets" | "people">> {
  const projects = new Map<string, Doc<"projects"> | null>(
    scope.projects.map((project) => [project.id, project]),
  );
  const projectOf = async (projectId: string) => {
    if (!projects.has(projectId)) {
      const row = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique();
      // A link may name a ticket of another project: resolve it only inside this Workspace.
      const visible =
        row !== null && row.deletedAt === null && row.workspaceId === scope.workspaceId;
      projects.set(projectId, visible ? row : null);
    }
    return projects.get(projectId)!;
  };

  const ticketIds = new Set<TicketId>();
  const userIds = new Set<UserId>();
  for (const item of items) {
    for (const id of activityTicketIds(item)) ticketIds.add(id);
    for (const id of activityUserIds(item)) userIds.add(id);
  }

  const tickets: ActivityTicketRef[] = [];
  for (const ticketId of ticketIds) {
    const ticket = await ticketRow(ticketId);
    if (ticket === null) continue;
    const project = await projectOf(ticket.projectId);
    if (project === null) continue;
    tickets.push({
      id: ticket.id as TicketId,
      projectId: ticket.projectId as ProjectId,
      key: renderTicketKey(project, ticket.number),
      title: ticket.title,
      status: ticket.status,
      archived: ticket.archivedAt !== null,
    });
  }

  const people: ActivityPersonRef[] = [];
  for (const userId of userIds) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", userId))
      .unique();
    if (user === null) continue;
    const deleted = user.status === "deleted";
    people.push({ userId, displayName: deleted ? "Deleted user" : user.displayName, deleted });
  }
  return { tickets, people };
}

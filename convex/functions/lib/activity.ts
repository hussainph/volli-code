/**
 * The activity feed reader: board events, newest first, across one or more
 * projects of one Workspace, filtered for the viewer and folded into feed
 * items (`ActivityFold` in `@volli/shared/cloud`).
 *
 * There is no feed store: a project's history is its `by_project_seq`
 * range; a Workspace's is a k-way merge of its projects' ranges by
 * `occurredAt` (each project's own order stays its `seq`). Every stream is
 * read lazily, one event at a time, so a page reads the events it shows, the
 * hidden ones between them, each project's next event, and the rows that
 * decide visibility and name its references.
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
 *   client concatenates fold like the whole history, page boundaries
 *   included. (A run that grows at the top may re-cut the runs below it once
 *   it passes a span or size bound; that changes how items are cut, never
 *   which events show.)
 * - A page reads at most {@link MAX_FEED_SCAN} events (hidden ones count).
 *   At that bound it stops before its last item, so no run is cut in two
 *   (unless that item is its only one). An unpinned page then returns what it
 *   has with `isDone: false`. A pinned page that cannot reach its end returns
 *   `splitCursor`: the client replaces it with two pinned pages,
 *   `{cursor, endCursor: splitCursor}` and `{cursor: splitCursor, endCursor}`.
 * - `since` and the time bound of a newly joined project stop a project's
 *   stream at its first older event, which assumes a project's `occurredAt`
 *   rises with its `seq` (both are set by the one mutation that appends).
 *
 * Reactivity: a page re-runs when any row it read changes, which includes
 * the tickets, Sessions and people it names (a ticket drag, a Session's turn
 * boundary, a person's hourly `lastSeenAt`). Measure before splitting the
 * references into their own query.
 *
 * What the viewer may see: the caller has already checked that they are an
 * active Member of the Workspace, which covers every board event; an event
 * of a deleted ticket or of a removed comment is left out, and so is one
 * naming a Session the viewer cannot see (see {@link sessionVisibility}).
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError } from "convex/values";

import {
  ActivityFold,
  activityTicketIds,
  activityUserIds,
  actorUserId,
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
import { boardEventVisibility } from "./visibility";

type Reader = { db: GenericDatabaseReader<DataModel> };

/**
 * The most events one page reads, hidden ones included. Each event may also
 * look up its ticket, Session or comment, so this keeps a page well inside
 * Convex's per-function bounds on index ranges and documents read.
 */
export const MAX_FEED_SCAN = 1000;

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
 * Where a page stopped. `bounds[projectId]` is the lowest `seq` read so far
 * (for a project with nothing read yet, one past its next event, or the
 * previous bound, or 1 when it had none in range): the next page reads that
 * project's events below it. `at` is the time of the last event read. `done`
 * records that nothing was left below.
 */
interface FeedCursor {
  at: number;
  bounds: Record<string, number>;
  done: boolean;
}

const CURSOR_VERSION = 1;

function encodeFeedCursor(cursor: FeedCursor): string {
  return JSON.stringify({ v: CURSOR_VERSION, at: cursor.at, b: cursor.bounds, d: cursor.done });
}

/** A cursor this feed minted, or `invalid_cursor`. */
function decodeFeedCursor(text: string): FeedCursor {
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
 * Whether the viewer may see a board event that names a Session: the one
 * Session visibility check every board-event read shares
 * (`boardEventVisibility` in `./visibility`), with `shareAll` applied at read
 * time. Each Session is read once per page.
 */
export function sessionVisibility(
  ctx: Reader,
  viewer: Viewer,
  membership: MembershipFacts,
  policy: PolicyFacts,
): (event: ActivityEvent) => Promise<boolean> {
  return boardEventVisibility(ctx, { viewer, membership, policy });
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
    if (event.payload.kind === "commented") {
      const { commentId } = event.payload;
      const comment = await ctx.db
        .query("ticketComments")
        .withIndex("by_uuid", (q) => q.eq("id", commentId))
        .unique();
      if (comment === null || comment.deletedAt !== null) return null;
    }
    return (await scope.canSee(event)) ? event : null;
  };

  let lastAt: number | null = null;
  /** Where the page stands now, as the next page's cursor. */
  const position = (done: boolean): string => {
    const bounds: Record<string, number> = {};
    for (const stream of streams) {
      bounds[stream.project.id] =
        stream.lowest ??
        (stream.head === null ? null : stream.head.seq + 1) ??
        (cursor === null ? 1 : cursor.bounds[stream.project.id]!);
    }
    return encodeFeedCursor({ at: lastAt ?? cursor?.at ?? 0, bounds, done });
  };

  const fold = new ActivityFold();
  let scanned = 0;
  let exhausted = false;
  /** Where the page stood before the last item's first event. */
  let lastItemStart: string | null = null;
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
    if (event !== null && !fold.joins(event)) {
      // A full page ends where a run ends; a pinned page reads to its end.
      if (end === null && fold.items.length >= numItems) break;
      lastItemStart = position(false);
    }
    scanned += 1;
    next.lowest = row.seq;
    lastAt = row.occurredAt;
    if (event !== null) fold.add(event);
    await advance(next, filter);
  }

  let items = fold.items;
  let stoppedAt: string;
  if (exhausted) {
    stoppedAt = position(end === null || end.done);
  } else if (scanned >= MAX_FEED_SCAN && items.length > 1) {
    // The bound fell inside the last item's run (or might have): leave the
    // whole item to the next page.
    items = items.slice(0, -1);
    stoppedAt = lastItemStart!;
  } else {
    stoppedAt = position(false);
  }
  // A pinned page is done when it reached its end and nothing was left below that end.
  const isDone = exhausted && (end === null || end.done);
  let continueCursor = stoppedAt;
  let split: { splitCursor: string } | null = null;
  if (end !== null) {
    continueCursor = options.endCursor!;
    if (!exhausted) split = { splitCursor: stoppedAt };
  }

  return {
    page: items,
    ...(await references(ctx, scope, items, ticketRow)),
    continueCursor,
    isDone,
    ...split,
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

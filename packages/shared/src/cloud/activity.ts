/**
 * The activity feed: what a Workspace's or a project's board history looks
 * like to a person, and the rules that fold it.
 *
 * The feed has no store of its own: it is `boardEvents` read newest first
 * (the backend's `activity.project` and `activity.workspace` queries), with
 * each event a viewer may not see left out, and runs of one actor's work on
 * one ticket folded into one {@link ActivityItem}:
 *
 * - consecutive field edits (status, title, priority, assignee, labels, body,
 *   harness, checkout mode) become one `changed` item carrying the NET change
 *   per field over the run (`from` may equal `to` when the run went there and
 *   back);
 * - consecutive comments become one `commented` item;
 * - a ticket's creation absorbs its creator's edits right after it (a ticket
 *   created and then labelled reads as one `created` item);
 * - everything else (Session outcomes, PRs, archives, worktree reports,
 *   project facts, …) is one `event` item carrying its payload verbatim.
 *
 * Only ADJACENT events fold (adjacent among the events the viewer sees), and
 * a run breaks after a gap of {@link ACTIVITY_COALESCING}`.gapMs`, a span of
 * `spanMs`, or `maxEvents` events. Folding adjacent runs only is what lets
 * the backend fold page by page: a page never ends inside a run, so the
 * pages a client concatenates are exactly the fold of the whole history.
 *
 * The view-model is open on read: a client older than the backend drops an
 * item whose `what.kind`, or an `event` item whose payload kind, it does not
 * know, rather than failing the feed.
 *
 * Session outcomes reach the feed as board events too (A3 §2.9):
 * {@link decideSessionOutcomeEvents} says which listing changes of a Session
 * become `session_started`, `session_signaled`, `session_stopped` and
 * `session_failed`. Wiring requirement: the Session intake's accept fold
 * (VC-891) appends its result to the Session's project through the board's
 * event writer, in the same transaction as the listing change, attributed to
 * an `agent` Actor for the Session owner.
 */

import type { SessionOrigin } from "../session-origin";
import type { SessionTurnOutcome } from "../session-ledger";
import type { HarnessId, TicketPriority, TicketStatus } from "../ticket";
import { actorUserId, readActor, type Actor, type UnknownActor } from "./actor";
import { isBoardEventKind, type BoardEventPayload, type CheckoutMode } from "./board-events";
import type { BoardEventDraft } from "./board-rules";
import type { BoardEventId, CommentId, ProjectId, SessionId, TicketId, UserId } from "./ids";

// ── reading ──────────────────────────────────────────────────────────────────

/** A board event as the feed reads it: a known kind, its actor read open. */
export interface ActivityEvent {
  id: BoardEventId;
  projectId: ProjectId;
  ticketId: TicketId | null;
  seq: number;
  occurredAt: number;
  actor: Actor | UnknownActor;
  payload: BoardEventPayload;
}

/** A stored board event row, before the feed reads it. */
export interface StoredBoardEvent {
  id: string;
  projectId: string;
  ticketId: string | null;
  seq: number;
  kind: string;
  actor: unknown;
  occurredAt: number;
  payload: unknown;
}

/** Thrown for a stored board event whose payload does not match its kind: corruption, not evolution. */
export class MalformedBoardEventError extends Error {
  readonly code = "malformed_board_event";
  constructor(id: string, detail: string) {
    super(`Malformed board event ${id}: ${detail}`);
    this.name = "MalformedBoardEventError";
  }
}

/**
 * Reads a stored board event for the feed. A kind this build does not know is
 * a newer one and reads as `null` (dropped); a payload that does not carry its
 * own kind, or a malformed actor, is corruption and throws.
 */
export function readActivityEvent(row: StoredBoardEvent): ActivityEvent | null {
  if (!isBoardEventKind(row.kind)) return null;
  const payload = row.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { kind?: unknown }).kind !== row.kind
  ) {
    throw new MalformedBoardEventError(row.id, "payload.kind does not match kind");
  }
  return {
    id: row.id as BoardEventId,
    projectId: row.projectId as ProjectId,
    ticketId: row.ticketId as TicketId | null,
    seq: row.seq,
    occurredAt: row.occurredAt,
    actor: readActor(row.actor),
    payload: payload as BoardEventPayload,
  };
}

// ── the view-model ───────────────────────────────────────────────────────────

/** One field's net change over a folded run. */
export type ActivityChange =
  | { field: "status"; from: TicketStatus; to: TicketStatus }
  | { field: "title"; from: string; to: string }
  | { field: "priority"; from: TicketPriority; to: TicketPriority }
  | { field: "assignee"; from: UserId | null; to: UserId | null }
  /** Label names, as the events recorded them. */
  | { field: "labels"; added: string[]; removed: string[] }
  | { field: "body" }
  | { field: "harness"; from: HarnessId; to: HarnessId }
  | { field: "checkout_mode"; from: CheckoutMode; to: CheckoutMode };

export type ActivityChangeField = ActivityChange["field"];

/** What an item says happened. Open on read: a client drops a kind it does not know. */
export type ActivityWhat =
  /** The ticket was created (`title` and `status` as created), then edited by its creator. */
  | { kind: "created"; title: string; status: TicketStatus; changes: ActivityChange[] }
  | { kind: "changed"; changes: ActivityChange[] }
  /** Newest first. */
  | { kind: "commented"; commentIds: CommentId[] }
  /** Any other single board event, verbatim. */
  | { kind: "event"; payload: BoardEventPayload };

/** One row of the feed: one event, or a folded run of one actor's work on one ticket. */
export interface ActivityItem {
  /** The oldest event folded in: stable while newer events join at the top. */
  id: BoardEventId;
  projectId: ProjectId;
  ticketId: TicketId | null;
  actor: Actor | UnknownActor;
  /** The newest event's time (what "2m ago" shows). */
  at: number;
  /** The oldest event's time. */
  since: number;
  /** How many events were folded in. */
  count: number;
  what: ActivityWhat;
}

/** A ticket an item names, resolved for display. Deleted tickets never appear in the feed. */
export interface ActivityTicketRef {
  id: TicketId;
  projectId: ProjectId;
  /** `PREFIX-n`. */
  key: string;
  title: string;
  status: TicketStatus;
  archived: boolean;
}

/** A person an item names (its actor, an assignee), resolved for display. */
export interface ActivityPersonRef {
  userId: UserId;
  displayName: string;
  /** The account was deleted: render "Deleted user". */
  deleted: boolean;
}

/**
 * One page of a feed, newest first. `continueCursor` is opaque: pass it as
 * the next page's `cursor`, and pin a loaded page to it (`endCursor`) once
 * the page after it is requested, so the pages stay contiguous while new
 * events arrive at the top.
 */
export interface ActivityPage {
  page: ActivityItem[];
  tickets: ActivityTicketRef[];
  people: ActivityPersonRef[];
  continueCursor: string;
  isDone: boolean;
}

/** The tickets an item names: its own and a link's target. */
export function activityTicketIds(item: ActivityItem): TicketId[] {
  const ids: TicketId[] = item.ticketId === null ? [] : [item.ticketId];
  const { what } = item;
  if (
    what.kind === "event" &&
    (what.payload.kind === "linked" || what.payload.kind === "unlinked")
  ) {
    ids.push(what.payload.toTicketId);
  }
  return ids;
}

/** The people an item names: who did it, and any assignee it set or cleared. */
export function activityUserIds(item: ActivityItem): UserId[] {
  const ids: (UserId | null)[] = [actorUserId(item.actor)];
  const { what } = item;
  if (what.kind === "created" || what.kind === "changed") {
    for (const change of what.changes) {
      if (change.field === "assignee") ids.push(change.from, change.to);
    }
  }
  return ids.filter((id): id is UserId => id !== null);
}

// ── folding ──────────────────────────────────────────────────────────────────

/** When a run of one actor's work on one ticket breaks. */
export interface ActivityCoalescingRules {
  /** Two events further apart than this never fold. */
  readonly gapMs: number;
  /** A run never spans longer than this. */
  readonly spanMs: number;
  /** A run never folds more events than this. */
  readonly maxEvents: number;
}

export const ACTIVITY_COALESCING: ActivityCoalescingRules = {
  /** Two events further apart than this never fold. */
  gapMs: 10 * 60 * 1000,
  /** A run never spans longer than this. */
  spanMs: 60 * 60 * 1000,
  /** A run never folds more events than this. */
  maxEvents: 50,
};

/** The field change an edit event records, or `null` for an event that is not an edit. */
function changeOf(payload: BoardEventPayload): ActivityChange | null {
  switch (payload.kind) {
    case "status_changed":
      return { field: "status", from: payload.from, to: payload.to };
    case "retitled":
      return { field: "title", from: payload.from, to: payload.to };
    case "priority_changed":
      return { field: "priority", from: payload.from, to: payload.to };
    case "assigned":
      return { field: "assignee", from: payload.from, to: payload.to };
    case "labels_changed":
      return { field: "labels", added: [...payload.added], removed: [...payload.removed] };
    case "body_edited":
      return { field: "body" };
    case "harness_changed":
      return { field: "harness", from: payload.from, to: payload.to };
    case "checkout_mode_changed":
      return { field: "checkout_mode", from: payload.from, to: payload.to };
    default:
      return null;
  }
}

/** Who did it, as far as folding cares: `null` never folds. */
function actorKey(actor: Actor | UnknownActor): string | null {
  switch (actor.kind) {
    case "person":
      return `person:${actor.userId}`;
    case "agent":
      return `agent:${actor.sessionId}`;
    case "automation":
      return `automation:${actor.runId}`;
    case "volli":
      return `volli:${actor.reason}:${actor.runnerId ?? ""}:${actor.onBehalfOf ?? ""}`;
    case "legacy":
    case "unknown":
      return null;
  }
}

/** A label edit run's net effect: older ops first, then newer; a label added and removed again nets out. */
function netLabels(
  older: { added: readonly string[]; removed: readonly string[] },
  newer: { added: readonly string[]; removed: readonly string[] },
): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const names = new Set([...older.added, ...older.removed, ...newer.added, ...newer.removed]);
  for (const name of names) {
    const first = older.added.includes(name)
      ? "add"
      : older.removed.includes(name)
        ? "remove"
        : newer.added.includes(name)
          ? "add"
          : "remove";
    const last = newer.added.includes(name)
      ? "add"
      : newer.removed.includes(name)
        ? "remove"
        : first;
    if (first === "add" && last === "add") added.push(name);
    else if (first === "remove" && last === "remove") removed.push(name);
  }
  return { added, removed };
}

/** Folds an OLDER change under a run's changes: the field's `from` comes from the older one. */
function foldOlderChange(changes: ActivityChange[], older: ActivityChange): ActivityChange[] {
  const index = changes.findIndex((change) => change.field === older.field);
  if (index === -1) return [...changes, older];
  // Same field, so the same arm.
  const newer = changes[index]!;
  let merged: ActivityChange;
  if (newer.field === "labels") {
    merged = { field: "labels", ...netLabels(older as typeof newer, newer) };
  } else if (newer.field === "body") {
    merged = newer;
  } else {
    merged = { ...newer, from: (older as typeof newer).from } as ActivityChange;
  }
  return changes.map((change, at) => (at === index ? merged : change));
}

function itemFor(event: ActivityEvent): ActivityItem {
  const { payload } = event;
  const change = changeOf(payload);
  let what: ActivityWhat;
  if (payload.kind === "created") {
    what = { kind: "created", title: payload.title, status: payload.status, changes: [] };
  } else if (change !== null) {
    what = { kind: "changed", changes: [change] };
  } else if (payload.kind === "commented") {
    what = { kind: "commented", commentIds: [payload.commentId] };
  } else {
    what = { kind: "event", payload };
  }
  return {
    id: event.id,
    projectId: event.projectId,
    ticketId: event.ticketId,
    actor: event.actor,
    at: event.occurredAt,
    since: event.occurredAt,
    count: 1,
    what,
  };
}

/**
 * Folds board events, newest first, into feed items. Each event either joins
 * the newest item so far (the previous adjacent run) or starts the next one.
 * The backend asks {@link ActivityFold.joins} before it takes an event, so it
 * can end a page only where a run ends.
 */
export class ActivityFold {
  readonly items: ActivityItem[] = [];

  constructor(private readonly rules: ActivityCoalescingRules = ACTIVITY_COALESCING) {}

  /** Whether `event` (older than everything folded so far) would join the last item. */
  joins(event: ActivityEvent): boolean {
    const item = this.items.at(-1);
    if (item === undefined || event.ticketId === null) return false;
    if (event.projectId !== item.projectId || event.ticketId !== item.ticketId) return false;
    const key = actorKey(item.actor);
    if (key === null || key !== actorKey(event.actor)) return false;
    if (item.count >= this.rules.maxEvents) return false;
    if (item.since - event.occurredAt > this.rules.gapMs) return false;
    if (item.at - event.occurredAt > this.rules.spanMs) return false;
    const { what } = item;
    const kind = event.payload.kind;
    switch (what.kind) {
      case "changed":
        return kind === "created" || changeOf(event.payload) !== null;
      case "commented":
        return kind === "commented";
      // Nothing about a ticket is older than its creation; other events stand alone.
      case "created":
      case "event":
        return false;
    }
  }

  /** Folds the next (older) event in. */
  add(event: ActivityEvent): void {
    if (!this.joins(event)) {
      this.items.push(itemFor(event));
      return;
    }
    const item = this.items.at(-1)!;
    const what = item.what;
    const { payload } = event;
    let next: ActivityWhat;
    if (payload.kind === "commented" && what.kind === "commented") {
      next = { kind: "commented", commentIds: [...what.commentIds, payload.commentId] };
    } else if (payload.kind === "created" && what.kind === "changed") {
      next = {
        kind: "created",
        title: payload.title,
        status: payload.status,
        changes: what.changes,
      };
    } else {
      const changes = (what as Extract<ActivityWhat, { kind: "changed" }>).changes;
      next = { kind: "changed", changes: foldOlderChange(changes, changeOf(payload)!) };
    }
    this.items[this.items.length - 1] = {
      ...item,
      id: event.id,
      at: Math.max(item.at, event.occurredAt),
      since: Math.min(item.since, event.occurredAt),
      count: item.count + 1,
      what: next,
    };
  }
}

// ── Session outcomes (the source hook) ───────────────────────────────────────

/** The listing fields of a Session that decide its feed entries. */
export interface SessionOutcomeFacts {
  id: SessionId;
  ticketId: TicketId | null;
  origin: SessionOrigin | null;
  latestTurnId: string | null;
  lastTurnOutcome: SessionTurnOutcome | null;
  signal: { signal: "done" | "blocked"; reason: string | null; at: number } | null;
  stopped: { at: number; reason: string | null } | null;
}

/**
 * The board events a Session's listing change appends, in order: its start
 * (no listing before), a new signal, a stop, and a turn that ended failed.
 * Repeating the same listing appends nothing, so a refold that rewrites an
 * unchanged listing never duplicates an entry.
 */
export function decideSessionOutcomeEvents(
  before: SessionOutcomeFacts | null,
  after: SessionOutcomeFacts,
): BoardEventDraft[] {
  const ticketId = after.ticketId;
  const sessionId = after.id;
  const drafts: BoardEventDraft[] = [];
  if (before === null) {
    drafts.push({
      ticketId,
      payload:
        after.origin === null
          ? { kind: "session_started", sessionId }
          : { kind: "session_started", sessionId, origin: after.origin },
    });
  }
  if (after.signal !== null && after.signal.at !== before?.signal?.at) {
    drafts.push({
      ticketId,
      payload: {
        kind: "session_signaled",
        sessionId,
        signal: after.signal.signal,
        reason: after.signal.reason,
      },
    });
  }
  if (after.stopped !== null && after.stopped.at !== before?.stopped?.at) {
    drafts.push({
      ticketId,
      payload: { kind: "session_stopped", sessionId, reason: after.stopped.reason },
    });
  }
  const failedBefore =
    before?.lastTurnOutcome === "failed" && before.latestTurnId === after.latestTurnId;
  if (after.lastTurnOutcome === "failed" && !failedBefore) {
    drafts.push({
      ticketId,
      payload: { kind: "session_failed", sessionId, turnId: after.latestTurnId, code: null },
    });
  }
  return drafts;
}

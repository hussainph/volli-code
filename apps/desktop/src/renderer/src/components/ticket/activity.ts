/**
 * Pure logic behind the ticket Activity feed (ticket-detail-mvp step 4): merge
 * the append-only event log with the comment work-log into one chronological
 * stream, and map each property-change event to a one-line human sentence.
 * Kept free of React/DOM so it's unit-testable at the lib level (the feed
 * component that renders these is view glue, outside the coverage gate).
 *
 * A `commented` event is deliberately DROPPED from the one-liner stream — the
 * comment it points at renders as its own full block instead, so surfacing the
 * event too would double every comment.
 */

import {
  actorHarnessId,
  harnessLabel,
  isAgentActor,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  USER_ACTOR,
  type TicketComment,
  type TicketEvent,
  type TicketEventKind,
  type TicketEventPayload,
  type WorktreeFailureStage,
  type WorktreeIdentity,
} from "@volli/shared";

import { relativeTime } from "@renderer/lib/relative-time";

/**
 * Consecutive events merge into one bunch row; a bunch only breaks at a comment
 * or when consecutive events are separated by a quiet gap longer than this.
 */
export const BUNCH_GAP_MS = 60 * 60 * 1000;

const OLD_ACTIVITY_AGE_MS = 24 * BUNCH_GAP_MS;

/**
 * Activity uses semantic zoom: while work is fresh, a one-hour quiet gap is a
 * meaningful break. Once both events have aged past a day, the compact label
 * the user can actually see ("2d ago", "3w ago", or an absolute date) becomes
 * the useful boundary instead. This lets a long-running ticket settle into a
 * calmer history without erasing comments or coalescing distinct visible time
 * buckets.
 */
function belongsToSameBunch(previousAt: number, nextAt: number, now: number): boolean {
  if (nextAt - previousAt <= BUNCH_GAP_MS) return true;
  if (now - previousAt < OLD_ACTIVITY_AGE_MS || now - nextAt < OLD_ACTIVITY_AGE_MS) return false;
  return relativeTime(previousAt, now) === relativeTime(nextAt, now);
}

/**
 * Which event kind fronts a bunch, highest signal first. The bunch's visible
 * one-liner is its highest-priority event (ties → the latest occurrence).
 * `commented` never appears (dropped before bunching — its comment renders
 * instead). Exported so the labelling contract is pinned by unit tests.
 */
export const EVENT_KIND_PRIORITY: readonly TicketEventKind[] = [
  "worktree_failed",
  "status_changed",
  "pr_merged",
  "pr_opened",
  "session_started",
  "session_ended",
  "created",
  "retitled",
  "priority_changed",
  "harness_changed",
  "labels_changed",
  "worktree_changed",
  "archived",
  "unarchived",
  "session_signal",
  "body_edited",
];

/**
 * One entry in the merged feed: a comment block, or a bunch of consecutive
 * events rendered as one row. A bunch's `label` is its highest-priority event
 * (see `EVENT_KIND_PRIORITY`), its `at` is its latest event's timestamp, and
 * `events` holds the whole run chronologically (label included) for the
 * expanded view.
 */
export type FeedItem =
  | { kind: "comment"; id: string; at: number; comment: TicketComment }
  | { kind: "bunch"; id: string; at: number; label: TicketEvent; events: TicketEvent[] };

/**
 * The event that fronts a bunch: the highest-priority kind present, and among
 * same-kind ties the LATEST occurrence. `events` must be non-empty and
 * chronological (as `buildActivityFeed` produces).
 */
export function pickBunchLabel(events: readonly TicketEvent[]): TicketEvent {
  for (const kind of EVENT_KIND_PRIORITY) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.payload.kind === kind) return events[i]!;
    }
  }
  // Unreachable for real bunches (`commented` is filtered before bunching),
  // but degrade to the latest event rather than throwing.
  return events[events.length - 1]!;
}

// TODO: @volli/shared's ticket-comment.ts owns this prefix (its AGENT_ACTOR_PREFIX)
// but doesn't export it; adopt that export here once it's public rather than
// re-declaring the literal.
const AGENT_PREFIX = "agent:";

/**
 * A comment/event author's display name: the human is "You"; a first-class
 * harness shows its label (via @volli/shared's `harnessLabel`); a custom
 * `agent:<id>` harness shows its bare id; any other actor is shown verbatim.
 */
export function commentAuthorLabel(actor: string): string {
  if (actor === USER_ACTOR) return "You";
  const harnessId = actorHarnessId(actor);
  if (harnessId !== null) return harnessLabel(harnessId);
  if (isAgentActor(actor)) return actor.slice(AGENT_PREFIX.length);
  return actor;
}

/** Joins a labels_changed payload into "added a, b, removed c". */
function describeLabelChange(added: readonly string[], removed: readonly string[]): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
  return parts.length > 0 ? parts.join(", ") : "updated labels";
}

/** Describes a worktree-identity change, favouring the branch (the field the UI edits most). */
function describeWorktreeChange(from: WorktreeIdentity, to: WorktreeIdentity): string {
  if (from.branch !== to.branch) {
    return to.branch === null ? "cleared branch" : `set branch ${to.branch}`;
  }
  if (from.baseBranch !== to.baseBranch) {
    return to.baseBranch === null ? "cleared base branch" : `set base branch ${to.baseBranch}`;
  }
  if (from.worktreePath !== to.worktreePath) {
    return to.worktreePath === null ? "cleared worktree" : `set worktree ${to.worktreePath}`;
  }
  return "updated worktree";
}

/** Human noun for each worktree-failure stage, read as "worktree <noun> failed". */
const WORKTREE_FAILURE_STAGE_LABELS: Record<WorktreeFailureStage, string> = {
  create: "creation",
  copy: "file copy",
  setup: "setup",
  commit: "commit",
  push: "push",
  pr: "pull request",
};

/**
 * Upper bound on the stderr excerpt shown inline in a `worktree_failed`
 * one-liner. The stored excerpt can run up to `MAX_WORKTREE_FAILURE_STDERR`
 * (2000 chars, @volli/shared) — far too long for a single feed row — so this
 * keeps the row scannable once the transient failure toast is gone.
 */
const WORKTREE_FAILURE_EXCERPT_MAX = 160;

/**
 * The single most relevant line of a `worktree_failed` stderr excerpt: its
 * last non-blank line. Git's actual error lands at the end of its stderr
 * (progress noise precedes it), and the stored excerpt is already trimmed to
 * the TRAILING slice (see `trimWorktreeFailureStderr`), so the last line is
 * the diagnosis; truncated further so the feed row stays single-line.
 */
function worktreeFailureExcerpt(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? stderr.trim();
  return last.length > WORKTREE_FAILURE_EXCERPT_MAX
    ? `${last.slice(0, WORKTREE_FAILURE_EXCERPT_MAX)}…`
    : last;
}

/**
 * The one-line sentence for a property-change event (`null` for `commented`,
 * which the feed renders as its comment instead). Verb-phrase style, no
 * subject — the feed row supplies the actor/timestamp chrome.
 */
export function describeEvent(payload: TicketEventPayload): string | null {
  switch (payload.kind) {
    case "created":
      return "created the ticket";
    case "status_changed":
      return `moved ${TICKET_STATUS_LABELS[payload.from]} → ${TICKET_STATUS_LABELS[payload.to]}`;
    case "priority_changed":
      return `changed priority ${TICKET_PRIORITY_LABELS[payload.from]} → ${TICKET_PRIORITY_LABELS[payload.to]}`;
    case "harness_changed":
      return `changed harness ${harnessLabel(payload.from)} → ${harnessLabel(payload.to)}`;
    case "retitled":
      return `renamed to "${payload.to}"`;
    case "body_edited":
      return "edited the description";
    case "labels_changed":
      return describeLabelChange(payload.added, payload.removed);
    case "archived":
      return "archived the ticket";
    case "unarchived":
      return "restored the ticket";
    case "session_started":
      return `started session ${payload.title}`;
    case "session_ended":
      return "ended a session";
    case "worktree_changed":
      return describeWorktreeChange(payload.from, payload.to);
    case "worktree_failed": {
      const stage = WORKTREE_FAILURE_STAGE_LABELS[payload.stage];
      const excerpt = worktreeFailureExcerpt(payload.stderr);
      return excerpt.length > 0
        ? `worktree ${stage} failed: ${excerpt}`
        : `worktree ${stage} failed`;
    }
    case "worktree_committed":
      return "committed remaining work";
    case "pr_opened":
      return "opened a draft pull request";
    case "pr_merged":
      return "pull request merged";
    case "session_signal":
      return payload.reason === null
        ? `reported ${payload.signal}`
        : `reported ${payload.signal}: ${payload.reason}`;
    case "sessions_interrupted":
      return payload.sessionIds.length === 1
        ? "interrupted a session"
        : `interrupted ${payload.sessionIds.length} sessions`;
    case "session_resumed":
      return "resumed the interrupted session";
    case "commented":
      return null;
  }
}

/** A merged, not-yet-grouped feed entry (chronologically sorted before grouping). */
type MergedEntry =
  | { at: number; kind: "event"; event: TicketEvent }
  | { at: number; kind: "comment"; comment: TicketComment };

/**
 * Merges events and comments into one chronological (oldest-first) feed, then
 * bunches it: ALL consecutive events (any kind) merge into a single `bunch`
 * item, breaking only at a comment or at a quiet gap of more than
 * `BUNCH_GAP_MS` between consecutive events. `commented` events are dropped
 * (their comment renders instead). Sorts by timestamp; ties keep input order
 * (events before comments), so the result is deterministic for a given DB read.
 */
export function buildActivityFeed(
  events: readonly TicketEvent[],
  comments: readonly TicketComment[],
  now: number = Date.now(),
): FeedItem[] {
  const merged: MergedEntry[] = [];
  for (const event of events) {
    if (event.payload.kind === "commented") continue;
    merged.push({ at: event.createdAt, kind: "event", event });
  }
  for (const comment of comments) {
    merged.push({ at: comment.createdAt, kind: "comment", comment });
  }
  const sorted = merged.toSorted((a, b) => a.at - b.at);

  const feed: FeedItem[] = [];
  let bunch: TicketEvent[] = []; // the open run of consecutive events, chronological

  function flushBunch() {
    if (bunch.length === 0) return;
    const latest = bunch[bunch.length - 1]!;
    feed.push({
      kind: "bunch",
      id: `bunch:${bunch[0]!.id}`,
      at: latest.createdAt,
      label: pickBunchLabel(bunch),
      events: bunch,
    });
    bunch = [];
  }

  for (const entry of sorted) {
    if (entry.kind === "comment") {
      flushBunch();
      feed.push({ kind: "comment", id: entry.comment.id, at: entry.at, comment: entry.comment });
      continue;
    }
    const last = bunch[bunch.length - 1];
    if (last !== undefined && !belongsToSameBunch(last.createdAt, entry.at, now)) flushBunch();
    bunch.push(entry.event);
  }
  flushBunch();

  return feed;
}

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
  AGENT_ACTOR_PREFIX,
  harnessLabel,
  isAgentActor,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  UNAUTHENTICATED_ACTOR,
  USER_ACTOR,
  type TicketComment,
  type TicketEvent,
  type TicketEventActorKind,
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
  // A verdict outranks everything except a broken worktree and a board move
  // (VC-85): it is the one line in a bunch that says where the work STANDS,
  // and a bunch fronted by "edited the description" while a review failed
  // inside it is the feed hiding its own headline.
  "signaled",
  "pr_merged",
  "pr_opened",
  "created",
  "session_started",
  "retitled",
  "priority_changed",
  "harness_changed",
  "labels_changed",
  "attachment_added",
  "attachment_removed",
  "worktree_changed",
  "worktree_scope_changed",
  "archived",
  "unarchived",
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

/**
 * A comment/event author's display name: the human is "You"; a first-class
 * harness shows its label (via @volli/shared's `harnessLabel`); a custom
 * `agent:<id>` harness shows its bare id; any other actor is shown verbatim.
 *
 * `unauthenticated` is spelled out rather than shown raw (VC-163). The column
 * is a plain string, so a new actor kind reaches this function with nothing to
 * fail the build — and the fallback would have printed the bare enum token as
 * a person's name, on a row that a reader has every reason to read as a name.
 * A caller Volli could not identify is the one author whose label has to say so
 * on the row itself: it is the only kind that means an absence of evidence, and
 * a default install never writes one at all.
 */
export function commentAuthorLabel(actor: string): string {
  if (actor === USER_ACTOR) return "You";
  if (actor === UNAUTHENTICATED_ACTOR) return "Unauthenticated caller";
  const harnessId = actorHarnessId(actor);
  if (harnessId !== null) return harnessLabel(harnessId);
  if (isAgentActor(actor)) return actor.slice(AGENT_ACTOR_PREFIX.length);
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
  attachments: "attachment materialize",
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
 *
 * `actor` is read by exactly one kind and is optional for that reason: a start
 * is the only event whose SUBJECT is the news (VC-131). Every other line here
 * describes a change to the Ticket, where who made it is chrome; a Session
 * start describes a worker appearing, and "started a session" attributed to
 * nobody is precisely the line that cannot tell a Run from a person sitting
 * down at the keyboard. Callers that have the event pass its actor; a caller
 * holding only a payload (a fixture, a summary) still gets the neutral
 * sentence rather than a compile error.
 */
export function describeEvent(
  payload: TicketEventPayload,
  actor?: TicketEventActorKind,
): string | null {
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
    case "worktree_changed":
      return describeWorktreeChange(payload.from, payload.to);
    case "worktree_scope_changed":
      return payload.to
        ? "scoped the ticket to a new worktree"
        : "scoped the ticket to the main checkout";
    case "worktree_failed": {
      const stage = WORKTREE_FAILURE_STAGE_LABELS[payload.stage];
      const excerpt = worktreeFailureExcerpt(payload.stderr);
      return excerpt.length > 0
        ? `worktree ${stage} failed: ${excerpt}`
        : `worktree ${stage} failed`;
    }
    case "worktree_committed":
      return "committed remaining work";
    // VC-113: the reclaim says what it took AND what it kept, in one line. A
    // worktree that disappears with no account of itself is indistinguishable
    // from work going missing, which is the whole reason this event exists.
    case "worktree_reclaimed":
      return payload.branch === null
        ? `removed the worktree folder after ${payload.daysInDone} days in Done`
        : `removed the worktree folder after ${payload.daysInDone} days in Done (branch ${payload.branch} kept)`;
    case "pr_opened":
      return "opened a draft pull request";
    case "pr_merged":
      return "pull request merged";
    case "commented":
      return null;
    // The detail rides the line rather than being dropped to a second one: a
    // verdict without its reason is the `VERDICT:` convention again, and the
    // whole point of the typed channel is that the reason travels WITH it.
    case "signaled":
      return payload.detail === null
        ? `signalled ${payload.signalKind}: ${payload.verdict}`
        : `signalled ${payload.signalKind}: ${payload.verdict} — ${payload.detail}`;
    // Three actors can start a Session and each gets its own reading, which is
    // the timeline's half of "a Run's Session is distinguishable everywhere".
    // The Automation is not NAMED here: the event's payload cannot carry which
    // one ran, and inventing a name from a second lookup would let the timeline
    // and the Run record disagree. The Session's own row says which — this line
    // only has to stop reading as a person.
    case "session_started":
      if (actor === "automation") return "an Automation started a session";
      if (actor === "session") return "an agent started a session";
      return "started a session";
    case "attachment_added":
      return `attached "${payload.label}"`;
    case "attachment_removed":
      return `removed attachment "${payload.label}"`;
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

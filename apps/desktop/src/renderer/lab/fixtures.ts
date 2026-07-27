/**
 * Demo data for lab scratches — real `@volli/shared` domain types, not
 * loose object literals, so a model change breaks the lab at typecheck rather
 * than at "why does this card render blank".
 *
 * The content is the house demo project (voltaic / VLT-14) so scratches read
 * like the product instead of like `foo`/`bar`. Fake data that *looks* fake
 * makes designs lie to you: titles are realistic lengths, one is long enough
 * to exercise the card's two-line clamp, and labels/priorities/statuses are
 * spread so every visual branch appears without hand-tuning per scratch.
 *
 * The board is deliberately UNEVEN — four in Backlog, one in Done. Balanced
 * columns are the single most misleading thing a kanban mock can do: they hide
 * whether a tall column scrolls gracefully and whether a nearly-empty one looks
 * broken or merely quiet.
 *
 * Timestamps are a frozen constant rather than `Date.now()`, so a scratch
 * renders identically on every reload — relative-time strings stay put, and
 * screenshots of two design variants differ only where the design differs.
 */
import type { LatestSessionSignal, Label, Project, SessionRecord, Ticket } from "@volli/shared";

/** Frozen clock: 2026-01-15T10:00:00Z. See module doc for why it is not `Date.now()`. */
export const NOW = 1_768_471_200_000;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const project: Project = {
  id: "prj-voltaic",
  name: "Voltaic",
  path: "/Users/demo/code/voltaic",
  ticketPrefix: "VLT",
  baseBranch: "main",
  setupCommand: null,
  themeOverride: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: NOW - 30 * DAY,
  updatedAt: NOW - HOUR,
};

/**
 * The rail's full set. Three, not one: the rail's job is switching, and a
 * one-tile rail can't show selection, ordering, or the tile palette doing its
 * work. Distinct `colorIndex` values so each tile draws a different swatch.
 */
export const projects: Project[] = [
  project,
  {
    ...project,
    id: "prj-atlas",
    name: "Atlas",
    path: "/Users/demo/code/atlas",
    ticketPrefix: "ATL",
    colorIndex: 3,
    sortOrder: 1,
  },
  {
    ...project,
    id: "prj-harbor",
    name: "Harbor",
    path: "/Users/demo/code/harbor",
    ticketPrefix: "HBR",
    colorIndex: 6,
    sortOrder: 2,
  },
];

export const labels: Label[] = [
  { id: "lbl-editor", projectId: project.id, name: "editor", color: null },
  { id: "lbl-perf", projectId: project.id, name: "perf", color: null },
  { id: "lbl-infra", projectId: project.id, name: "infra", color: null },
  { id: "lbl-bug", projectId: project.id, name: "bug", color: null },
];

/** Every field a card reads; per-ticket overrides supply only what differs. */
function ticket(
  overrides: Partial<Ticket> & Pick<Ticket, "id" | "ticketNumber" | "title">,
): Ticket {
  return {
    projectId: project.id,
    body: "",
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

export const tickets: Ticket[] = [
  ticket({
    id: "tkt-14",
    ticketNumber: 14,
    title: "Inline diff gutter drops decorations on rapid scroll",
    status: "doing",
    priority: "high",
    labels: ["editor", "bug"],
    order: 0,
    worktreePath: "/Users/demo/code/voltaic-worktrees/VLT-14",
    branch: "volli/VLT-14-inline-diff-gutter",
    baseBranch: "main",
    body: "Scrolling the changeset view faster than the decoration debounce leaves stale gutter marks behind.",
  }),
  ticket({
    id: "tkt-12",
    ticketNumber: 12,
    title: "Warm-park sessions after 10 minutes idle",
    status: "doing",
    priority: "medium",
    labels: ["perf"],
    order: 1,
    worktreePath: "/Users/demo/code/voltaic-worktrees/VLT-12",
    branch: "volli/VLT-12-warm-park",
    baseBranch: "main",
  }),
  ticket({
    id: "tkt-13",
    ticketNumber: 13,
    title: "Restore split-pane focus after a device-loss recovery",
    status: "doing",
    priority: "low",
    order: 2,
  }),
  ticket({
    id: "tkt-11",
    ticketNumber: 11,
    title: "Ghostty config adapter: honor `window-padding-balance`",
    status: "needs_review",
    priority: "high",
    labels: ["infra"],
    order: 0,
    branch: "volli/VLT-11-window-padding-balance",
    baseBranch: "main",
    prUrl: "https://github.com/demo/voltaic/pull/482",
  }),
  ticket({
    id: "tkt-10",
    ticketNumber: 10,
    title: "Board card hover state loses the priority indicator",
    status: "needs_review",
    priority: "medium",
    labels: ["bug"],
    order: 1,
    branch: "volli/VLT-10-card-hover",
    baseBranch: "main",
  }),
  ticket({
    id: "tkt-9",
    ticketNumber: 9,
    title: "Persist the harness picker's last choice per project instead of globally",
    status: "todo",
    priority: "low",
    labels: ["infra"],
    order: 0,
  }),
  ticket({
    id: "tkt-7",
    ticketNumber: 7,
    title: "Command palette: fuzzy-match ticket titles",
    status: "todo",
    priority: "medium",
    order: 1,
  }),
  ticket({
    id: "tkt-8",
    ticketNumber: 8,
    title: "Archive worktrees on TTL instead of prompting",
    status: "todo",
    priority: "high",
    labels: ["infra"],
    order: 2,
  }),
  ticket({
    id: "tkt-3",
    ticketNumber: 3,
    title: "Spike: streaming transcripts straight to the event log",
    status: "backlog",
    priority: "medium",
    order: 0,
  }),
  ticket({
    id: "tkt-4",
    ticketNumber: 4,
    title: "Per-project accent tint derived from the rail tile color",
    status: "backlog",
    priority: "low",
    labels: ["editor"],
    order: 1,
  }),
  ticket({
    id: "tkt-5",
    ticketNumber: 5,
    title: "Sweep orphaned worktrees left by a hard crash",
    status: "backlog",
    priority: "medium",
    labels: ["infra"],
    order: 2,
  }),
  ticket({
    id: "tkt-6",
    ticketNumber: 6,
    title: "Notification when a session blocks on input",
    status: "backlog",
    priority: "high",
    order: 3,
  }),
  ticket({
    id: "tkt-2",
    ticketNumber: 2,
    title: "Move ticket ordering into the shared state machine",
    status: "done",
    priority: "medium",
    labels: ["infra"],
    order: 0,
    prUrl: "https://github.com/demo/voltaic/pull/461",
  }),
];

/** Lookup by fixture id — sturdier than positional destructuring when the board grows. */
export function ticketById(id: string): Ticket {
  const found = tickets.find((candidate) => candidate.id === id);
  // Throwing beats returning a placeholder: a scratch pointed at a ticket that
  // no longer exists should fail where the typo is, not render a blank card.
  if (found === undefined) throw new Error(`No fixture ticket "${id}"`);
  return found;
}

/** Every field a session row reads; per-session overrides supply only what differs. */
function session(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, "id" | "ticketId" | "title">,
): SessionRecord {
  return {
    projectId: project.id,
    harnessId: "claude-code",
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    cwd: project.path,
    createdAt: NOW - 2 * HOUR,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

/**
 * Durable session records, as `window.api.sessions.list` would return them.
 *
 * Chosen to cover what the sidebar's tiers actually branch on: a clean exit, a
 * failure (non-zero `exitCode`), and a Doing ticket with NO record at all
 * (tkt-13) — the "bare row" case that guarantees every Doing ticket a presence
 * even when no PTY ever ran.
 */
export const sessions: SessionRecord[] = [
  session({
    id: "ses-14a",
    ticketId: "tkt-14",
    title: "Session 1",
    cwd: "/Users/demo/code/voltaic-worktrees/VLT-14",
    createdAt: NOW - 3 * HOUR,
    endedAt: NOW - 12 * MINUTE,
    exitCode: 0,
  }),
  session({
    id: "ses-12a",
    ticketId: "tkt-12",
    title: "Session 1",
    cwd: "/Users/demo/code/voltaic-worktrees/VLT-12",
    createdAt: NOW - 5 * HOUR,
    endedAt: NOW - 90 * MINUTE,
    exitCode: 1,
  }),
  session({
    id: "ses-11a",
    ticketId: "tkt-11",
    title: "Session 2",
    createdAt: NOW - 6 * HOUR,
    endedAt: NOW - 40 * MINUTE,
    exitCode: 0,
  }),
  session({
    id: "ses-10a",
    ticketId: "tkt-10",
    title: "Session 1",
    createdAt: NOW - 8 * HOUR,
    endedAt: NOW - 3 * HOUR,
    exitCode: 0,
  }),
];

/**
 * The latest attention signal per Needs Review ticket — what promotes a row
 * into the "Needs you" tier and supplies its reason line. One `blocked` and one
 * `done` so both label paths render side by side.
 */
export const signals: LatestSessionSignal[] = [
  {
    ticketId: "tkt-11",
    sessionId: "ses-11a",
    signal: "done",
    reason: "PR opened",
    createdAt: NOW - 40 * MINUTE,
  },
  {
    ticketId: "tkt-10",
    sessionId: "ses-10a",
    signal: "blocked",
    reason: "needs a design call",
    createdAt: NOW - 3 * HOUR,
  },
];

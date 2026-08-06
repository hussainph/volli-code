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
import type {
  ChatSessionRecord,
  LatestSessionSignal,
  Label,
  Project,
  SessionRecord,
  Ticket,
} from "@volli/shared";

import type { BuildActiveSessionListingInput } from "@renderer/components/sidebar/active-session-listing";
import type { SessionContainer } from "@renderer/stores/sessions";

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
  const createdAt = overrides.createdAt ?? NOW - 2 * HOUR;
  return {
    projectId: project.id,
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    cwd: project.path,
    createdAt,
    endedAt: null,
    exitCode: null,
    lastActivityAt: createdAt,
    bornTicketless: overrides.ticketId === null,
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

/** Every field a chat Session row reads; per-session overrides supply only what differs. */
function chat(
  overrides: Partial<ChatSessionRecord> &
    Pick<ChatSessionRecord, "sessionId" | "ticketId" | "title" | "lastActivityAt">,
): ChatSessionRecord {
  return {
    projectId: project.id,
    // A chat that has been talked to for a while, unless a scenario needs an
    // exact birth (the cleanup rule that compares creation against a ticket's
    // last column move is the whole reason this is overridable at all).
    createdAt: overrides.lastActivityAt - 40 * MINUTE,
    adapterId: "claude-code",
    live: true,
    activity: "idle",
    bornTicketless: overrides.ticketId === null,
    ...overrides,
  };
}

/**
 * Chat Sessions across the demo project — the kind the sidebar's two bands had
 * no fixture for at all until now.
 *
 * Spread across the axes the bands actually branch on: activity × live, and a
 * recency ladder (2m / 20m / 45m / 3h) that straddles the 30-minute quiet
 * window from both sides. Three of them are ticketless, which is three
 * different things and not one: `chat-scratch-*` were BORN without a ticket
 * (project scratch work, cleanup-exempt forever), while `chat-orphan` had a
 * ticket that has since left the board — the case `bornTicketless` exists to
 * tell apart, and the one cleanup rule (a) is for.
 */
export const chatSessions: ChatSessionRecord[] = [
  chat({
    sessionId: "chat-14a",
    ticketId: "tkt-14",
    title: "Trace the dropped decorations back to the debounce",
    activity: "waiting",
    lastActivityAt: NOW - 2 * MINUTE,
  }),
  chat({
    sessionId: "chat-11a",
    ticketId: "tkt-11",
    title: "Pick the resume seed for a split pane",
    activity: "waiting",
    live: false,
    lastActivityAt: NOW - 3 * HOUR,
  }),
  chat({
    sessionId: "chat-12a",
    ticketId: "tkt-12",
    title: "Draft the park/wake state machine",
    lastActivityAt: NOW - 20 * MINUTE,
  }),
  chat({
    sessionId: "chat-10a",
    ticketId: "tkt-10",
    title: "Summarize the hover-state regression",
    activity: "working",
    live: false,
    lastActivityAt: NOW - 45 * MINUTE,
  }),
  chat({
    sessionId: "chat-9a",
    ticketId: "tkt-9",
    title: "Compare per-project and global harness defaults",
    live: false,
    // Older than tkt-9's move back into Todo — the one session cleanup rule (c)
    // is meant to catch here.
    createdAt: NOW - 3 * HOUR,
    lastActivityAt: NOW - 45 * MINUTE,
  }),
  chat({
    sessionId: "chat-1a",
    ticketId: "tkt-1",
    title: "Confirm the migration path is unreferenced",
    live: false,
    // Born AFTER its ticket landed in Done, which is the only way a Done
    // ticket's Session survives to see the Done linger at all.
    createdAt: NOW - 8 * MINUTE,
    lastActivityAt: NOW - 5 * MINUTE,
  }),
  chat({
    sessionId: "chat-scratch-a",
    ticketId: null,
    title: "Rename the worktree branch scheme",
    activity: "working",
    lastActivityAt: NOW - 2 * MINUTE,
  }),
  chat({
    sessionId: "chat-scratch-b",
    ticketId: null,
    title: "Read through the ACP handshake",
    live: false,
    lastActivityAt: NOW - 3 * HOUR,
  }),
  chat({
    sessionId: "chat-orphan",
    ticketId: null,
    bornTicketless: false,
    title: "Sweep the leftovers from the archived board",
    live: false,
    // Past the quiet window on purpose: cleanup only ever runs on the Previous
    // band, so an orphan younger than that sits in Active like any other recent
    // Session and rule (a) has nothing to say about it yet.
    lastActivityAt: NOW - 2 * HOUR,
  }),
];

/**
 * The second Done ticket the cleanup rules need, kept out of `tickets` on
 * purpose: that board is tuned to be uneven with exactly one Done card, and
 * cleanup needs two — one that entered the column long enough ago for the
 * linger to have expired, one that landed a moment ago.
 */
const doneJustNow: Ticket = ticket({
  id: "tkt-1",
  ticketNumber: 1,
  title: "Drop the pre-worktree session migration",
  status: "done",
  priority: "low",
  order: 1,
  createdAt: NOW - 2 * DAY,
  updatedAt: NOW - 10 * MINUTE,
});

/** Durable records for the panes `sessionListingInput` keeps live — `endedAt: null` is what makes them live. */
const liveSessions: SessionRecord[] = [
  session({
    id: "ses-14b",
    ticketId: "tkt-14",
    title: "Session 2",
    cwd: "/Users/demo/code/voltaic-worktrees/VLT-14",
    createdAt: NOW - 25 * MINUTE,
  }),
  session({
    id: "ses-12b",
    ticketId: "tkt-12",
    title: "Session 2",
    cwd: "/Users/demo/code/voltaic-worktrees/VLT-12",
    createdAt: NOW - 2 * HOUR,
  }),
  session({ id: "ses-11b", ticketId: "tkt-11", title: "Session 3", createdAt: NOW - 55 * MINUTE }),
  session({ id: "ses-10b", ticketId: "tkt-10", title: "Session 2", createdAt: NOW - 70 * MINUTE }),
  session({
    id: "ses-2a",
    ticketId: "tkt-2",
    title: "Session 1",
    createdAt: NOW - 90 * MINUTE,
    endedAt: NOW - 45 * MINUTE,
    exitCode: 0,
  }),
];

/** One live single-pane tab per ticket that has one, in the shape the sessions store holds. */
function liveTab(ticketId: string, sessionId: string, title: string): SessionContainer {
  return {
    tabs: [
      {
        sessionId,
        title,
        scope: { kind: "ticket", projectId: project.id, ticketId },
        layout: { kind: "pane", sessionId, exitCode: null },
        activePaneId: sessionId,
      },
    ],
    activeSessionId: sessionId,
  };
}

/**
 * Everything `buildActiveSessionListing` reads except the clock and the filter —
 * the two the sidebar prototype drives from controls.
 *
 * Typed against the builder's own input so a change to what the bands are
 * derived from breaks here at typecheck rather than silently rendering a band
 * that no longer means what it says.
 *
 * The arrangement is chosen so every band and every cleanup rule is reachable
 * at some point on an eight-hour clock scrub:
 *
 *   • `statusEnteredAt` covers most tickets and deliberately omits tkt-13 —
 *     a ticket whose column history we do not have, where both rules that need
 *     it must stay silent;
 *   • tkt-9 sat in Todo for half an hour with a three-hour-old chat, which is
 *     rule (c) — a Session that traces some earlier stretch of work — and it is
 *     the ONLY row that rule fires for;
 *   • tkt-2 has been Done for two hours (its linger is over) and tkt-1 for ten
 *     minutes (its linger expires 50 minutes into the scrub);
 *   • tkt-13 is Doing with nothing at all behind it, so the board guarantee has
 *     to invent its row;
 *   • ses-12b's harness declares `working`, so it keeps working however far the
 *     clock is scrubbed, while ses-14b's is the one that announced and then went
 *     silent — the honest "not reporting" row.
 */
export const sessionListingInput: Omit<BuildActiveSessionListingInput, "now" | "filter"> = {
  tickets: [...tickets, doneJustNow],
  containers: {
    "tkt-14": liveTab("tkt-14", "ses-14b", "Session 2"),
    "tkt-12": liveTab("tkt-12", "ses-12b", "Session 2"),
    "tkt-11": liveTab("tkt-11", "ses-11b", "Session 3"),
    "tkt-10": liveTab("tkt-10", "ses-10b", "Session 2"),
  },
  // Pointed at the LIVE panes rather than `signals` above, because a signal the
  // model cannot match to a mounted pane loses its reason line — and the reason
  // is the whole thing an attention row has to say.
  signalsByTicket: {
    "tkt-11": {
      ticketId: "tkt-11",
      sessionId: "ses-11b",
      signal: "done",
      reason: "PR opened",
      createdAt: NOW - 30 * MINUTE,
    },
    "tkt-10": {
      ticketId: "tkt-10",
      sessionId: "ses-10b",
      signal: "blocked",
      reason: "needs a design call",
      createdAt: NOW - 35 * MINUTE,
    },
  },
  records: [...sessions, ...liveSessions],
  chatSessions,
  lastOutputAt: {
    "ses-14b": NOW - 8 * MINUTE,
    "ses-12b": NOW - MINUTE,
    "ses-11b": NOW - 5 * MINUTE,
    "ses-10b": NOW - 35 * MINUTE,
  },
  parkState: {},
  harness: {
    "ses-12b": {
      harnessId: "claude-code",
      expectsEvents: true,
      declaresInputNeeded: true,
      startedAt: NOW - 2 * HOUR,
      delivered: true,
      declared: "working",
      newestFiredAt: NOW - MINUTE,
    },
    "ses-14b": {
      harnessId: "claude-code",
      expectsEvents: true,
      declaresInputNeeded: true,
      startedAt: NOW - 25 * MINUTE,
      delivered: false,
      declared: null,
      newestFiredAt: null,
    },
  },
  statusEnteredAt: new Map([
    ["tkt-14", NOW - 4 * HOUR],
    ["tkt-12", NOW - 6 * HOUR],
    ["tkt-11", NOW - 7 * HOUR],
    ["tkt-10", NOW - 9 * HOUR],
    ["tkt-9", NOW - 30 * MINUTE],
    ["tkt-2", NOW - 2 * HOUR],
    ["tkt-1", NOW - 10 * MINUTE],
  ]),
};

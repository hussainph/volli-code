import {
  canResumeHarness,
  effectiveHarnessId,
  harnessLabel,
  type ChatSessionRecord,
  type HarnessAdapterLookup,
  type SessionActivityState,
  type SessionHarnessState,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";

import { sessionActivityState, sessionPanes, type SessionTab } from "../../stores/sessions";

/**
 * The chip's displayed status: the honest PTY-derived {@link SessionActivityState}
 * states, plus `setup` — a synthetic state (not PTY-derived) shown while the
 * ticket's worktree ensure pipeline is in its `setting-up` phase, so the rail
 * reads as "the agent's setup script is running" rather than a generic
 * `working`.
 */
export type TicketSessionStatus = SessionActivityState | "setup";

/** The view model shared by the current-session and historical-session lists. */
export interface TicketSessionRow {
  record: SessionRecord;
  title: string;
  status: TicketSessionStatus;
  isOpen: boolean;
  isRoot: boolean;
  tabId?: string;
}

/**
 * Truthful, compact source metadata for the rail. Only agent launches expose a
 * harness. Bare shells and pre-metadata sessions never inherit the default
 * Claude label; split placement remains visible without becoming the title.
 *
 * The harness named is the one RUNNING, not the one the session launched with:
 * a pane whose agent was quit and replaced reads as what is in it now. A shell
 * launch that later ran an agent still reads as "Shell" — `launchKind` is a
 * fact about the pane's origin and no announce changes it.
 *
 * A chat row has none of that — no PTY, no launch — so it names the adapter
 * it attached instead and, the one thing worth saying about it, whether that
 * attachment is still open.
 */
export function sessionSourceLabel(row: SessionListingRow): string {
  if (row.kind === "chat") return row.record.live ? "Chat · Live" : "Chat";
  const record = row.record;
  const source =
    record.launchKind === "agent"
      ? harnessLabel(effectiveHarnessId(record))
      : record.launchKind === "shell"
        ? "Shell"
        : "Terminal";
  return record.placement === "split" ? `${source} · Split` : source;
}

export interface TicketSessionRowsInput {
  /** The ticket's durable records — one per pane, live or ended. */
  records: readonly SessionRecord[];
  /** The ticket's currently-open tabs, from the unified sessions store. */
  tabs: readonly SessionTab[];
  lastOutputAt: Readonly<Record<string, number>>;
  parkState: Readonly<Record<string, { parked: boolean; keepAwake: boolean }>>;
  /**
   * Per-session harness reporting state, straight off the sessions store — the
   * same map the sidebar's listing reads. A missing entry means nothing reports
   * for that pane, which is the honest default.
   */
  harness: Readonly<Record<string, SessionHarnessState>>;
  /** Whether the ticket's worktree ensure pipeline is running its setup script. */
  settingUp: boolean;
  now: number;
}

/**
 * The rail's session rows: one per durable record, each carrying the status the
 * rail chip shows. Pure and clock-injected so the derivation is unit-testable
 * without the panel around it (the same split as the sidebar's
 * `active-session-listing`) — and, more to the point, so BOTH surfaces reach
 * `sessionActivityState` through the same argument list. A rail that fed it only
 * PTY facts was structurally unable to show a blocked agent while the sidebar,
 * reading the same store, filed that session under "Needs you".
 */
export function buildTicketSessionRows(input: TicketSessionRowsInput): TicketSessionRow[] {
  // paneSessionId → its live state, for EVERY pane of every open tab (not just
  // tab roots): each split pane has its own durable record, so without this a
  // live split pane would render as an inert "Exited" row. `tabTitle` is the
  // live tab title (used for the root pane's optimistic rename); non-root panes
  // fall back to their own durable record title. `tabId` is the tab's root id.
  const liveById = new Map<string, { exitCode: number | null; tabTitle: string; tabId: string }>();
  for (const tab of input.tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      liveById.set(pane.sessionId, {
        exitCode: pane.exitCode,
        tabTitle: tab.title,
        tabId: tab.sessionId,
      });
    }
  }

  return input.records.map((record) => {
    const live = liveById.get(record.id);
    const isOpen = live !== undefined;
    const isRoot = live !== undefined && live.tabId === record.id;
    // Status derives from THIS pane's own exit code + output, not the tab root's.
    const exited = live !== undefined ? live.exitCode !== null : true;
    const activity = sessionActivityState(
      input.lastOutputAt[record.id] ?? null,
      exited,
      input.now,
      input.parkState[record.id]?.parked ?? false,
      input.harness[record.id]?.declared ?? null,
    );
    // While the worktree's ensure pipeline is running its setup script, an open
    // pane's honest `working` status is less informative than naming what it's
    // actually doing — `setup` overrides it for every currently-open, NOT-YET-
    // EXITED row; an exited/crashed pane shows its real exited status even
    // during setup, rather than lying that setup is still in progress.
    const status: TicketSessionStatus = isOpen && !exited && input.settingUp ? "setup" : activity;
    // Root pane rows prefer the live tab title (optimistic rename shows before
    // the refetch); non-root pane rows show their own durable record title.
    const title = isRoot ? live.tabTitle : record.title;
    return { record, title, isOpen, isRoot, tabId: live?.tabId, status };
  });
}

/**
 * Current is intentionally strict: only an open, non-exited PTY belongs in
 * the working set. Exited-but-still-open panes stay activatable from history.
 */
export function groupSessionRows(rows: readonly TicketSessionRow[]): {
  current: TicketSessionRow[];
  history: TicketSessionRow[];
} {
  const current: TicketSessionRow[] = [];
  const history: TicketSessionRow[] = [];
  for (const row of rows) {
    (row.isOpen && row.status !== "exited" ? current : history).push(row);
  }
  return { current, history };
}

/**
 * Whether `row` can be resumed (interrupt/resume, issue #78). A chat row never
 * qualifies — there is no terminal to resume as, only a future deep-activation
 * path this is not it. A terminal row qualifies only when it actually launched
 * an agent (a bare shell or pre-metadata `unknown` record has no harness
 * session to resume), has actually ended (a still-live session has nothing to
 * resume INTO — it's already running), and its harness knows how to resume at
 * all — an unrecognized/generic harness id makes {@link canResumeHarness} false
 * for both its by-id and latest-in-cwd fallbacks.
 *
 * Capability, not a command line: the resume line names the generated wrapper
 * by absolute path, and those paths are main's alone.
 *
 * `lookup` is a parameter rather than a hard-wired `getHarnessAdapter` because
 * this used to consult the built-ins only, on the since-retired grounds that
 * "the renderer has no channel over which a registered manifest's adapter could
 * reach it." It has one — `launchAdapter` reads the hydrated catalog as well —
 * and a first-class-only lookup here silently denies Resume to every BYO
 * session that can genuinely be resumed. Pass `launchAdapter`; the parameter
 * exists so a test can say what this process knows instead of inheriting it
 * from a module singleton.
 */
export function canResumeSession(row: SessionListingRow, lookup: HarnessAdapterLookup): boolean {
  if (row.kind === "chat") return false;
  const record = row.record;
  return (
    record.launchKind === "agent" &&
    record.endedAt !== null &&
    // The harness that was running when it ended is the one a resume restarts
    // (main builds the resume line off the same id) — so the affordance must be
    // decided about that harness, or the rail offers Resume for a harness the
    // session had not been running since the moment it was opened.
    canResumeHarness(effectiveHarnessId(record), record.harnessSessionId, lookup)
  );
}

/**
 * The newest resumable record among `rows`, or `null` if none qualify — a chat
 * row is filtered out by {@link canResumeSession} before it ever reaches the
 * comparison. Compares `createdAt` directly rather than trusting input order —
 * the store (`listTicketSessions`, `created_at DESC`) already hands these back
 * newest-first, but this stays correct even if a caller passes an
 * unordered/filtered subset.
 */
export function latestResumableSession(
  rows: readonly SessionListingRow[],
  lookup: HarnessAdapterLookup,
): SessionRecord | null {
  let latest: SessionRecord | null = null;
  for (const row of rows) {
    if (row.kind !== "terminal" || !canResumeSession(row, lookup)) continue;
    if (latest === null || row.record.createdAt > latest.createdAt) latest = row.record;
  }
  return latest;
}

/** Title + truthful source metadata make collapsed history easy to recover. */
export function filterSessionHistory(
  rows: readonly TicketSessionRow[],
  query: string,
): TicketSessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    `${row.title}\n${sessionSourceLabel({ kind: "terminal", record: row.record })}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

/**
 * A ticket-rail row for a chat Session. There is no PTY behind it, so there is
 * nothing to activate, resume, or report a live status for beyond `isOpen` —
 * deep chat activation (opening the actual transcript) is future UI work, not
 * this. `isOpen` mirrors `groupSessionRows`'s current/history split off the
 * one fact a chat row has: whether its structured attachment is still live.
 */
export interface TicketChatSessionRow {
  record: ChatSessionRecord;
  title: string;
  isOpen: boolean;
}

/** Chat Sessions for a ticket, named and grouped the same way a terminal record's rail row is. */
export function buildTicketChatSessionRows(
  records: readonly ChatSessionRecord[],
): TicketChatSessionRow[] {
  return records.map((record) => ({ record, title: record.title, isOpen: record.live }));
}

/** {@link filterSessionHistory}'s title+source match, over chat rows instead of durable records. */
export function filterChatSessionHistory(
  rows: readonly TicketChatSessionRow[],
  query: string,
): TicketChatSessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    `${row.title}\n${sessionSourceLabel({ kind: "chat", record: row.record })}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

/**
 * One rendered row of the rail: a terminal row (rename, resume, activate) or a
 * chat row (activate, and title and liveness — a chat Session is durable, so
 * even a closed one opens onto its own history; rename waits for a live tab to
 * keep in sync). Discriminated the same way `SessionListingRow` is, one layer up
 * the view model.
 */
export type SessionRailRow =
  | { kind: "terminal"; row: TicketSessionRow }
  | { kind: "chat"; row: TicketChatSessionRow };

/**
 * The rail's two row kinds in one list, newest first. Ordering is by creation,
 * across both kinds, rather than by concatenation: `listForTicket` hands its
 * rows back newest-first already, and appending the chat ones would sink every
 * chat Session below every terminal one however recent it is.
 */
export function mergeSessionRailRows(
  terminal: readonly TicketSessionRow[],
  chat: readonly TicketChatSessionRow[],
): SessionRailRow[] {
  const rows: SessionRailRow[] = [
    ...terminal.map((row): SessionRailRow => ({ kind: "terminal", row })),
    ...chat.map((row): SessionRailRow => ({ kind: "chat", row })),
  ];
  return rows.toSorted((a, b) => b.row.record.createdAt - a.row.record.createdAt);
}

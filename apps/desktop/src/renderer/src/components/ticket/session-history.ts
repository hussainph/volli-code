import {
  canResumeHarness,
  getHarnessAdapter,
  harnessLabel,
  type SessionActivityState,
  type SessionHarnessState,
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
 */
export function sessionSourceLabel(record: SessionRecord): string {
  const source =
    record.launchKind === "agent"
      ? harnessLabel(record.harnessId)
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
 * Whether `record` can be resumed (interrupt/resume, issue #78). A record
 * qualifies only when it actually launched an agent (a bare shell or
 * pre-metadata `unknown` record has no harness session to resume), has
 * actually ended (a still-live session has nothing to resume INTO — it's
 * already running), and its harness knows how to resume at all — an
 * unrecognized/generic harness id makes {@link canResumeHarness} false for both
 * its by-id and latest-in-cwd fallbacks.
 *
 * Capability, not a command line: the resume line names the generated wrapper
 * by absolute path, and those paths are main's alone.
 *
 * The built-ins are the honest lookup to pass HERE, and only here: the renderer
 * has no channel over which a registered manifest's adapter could reach it, so
 * claiming to consult a wider set would be a lie about what this process knows.
 */
export function canResumeSession(record: SessionRecord): boolean {
  return (
    record.launchKind === "agent" &&
    record.endedAt !== null &&
    canResumeHarness(record.harnessId, record.harnessSessionId, getHarnessAdapter)
  );
}

/**
 * The newest resumable record among `records`, or `null` if none qualify.
 * Compares `createdAt` directly rather than trusting input order — the store
 * (`listTicketSessions`, `created_at DESC`) already hands these back
 * newest-first, but this stays correct even if a caller passes an
 * unordered/filtered subset.
 */
export function latestResumableSession(records: readonly SessionRecord[]): SessionRecord | null {
  let latest: SessionRecord | null = null;
  for (const record of records) {
    if (!canResumeSession(record)) continue;
    if (latest === null || record.createdAt > latest.createdAt) latest = record;
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
    `${row.title}\n${sessionSourceLabel(row.record)}`.toLocaleLowerCase().includes(needle),
  );
}

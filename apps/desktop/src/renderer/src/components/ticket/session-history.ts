import {
  buildHarnessResumeCommand,
  harnessLabel,
  type SessionActivityState,
  type SessionRecord,
} from "@volli/shared";

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
 * unrecognized/generic harness id makes {@link buildHarnessResumeCommand}
 * return `null` for both its by-id and latest-in-cwd fallbacks.
 */
export function canResumeSession(record: SessionRecord): boolean {
  return (
    record.launchKind === "agent" &&
    record.endedAt !== null &&
    buildHarnessResumeCommand(record.harnessId, record.harnessSessionId) !== null
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

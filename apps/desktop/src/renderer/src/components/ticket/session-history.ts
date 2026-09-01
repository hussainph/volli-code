import {
  canResumeHarness,
  effectiveHarnessId,
  harnessLabel,
  type ChatSessionRecord,
  type HarnessAdapterLookup,
  type SessionActivityState,
  type SessionHarnessState,
  type SessionListingIdentity,
  type SessionListingRow,
  type SessionProvenance,
  type SessionRecord,
} from "@volli/shared";

import { nextAgeChangeAt } from "../../lib/relative-time";
import {
  WORKING_WINDOW_MS,
  sessionActivityState,
  sessionPanes,
  type SessionTab,
} from "../../stores/sessions";

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
 * Truthful, compact source metadata: the sidebar's session rows carry it in
 * their hover `title` (their meta line now prints the ticket's status, which is
 * what a long band is scanned by), and the rail's history search matches on it
 * — the rail's own rows stopped drawing it when they went to one line and put
 * the kind in a leading glyph. Only agent launches expose a harness. Bare
 * shells and pre-metadata sessions never inherit the default Claude label;
 * split placement remains visible without becoming the title.
 *
 * The harness named is the one RUNNING, not the one the session launched with:
 * a pane whose agent was quit and replaced reads as what is in it now. A shell
 * launch that later ran an agent still reads as "Shell" — `launchKind` is a
 * fact about the pane's origin and no announce changes it.
 *
 * A chat row has none of that — no PTY and no launch — so its source is simply
 * `Chat`. Whether its executor is attached remains a functional grouping fact,
 * not source metadata to display.
 */
// Takes the identity half, not a whole row: naming a Session's source has
// nothing to do with what it spent, and demanding a usage summary would make
// every caller holding a bare record invent one.
export function sessionSourceLabel(row: SessionListingIdentity): string {
  if (row.kind === "chat") return "Chat";
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
 * The `lastOutputAt` entries {@link buildTicketSessionRows} can actually read
 * for one ticket — a stamp per DURABLE TERMINAL RECORD it walks, and nothing
 * else.
 *
 * The store keeps one flat output-stamp map for every live session in the app
 * and replaces it wholesale on each bump (a busy session bumps about once a
 * second), so a panel subscribed to the map itself re-derived this ticket's
 * whole roster whenever any session anywhere printed a line — including every
 * session of every other ticket and project, none of which it can name.
 *
 * The key set is this panel's own and deliberately not the sidebar's
 * (`listingOutputStamps`, which walks live CONTAINERS): the rail's rows come
 * from the durable per-ticket listing, and a live pane whose record has not
 * landed in that cache yet contributes no row and so can be read by nothing
 * here. Shallow-compared, an irrelevant bump now yields the same object.
 *
 * A narrower SUBSCRIPTION, not a coarser input: the raw stamps ride through
 * untouched, so every status is derived from exactly the numbers it was before.
 */
export function ticketOutputStamps(input: {
  lastOutputAt: Readonly<Record<string, number>>;
  /** The ticket's durable listing rows, as the records store caches them. */
  rows: readonly SessionListingRow[];
}): Record<string, number> {
  const stamps: Record<string, number> = {};
  for (const row of input.rows) {
    if (row.kind !== "terminal") continue;
    const at = input.lastOutputAt[row.record.id];
    if (at !== undefined) stamps[row.record.id] = at;
  }
  return stamps;
}

/**
 * Who started each of a ticket's Sessions, keyed by Session id (VC-131).
 *
 * The rail splits its listing rows into two record arrays and builds its own
 * view rows from those, so the row wrapper — which is where provenance rides,
 * beside `usage`, because it is a fact about the Session rather than about the
 * attachment — is gone by the time a row is drawn. This is the one read that
 * keeps it, in the same sparse shape the sidebar's store uses: a miss is the
 * resting case, so a ticket nobody automated contributes an empty object and
 * the rail gains no weight from this feature at all.
 */
export function ticketSessionProvenance(
  rows: readonly SessionListingRow[],
): Readonly<Record<string, SessionProvenance>> {
  const provenance: Record<string, SessionProvenance> = {};
  for (const row of rows) {
    if (row.provenance.kind === "user") continue;
    provenance[row.kind === "terminal" ? row.record.id : row.record.sessionId] = row.provenance;
  }
  return provenance;
}

/** What an open pane knows about itself, indexed by {@link livePanesById}. */
interface LivePane {
  exitCode: number | null;
  /** The live TAB title — the root pane's row prefers it so optimistic renames show. */
  tabTitle: string;
  /** The tab's root session id, which is what a row activates. */
  tabId: string;
}

/**
 * paneSessionId → its live state, for EVERY pane of every open tab (not just
 * tab roots): each split pane has its own durable record, so without this a
 * live split pane would render as an inert "Exited" row.
 *
 * Shared by the row build and {@link nextTicketSessionStatusChangeAt}, which
 * has to know the same thing about the same panes — a boundary derived from a
 * second, differently-written walk is a boundary that can disagree with the
 * word it is supposed to be the expiry of.
 */
function livePanesById(tabs: readonly SessionTab[]): Map<string, LivePane> {
  const liveById = new Map<string, LivePane>();
  for (const tab of tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      liveById.set(pane.sessionId, {
        exitCode: pane.exitCode,
        tabTitle: tab.title,
        tabId: tab.sessionId,
      });
    }
  }
  return liveById;
}

/**
 * The rail's session rows: one per durable record, each carrying the status the
 * rail chip shows. Pure and clock-injected so the derivation is unit-testable
 * without the panel around it (the same split as the sidebar's
 * `active-session-listing`) — and, more to the point, so BOTH surfaces reach
 * `sessionActivityState` through the same argument list. A rail that fed it only
 * PTY facts was structurally unable to show a blocked agent while the sidebar,
 * reading the same store, sorted that session to the top of its Active band.
 */
export function buildTicketSessionRows(input: TicketSessionRowsInput): TicketSessionRow[] {
  const liveById = livePanesById(input.tabs);

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
 * The first instant a status {@link buildTicketSessionRows} just produced reads
 * differently with no new input, or `null` when none of them can.
 *
 * There is exactly one clock-driven transition in this derivation, and it is
 * the last rung of {@link sessionActivityState}: an open pane that printed
 * something recently says `working` and, a fixed window after that last line,
 * says `idle` — with nothing having happened in between. That is the whole
 * reason this panel used to hold a one-second interval, re-deriving every row
 * sixty times a minute against the chance that this one instant had passed. The
 * derivation can simply say when it is.
 *
 * `exited` is the only fact excluded, because it is the only one that makes a
 * row's word permanent — the rest of the walk is deliberately over-inclusive.
 * A parked pane, a pane whose harness is declaring its own state, and a row
 * showing `setup` all outrank output recency and so cannot actually flip here,
 * but each of those is a fact that can stop being true while the timer is
 * armed, and a boundary that changes nothing costs one recompute that finds
 * nothing — while a missing one leaves a row saying the wrong word until
 * something unrelated happens to move.
 */
export function nextTicketSessionStatusChangeAt(input: TicketSessionRowsInput): number | null {
  const liveById = livePanesById(input.tabs);
  let soonest: number | null = null;
  for (const record of input.records) {
    const live = liveById.get(record.id);
    if (live === undefined || live.exitCode !== null) continue;
    const lastOutput = input.lastOutputAt[record.id];
    if (lastOutput === undefined) continue;
    // +1: the window is inclusive (`<=` in `sessionActivityState`), so the
    // first instant the answer differs is one millisecond past its end.
    const at = lastOutput + WORKING_WINDOW_MS + 1;
    // Already past: the row reads `idle` now and stays `idle` until a new line
    // of output moves the stamp, which is an input change, not a clock one.
    if (at <= input.now) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
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
export function canResumeSession(
  row: SessionListingIdentity,
  lookup: HarnessAdapterLookup,
): boolean {
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
 * nothing to resume — opening the Session is already everything a resume would
 * buy. `isOpen` preserves `groupSessionRows`'s current/history behavior from
 * whether the Session's structured attachment is open; the finer state the
 * record carries (`activity`, `lastActivityAt`) is what the rail's row trails
 * with, so a chat and a terminal report themselves in one vocabulary.
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
 * chat row (rename, activate, title, and current/history placement — a chat
 * Session is durable, so even a closed one opens onto its own history, which is
 * why it offers no resume). Discriminated the same way `SessionListingRow` is, one
 * layer up the view model.
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

/**
 * The instant a History row's relative stamp is measured from: when a chat
 * Session last said anything, when a terminal Session ended — or, for a record
 * that somehow never got an end stamp, when it was created, which is the
 * oldest instant that is certainly true of it.
 *
 * One definition, because the row that PRINTS the stamp and the timer that
 * waits for it to change have to be reading the same number. Two copies of
 * `endedAt ?? createdAt` is how a column ends up refreshing on a boundary
 * belonging to a different date than the one on screen.
 */
export function sessionRailRowStampAt(row: SessionRailRow): number {
  return row.kind === "chat"
    ? row.row.record.lastActivityAt
    : (row.row.record.endedAt ?? row.row.record.createdAt);
}

/**
 * The soonest instant any of `rows` prints a different age than it does at
 * `now`, or `null` for an empty list.
 *
 * {@link nextAgeChangeAt} is documented against `compactAge`, and these rows
 * print `relativeTime`; the boundary is the same instant either way. The two
 * formatters walk one ladder — `compactAge` is `relativeTime` with the strings
 * shortened, not the buckets changed — and past the four-week rollup both
 * render an absolute date whose only moving part is the year.
 */
export function nextSessionRailAgeChangeAt(
  rows: readonly SessionRailRow[],
  now: number,
): number | null {
  let soonest: number | null = null;
  for (const row of rows) {
    const at = nextAgeChangeAt(sessionRailRowStampAt(row), now);
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

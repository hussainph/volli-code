import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  errorMessage,
  sessionProvenanceHoverLine,
  sessionProvenanceOf,
  type SessionListingRow,
  type SessionProvenance,
  type SessionRecord,
} from "@volli/shared";

import { renameChatSession } from "@renderer/chat/rename";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import { resumeTicketSession } from "@renderer/components/sessions/session-create";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { Input } from "@renderer/components/ui/input";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import type { SplitDragPayload } from "@renderer/components/split/split-drop";
import { ListRow, ListRowSkeleton } from "@renderer/components/ui/list-row";
import { loadingRegionProps } from "@renderer/components/ui/loading-region";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { SessionProvenanceMark } from "@renderer/components/sessions/session-provenance-mark";
import {
  RAIL_PANEL_INSET,
  RailFold,
  RailFoldBody,
  RailFoldHeadingRow,
  RailHeadingReadStatus,
  RailReadFaultBody,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  railReadCanClaimEmpty,
  railReadFeedback,
} from "@renderer/components/ticket/rail-read-feedback";
import { SESSION_ROSTER_FILTER_THRESHOLD as SESSION_FILTER_THRESHOLD } from "@renderer/components/ticket/session-history";
import {
  buildTicketChatSessionRows,
  buildTicketSessionRows,
  canResumeSession,
  filterChatSessionHistory,
  filterSessionHistory,
  groupSessionRows,
  mergeSessionRailRows,
  nextSessionRailAgeChangeAt,
  nextTicketSessionStatusChangeAt,
  orderSessionRailRowsByAttention,
  sessionRailRowActivityAt,
  sessionRailRowStampAt,
  ticketOutputStamps,
  ticketSessionProvenance,
  type SessionRailRow,
  type TicketSessionStatus,
} from "@renderer/components/ticket/session-history";
import { SESSION_ACTIVITY_LABEL } from "@renderer/components/ui/session-activity-status";
import { delayUntil } from "@renderer/lib/boundary-timer";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { launchAdapter, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import {
  ticketSessionListingStateOf,
  useTicketSessionRecordsStore,
} from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { phaseFor, useWorktreeStore } from "@renderer/stores/worktree";
import { renameTerminalSession } from "@renderer/terminal/session-lifecycle";

/** Stable empty list so the rows selector never returns a fresh reference
 *  (and re-renders the panel) on unrelated store updates while the cache is cold. */
const NO_ROWS: SessionListingRow[] = [];

function sessionStatusLabel(status: TicketSessionStatus): string {
  return status === "setup" ? "Setup" : SESSION_ACTIVITY_LABEL[status];
}

/** The earlier of two boundary instants, either of which may be "never". */
function soonest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

/**
 * The one block: the live rows, and the record folded under them. One shape,
 * one inset, no seam. No top padding of its own: the Now page stacks its
 * blocks with one `gap`, so a block that is absent leaves no gap behind it
 * (VC-406).
 */
const SECTION = cn("flex flex-col gap-1", RAIL_PANEL_INSET);

/**
 * The inline empty, inside the dashed frame this rail uses for a section that
 * has rows on other days. Written once — the two sites that take it (no current
 * sessions, no history matches) were two copies of the same string.
 */
const SESSION_SECTION_EMPTY = cn(
  "rounded-lg border border-dashed border-sidebar-border",
  EMPTY_INLINE,
);

/**
 * Every row's QUIET SECOND LINE: one tone dot, the state, and when (VC-406).
 *
 * It was the row's right EDGE, competing with the title for one line's width —
 * so at the rail's 300px a real Session title read `Investigate the session
 * li…` beside `Waiting for you`, and the two facts the row exists to carry
 * each cost the other. The title has the whole line now; the state has its own
 * underneath at `text-label` (11/16), inside `ListRow`'s 52px `two-line`
 * density. A live row says what it is doing and a past one says when it
 * stopped, in the same two-part shape either way — which is what lets the
 * column be read down rather than row by row.
 *
 * The dot takes the STATE, not a colour. This panel used to hold its own
 * status→tone map and the tab strip held a second one that disagreed with it
 * about the same Session — `ui/status-dot.tsx` is now the only place either
 * question is answered. Terminal history is `exited`; a stopped chat keeps
 * `stopped` so the deliberate end does not disappear into generic history.
 */
function RowStatus({ state, children }: { state: StatusDotState; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-label text-muted-foreground">
      <StatusDot state={state} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * One session, flat: kind glyph, title, status — one line, no frame. The frame
 * and the second metadata line the rail used to draw made three sessions look
 * like three cards to inspect; the roster's job is to be read down in a glance,
 * so the border only appears under the pointer and the kind moved off the
 * second line and into the leading glyph
 * (the retired ticket-right-sidebar lab scratch: `SessionRows`).
 *
 * That glyph is `ChatCircle`/`TerminalWindow` — the pair the sidebar's session
 * bands, the tab strip and the new-session menu all already use for the two
 * kinds — rather than the scratch's `ChatCircleDots`, which is the rail's own
 * Now-tab icon and would have put the page's glyph on every row inside it. It
 * is labelled, not decorative: with the source line gone it is the only place
 * the kind is stated at all.
 *
 * A past terminal row is inert for activation (its pane is gone; Resume is in
 * the menu), so it draws as a div and never lights up under the pointer — which
 * is the honest way to say "not a target" without dimming a title a person may
 * still want to read.
 */
function SessionRow({
  kind,
  title,
  status,
  provenance,
  editing,
  drag,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResume,
}: {
  kind: "chat" | "terminal";
  /** The live tab title when open (so optimistic renames show), else the durable record title. */
  title: string;
  /** The quiet line under the title: the state, and when. */
  status: React.ReactNode;
  /**
   * Who started this Session (VC-131). The rail is a listing like any other, so
   * it draws the same mark the sidebar's bands do, from the same component —
   * the rule is that a Run's Session is distinguishable everywhere a Session
   * appears, and a rail with its own idea of that would be the second place to
   * fix when the mark changes.
   */
  provenance: SessionProvenance;
  editing: boolean;
  /**
   * What this row would open if it were dropped on a pane (VC-202 §4), or
   * `null` for a row that is not a door — which is the same condition that
   * makes `onActivate` null, said for the other gesture.
   */
  drag: SplitDragPayload | null;
  /** `null` where there is nothing to open — a closed terminal record's pane is gone. */
  onActivate: (() => void) | null;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
  /** Present only for resumable history rows (interrupt/resume, issue #78). */
  onResume?(): void;
}) {
  const Glyph = kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  const row = (
    <ListRow
      // Two lines, 52px: the title owns one and the state owns the other. While
      // a row is being renamed it drops to the one-line density — the field
      // fills the name's line, and a quiet status under an input being typed
      // into is a second thing moving in a row that is already changing.
      density={editing ? "row" : "two-line"}
      // While editing the row is inert: an input inside the activating button
      // would both nest an interactive control and open the Session on every
      // click into the field.
      onActivate={editing ? null : onActivate}
      // …and a row being renamed does not drag either: the pointer is there to
      // select text in the field under it.
      {...splitDragSourceProps(editing ? null : drag)}
      leading={
        <Glyph
          aria-label={kind === "chat" ? "Chat" : "Terminal"}
          className="size-4 shrink-0 text-muted-foreground"
        />
      }
      primary={
        editing ? (
          <InlineRename
            value={title}
            ariaLabel={`Rename ${title}`}
            className="min-w-0 flex-1"
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span
            // `gap-1` is the ladder's icon↔label rung (docs/DESIGN.md), and the
            // same gap the mark sits at in the sidebar's rows.
            className="flex min-w-0 flex-1 items-center gap-1"
            // The provenance line is the whole mark for a Session another
            // Session started, and it rides on a node the row already had.
            title={sessionProvenanceHoverLine(provenance) ?? undefined}
          >
            {/* Left of the title rather than after it: this row's right edge is
                the status column, and a mark that drifted between the title and
                that column depending on title length would stop being scannable
                down the list. */}
            <SessionProvenanceMark provenance={provenance} rowTitle={title} />
            <span
              className="min-w-0 flex-1 truncate text-ui font-medium"
              onDoubleClick={onStartRename}
            >
              {title}
            </span>
          </span>
        )
      }
      secondary={editing ? undefined : status}
    />
  );

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          {onResume !== undefined ? (
            <ContextMenuItem icon={ArrowClockwiseIcon} onSelect={onResume}>
              Resume
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem icon={PencilSimpleIcon} onSelect={onStartRename}>
            Rename
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * Two rows' worth of the roster's own geometry, while the baseline read is in
 * flight: the list's gap, a `ListRow`'s inset and height, a title at the left
 * and the status phrase at the right. No words — the rows that replace this
 * carry the words.
 */
function SessionListSkeleton() {
  return (
    <div
      className="flex flex-col gap-1"
      {...loadingRegionProps("sessions")}
      data-testid="ticket-sessions-loading"
    >
      {(["w-3/5", "w-2/5"] as const).map((width) => (
        <ListRowSkeleton key={width} mark primaryWidth={width} trailingWidth="w-12" />
      ))}
    </div>
  );
}

function SessionList({
  rows,
  variant,
  provenance,
  now,
  lastOutputAt,
  projectId,
  ticketId,
  editingId,
  setEditingId,
  setActivePane,
  onActivateSession,
  onActivateChat,
  onCommitRename,
  onCommitChatRename,
  onResumeSession,
}: {
  rows: readonly SessionRailRow[];
  /**
   * Which age a row's quiet line dates itself from: a current row says when the
   * Session last did anything, a record row says when it stopped.
   */
  variant: "current" | "history";
  /** Sparse, keyed by Session id — a miss is the resting case (VC-131). */
  provenance: Readonly<Record<string, SessionProvenance>>;
  /** The clock both variants' relative stamps are read against. */
  now: number;
  /**
   * Last-output stamps, narrowed to this ticket's own terminal records
   * (`ticketOutputStamps`). A LIVE terminal has no ending to date itself from,
   * so its age is the last line it printed.
   */
  lastOutputAt: Readonly<Record<string, number>>;
  /** Half of a drag payload's scope; the ticket below is the other half. */
  projectId: string;
  ticketId: string;
  editingId: string | null;
  setEditingId(sessionId: string | null): void;
  setActivePane(ownerId: string, tabId: string, paneId: string): void;
  onActivateSession(sessionId: string): void;
  onActivateChat(sessionId: string): void;
  onCommitRename(record: SessionRecord, isRoot: boolean, next: string): void;
  onCommitChatRename(sessionId: string, next: string): void;
  onResumeSession(record: SessionRecord): void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((entry) => {
        if (entry.kind === "chat") {
          const { record, title } = entry.row;
          const { sessionId } = record;
          return (
            <SessionRow
              key={sessionId}
              kind="chat"
              title={title}
              provenance={sessionProvenanceOf(provenance, sessionId)}
              // A chat Session's activity is the same vocabulary a terminal
              // row's status is (`ChatSessionRecord.activity` is a subset of
              // `SessionActivityState`), so the two kinds say their state in
              // one vocabulary rather than repeating source metadata. Every
              // row carries its age beside that state now (VC-406) — a live
              // row dating itself from when the Session last did anything,
              // a record row from when it stopped.
              status={
                variant === "current" ? (
                  <RowStatus state={record.activity}>
                    {sessionStatusLabel(record.activity)} ·{" "}
                    {relativeTime(sessionRailRowActivityAt(entry, lastOutputAt), now)}
                  </RowStatus>
                ) : record.activity === "stopped" || record.activity === "interrupted" ? (
                  // VC-324: `interrupted` is durable, so a History row keeps
                  // saying the last turn died after a relaunch exactly as long
                  // as a `stopped` one keeps saying it was ended on purpose —
                  // collapsing either into generic history is the drift.
                  <RowStatus state={record.activity}>
                    {sessionStatusLabel(record.activity)} ·{" "}
                    {relativeTime(sessionRailRowStampAt(entry), now)}
                  </RowStatus>
                ) : (
                  <RowStatus state="exited">
                    {relativeTime(sessionRailRowStampAt(entry), now)}
                  </RowStatus>
                )
              }
              editing={editingId === sessionId}
              // A chat Session is durable, so it drags whether or not it has a
              // tab: dropping it adopts it and mints one, exactly as clicking.
              drag={{
                type: "session",
                scope: "ticket",
                projectId,
                ticketId,
                kind: "chat",
                sessionId,
              }}
              // Always activatable, unlike a terminal row — a chat Session is
              // durable, so one whose attachment has closed still opens onto its
              // own history, and reattaching is the Retry the plane offers.
              onActivate={() => onActivateChat(sessionId)}
              onStartRename={() => setEditingId(sessionId)}
              onCommitRename={(next) => onCommitChatRename(sessionId, next)}
              onCancelRename={() => setEditingId(null)}
            />
          );
        }
        const { record, title, isRoot, tabId, status } = entry.row;
        return (
          <SessionRow
            key={record.id}
            kind="terminal"
            title={title}
            provenance={sessionProvenanceOf(provenance, record.id)}
            status={
              variant === "current" ? (
                <RowStatus state={status}>
                  {sessionStatusLabel(status)} ·{" "}
                  {relativeTime(sessionRailRowActivityAt(entry, lastOutputAt), now)}
                </RowStatus>
              ) : (
                <RowStatus state="exited">
                  {relativeTime(sessionRailRowStampAt(entry), now)}
                </RowStatus>
              )
            }
            editing={editingId === record.id}
            // Only an OPEN terminal drags: the tab is what a pane holds, and a
            // closed record has none — the same fact that sends activation to
            // its saved detail below rather than into a pane.
            drag={
              tabId === undefined
                ? null
                : {
                    type: "session",
                    scope: "ticket",
                    projectId,
                    ticketId,
                    kind: "terminal",
                    sessionId: tabId,
                  }
            }
            // Exited-but-open panes live in History but still activate their tab
            // and exact split pane. A CLOSED record has no tab to activate, and
            // it is no longer inert either (VC-290): it opens its own saved
            // record — the same destination the sidebar's Previous row and ⌘K
            // now reach, so the three surfaces holding this Session's history
            // answer a click the same way.
            onActivate={
              tabId === undefined
                ? record.endedAt === null
                  ? null
                  : () => {
                      useUiStore.getState().openSessionDetail(projectId, record.id);
                    }
                : () => {
                    onActivateSession(tabId);
                    setActivePane(ticketId, tabId, record.id);
                  }
            }
            onStartRename={() => setEditingId(record.id)}
            onCommitRename={(next) => onCommitRename(record, isRoot, next)}
            onCancelRename={() => setEditingId(null)}
            onResume={
              variant === "history" && canResumeSession({ kind: "terminal", record }, launchAdapter)
                ? () => onResumeSession(record)
                : undefined
            }
          />
        );
      })}
    </ul>
  );
}

/**
 * The Now page's roster: ONE "Sessions" section — the working set (one flat
 * row per live session from the unified store) with the record of the
 * ended/closed durable Sessions FOLDED under it, searchable past 4 entries
 * (VC-406).
 *
 * The record used to be a sibling section, "History", with its own eyebrow and
 * a count badge. Two sections for one roster read at two ages put the block a
 * reader consults most — the live rows — and the block they consult least
 * twenty rows apart, and the page's other blocks had to choose which of the
 * two to sit beside. Here the eyebrow's own LABEL is the fold
 * (`RailFoldHeadingRow`): `SESSIONS ›` with the record away, `SESSIONS ⌄` with
 * it under the live rows, and `+ Chat ▾` still the row's one control at the
 * right. The count of what is folded is in the trigger's accessible name and
 * nowhere on the face — the caret alone says there is more, and an eyebrow
 * holds a label and at most one control (docs/DESIGN.md).
 *
 * THIS IS NOT THE RETIRED DRAWER. History was once a `RailDrawer`: a
 * full-bleed `border-t` across the whole column, an uppercase trigger with a
 * rotating caret, a collapse animation, and the WHOLE block behind it. Nothing
 * here bleeds past the section's inset, the closed state still shows the rows
 * that matter, only the record folds, and the trigger never moves — the
 * record opens under it, so a second press lands where the first did. The
 * motion is the rail's one fold (`rail-panel-parts.tsx`), not this file's.
 *
 * The fold is a GLOBAL preference (`railFolds.sessionsRecord`), not
 * per-ticket: it is how a person reads the rail, and a reader who wants the
 * record open wants it open on the next Ticket too. A roster with no record
 * offers no fold at all — a caret opening onto nothing is a lie about the
 * block.
 *
 * One component still owns both halves: they are two views of ONE read of the
 * durable roster and one pair of clocks. The `children` slot that briefly let
 * the page thread a block between them (VC-406's first pass) is gone — there
 * is nothing between them any more.
 *
 * It sits IN FLOW: the Now page is one scrolling column (ticket-rail.tsx), so
 * this owns no scroller of its own. The durable list
 * (`api.sessions.listForTicket`) is re-read whenever the live set changes so
 * new sessions appear and closed ones fold into the record. Rows rename inline
 * (double-click) or via the right-click menu.
 */
export function TicketSessionsPanel({
  projectId,
  ticketId,
  creating,
  onNewSession,
  onNewChat,
  onNewBrowser,
  onActivateSession,
  onActivateChat,
}: {
  /** Whose project this ticket is — half of a row's drag payload (VC-202 §4). */
  projectId: string;
  ticketId: string;
  creating: boolean;
  onNewSession(): void;
  onNewChat(): void;
  /** Opens a blank Browser Tab in the main strip, in this ticket's scope. */
  onNewBrowser?(): void;
  onActivateSession(sessionId: string): void;
  onActivateChat(sessionId: string): void;
}) {
  const open = useUiStore((state) => state.railFolds.sessionsRecord);
  const liveTabs = useSessionsStore((state) => state.byOwner[ticketId]?.tabs);
  const parkState = useSessionsStore((state) => state.parkState);
  // The sidebar's session bands read this exact map for their own attention
  // rows; reading it here is what keeps the two surfaces from answering "is the
  // agent blocked on me?" differently at the same instant.
  const harness = useSessionsStore((state) => state.harness);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const worktreePhase = useWorktreeStore((state) => phaseFor(state.phases, ticketId));
  // `creating`/`copying` haven't booted a PTY yet, so there's no session row to
  // chip — they reuse the existing pre-boot "starting" affordance (disables the
  // session-start control the same way an in-flight `starting[ticketId]` create
  // does) rather than inventing a second loading state.
  const effectiveCreating = creating || worktreePhase === "creating" || worktreePhase === "copying";
  // The durable list is a shared cache (stores/ticket-session-records.ts), not
  // local state: the exited-pane resume overlay reads the exact same cache
  // (it can't invent a second `listForTicket` fetch — see session-split-layout.tsx),
  // and SessionsLayer's exit handler refreshes it directly so a just-ended
  // session's `endedAt`/resumability lands here without this panel needing to
  // be the one to notice the exit.
  //
  // VC-383 records the baseline's answer as data in the shared store: an
  // unread/loading roster holds its rows' box, only `loaded` earns the empty
  // sentence, and `failed` replaces either lie with the brief failure line.
  // A component must not infer that lifecycle from whether its row array exists.
  const listing = useTicketSessionRecordsStore((state) => state.byTicket[ticketId]);
  const listingState = useTicketSessionRecordsStore((state) =>
    ticketSessionListingStateOf(state, ticketId),
  );
  const listingError = useTicketSessionRecordsStore(
    (state) => state.listingError?.[ticketId] ?? null,
  );
  // Rows survive a failed refresh in the store, so "has this ever landed" is a
  // question about the CACHE rather than about the state word: a refresh that
  // failed leaves last-good rows drawn, with the caveat on the heading.
  const readState = {
    hasData: listing !== undefined,
    pending: listingState === "loading",
    failed: listingState === "failed",
  };
  const feedback = railReadFeedback(readState, "Sessions");
  // "Nothing here" is a claim about what a read RETURNED, so only a landed read
  // may make it — the conflation this gate exists to remove drew the failure
  // line and the empty sentence together.
  const canClaimEmpty = railReadCanClaimEmpty(readState);
  const rows = listing ?? NO_ROWS;
  const records = rows.flatMap((row) => (row.kind === "terminal" ? [row.record] : []));
  const chatSessions = rows.flatMap((row) => (row.kind === "chat" ? [row.record] : []));
  // Narrowed to the stamps THIS ticket's rows can name — see `ticketOutputStamps`.
  const lastOutputAt = useSessionsStore(
    useShallow((state) => ticketOutputStamps({ lastOutputAt: state.lastOutputAt, rows })),
  );
  // The clock the STATUS column is read against, advanced only on the instant a
  // status can change on its own (the working→idle window closing). Between
  // boundaries it is deliberately behind the wall clock, and no row is
  // re-derived for the difference, because no row can move in that gap.
  const [activityNow, setActivityNow] = React.useState(() => Date.now());
  // The clock History's relative stamps are read against — a separate one, for
  // the reason the sidebar keeps two: a roster of week-old rows changes its
  // ages about once a day, and making that share a clock with a live session's
  // ten-second window would wake it every ten seconds forever.
  const [ageNow, setAgeNow] = React.useState(() => Date.now());
  const [editingId, setEditingId] = React.useState<string | null>(null);
  // ONE query over the whole roster (VC-406). It used to live inside the fold
  // and reach only the record, so a reader who typed a title that belonged to a
  // live Session was told the roster held no match for it.
  const [rosterQuery, setRosterQuery] = React.useState("");
  const searching = rosterQuery.trim() !== "";

  const tabs = liveTabs ?? [];

  const refresh = React.useCallback(
    () => useTicketSessionRecordsStore.getState().ensure(ticketId),
    [ticketId],
  );
  // `refresh`, not `ensure`: `ensure` no-ops on a ticket whose listing already
  // loaded, so a retry routed through it would do nothing on exactly the
  // surface that offers it.
  const retry = React.useCallback(
    () => void useTicketSessionRecordsStore.getState().refresh(ticketId),
    [ticketId],
  );

  // The BASELINE read, and only that. A window that has just opened has missed
  // every push that came before it, so a ticket's rows are read once and
  // `volli:session-activity` carries the list from there — which is why this no
  // longer re-fires on the set of open panes (`liveSignature`). A split, a
  // create and a close are all durable Session facts the push announces; a
  // refetch on the same trigger would just race the push to say the same
  // thing. `ensure` no-ops on a warm ticket, so a rail page flip or a ticket
  // re-open paints from cache without re-asking main.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Renaming the root pane of a live tab goes through the shared optimistic-
  // persist path (so its tab strip updates too); a non-root live pane or an
  // ended session has no live tab title to keep in sync, so persist directly and
  // reconcile the local list.
  const commitRename = (record: SessionRecord, isRoot: boolean, next: string) => {
    setEditingId(null);
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === record.title) return;
    useTicketSessionRecordsStore.getState().renameLocally(ticketId, record.id, trimmed);
    if (isRoot) {
      renameTerminalSession(record.id, trimmed);
      return;
    }
    window.api.sessions
      .rename({ sessionId: record.id, title: trimmed })
      .then((result) => {
        if (!result.ok) {
          toastError(`Rename failed: ${result.error}`);
          void refresh();
        }
      })
      .catch((error: unknown) => {
        toastError(`Rename failed: ${errorMessage(error)}`);
        void refresh();
      });
  };

  // A chat row's whole rename — optimistic slice, optimistic cached record,
  // persist, toast — lives in `renameChatSession`, since the tab strip renames
  // the same Sessions and the two surfaces must not drift.
  const commitChatRename = (sessionId: string, next: string) => {
    setEditingId(null);
    void renameChatSession(sessionId, next);
  };

  // The shared boot pipeline (session-create.ts) — starting-flag guard, engine
  // pre-create, structured-error toast — same as a fresh terminal create, just with a
  // resume intent instead of a fresh kickoff. Lands as a NEW tab; the ended
  // record's own row stays put in History.
  const handleResume = (record: SessionRecord) => {
    void resumeTicketSession(ticketScope(record.projectId, ticketId), record.id).then(
      (sessionId) => {
        if (sessionId !== null) onActivateSession(sessionId);
      },
    );
  };

  const rowsInput = {
    records,
    tabs,
    lastOutputAt,
    parkState,
    harness,
    settingUp: worktreePhase === "setting-up",
    now: activityNow,
  };
  const terminalRows = buildTicketSessionRows(rowsInput);
  const { current: terminalCurrent, history: terminalHistory } = groupSessionRows(terminalRows);
  // A chat Session's lifecycle is NOT whether its attachment is open (VC-406):
  // a Session is durable and outlives every attachment it has ever had, so
  // closing its tab ends nothing. `isLive` is the record's own answer, and it
  // is what keeps a Session that is BLOCKED on a person out of the fold.
  const chatRows = buildTicketChatSessionRows(chatSessions);
  const chatCurrent = chatRows.filter((row) => row.isLive);
  const chatHistory = chatRows.filter((row) => !row.isLive);

  // Whatever is asking for a person leads the live rows; the record stays a
  // chronology.
  const current = orderSessionRailRowsByAttention(
    mergeSessionRailRows(
      filterSessionHistory(terminalCurrent, rosterQuery),
      filterChatSessionHistory(chatCurrent, rosterQuery),
    ),
  );
  const history = mergeSessionRailRows(terminalHistory, chatHistory);
  const filteredHistory = mergeSessionRailRows(
    filterSessionHistory(terminalHistory, rosterQuery),
    filterChatSessionHistory(chatHistory, rosterQuery),
  );
  // The WHOLE roster, unfiltered, which is what the filter's own threshold is
  // counted over: the query reaches both halves, so what doing without it costs
  // is the total rather than either half (`HOME_SESSION_FILTER_THRESHOLD` makes
  // the same call one scope up).
  const rosterSize = terminalCurrent.length + chatCurrent.length + history.length;
  const filterable = rosterSize > SESSION_FILTER_THRESHOLD || searching;
  // A query dissolves the fold: its matches in the record are ROWS ON THE PAGE,
  // not rows behind a caret the reader would have to guess was hiding them.
  const foldable = history.length > 0 && !searching;

  /**
   * NOTHING HERE POLLS. Two clocks, each waiting on an instant a pure function
   * named: the status column on the working→idle window closing, History's ages
   * on the soonest stamp that stops reading the way it does now. What they
   * replace is one `setInterval` that woke every second for as long as the
   * ticket had a live session and re-derived every row — the whole roster, both
   * sections, the merge and the sort — to discover, sixty times a minute, that
   * nothing had changed.
   *
   * Both are re-armed on every render from the value they were last given; if a
   * boundary does not move after firing, the dependency does not change and the
   * timer is not re-armed, which is what keeps them from spinning.
   */
  const statusBoundaryAt = nextTicketSessionStatusChangeAt(rowsInput);
  React.useEffect(() => {
    if (statusBoundaryAt === null) return;
    const timer = window.setTimeout(() => setActivityNow(Date.now()), delayUntil(statusBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [statusBoundaryAt]);

  // Over the rows the FILTER leaves on screen, not the whole of History: an age
  // nobody is looking at has no boundary worth waking for. `ageNow` is a
  // dependency as well as an input — a boundary computed against a clock that
  // is deliberately behind can land in the past, and keying the effect on the
  // boundary alone would then recompute the same instant and arm nothing.
  //
  // TWO READINGS, ONE CLOCK (VC-406). Every row carries an age now, and a live
  // row's is measured from when the Session last DID something while a record
  // row's is measured from when it stopped — so the boundary is the sooner of
  // the two, computed each against the stamp its own rows print. One reading
  // over both would arm the timer on an instant half the column is not waiting
  // for.
  const ageBoundaryAt = soonest(
    nextSessionRailAgeChangeAt(current, ageNow, (row) =>
      sessionRailRowActivityAt(row, lastOutputAt),
    ),
    nextSessionRailAgeChangeAt(filteredHistory, ageNow),
  );
  React.useEffect(() => {
    if (ageBoundaryAt === null) return;
    const timer = window.setTimeout(() => setAgeNow(Date.now()), delayUntil(ageBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [ageBoundaryAt, ageNow]);

  const listProps = {
    projectId,
    now: ageNow,
    lastOutputAt,
    // Read off the listing rows before the panel splits them into two record
    // arrays, which is where the row wrapper carrying it is lost (VC-131).
    provenance: ticketSessionProvenance(rows),
    ticketId,
    editingId,
    setEditingId,
    setActivePane,
    onActivateSession,
    onActivateChat,
    onCommitRename: commitRename,
    onCommitChatRename: commitChatRename,
    onResumeSession: handleResume,
  };

  return (
    <RailFold
      asChild
      open={open && foldable}
      onOpenChange={() => useUiStore.getState().toggleRailFold("sessionsRecord")}
    >
      <section className={SECTION} aria-label="Sessions" data-testid="ticket-sessions">
        {/* The heading is inset by the rows' own `px-2`, not by the section's
            edge: a label that hangs left of the list it names reads as a
            divider between blocks rather than as that list's title. The row is
            `justify-between` and carries the reviewed design's always-present
            "+" at its right (the scratch's `SessionRows` header) — the height
            comes from the control, so there is no reserved dead space when the
            roster is full. The label is the record's fold. */}
        <RailFoldHeadingRow
          label="Sessions"
          open={open}
          foldable={foldable}
          triggerLabel={
            open
              ? "Hide past sessions"
              : `Show ${history.length} past session${history.length === 1 ? "" : "s"}`
          }
          testId="ticket-sessions-fold"
          // The mark rides the eyebrow the block already owns — no reserved
          // strip, and no word beside it: this row's budget is a label and one
          // control, and the third thing is what pushes "+ Chat" off the end of
          // a 240px rail.
          status={
            <RailHeadingReadStatus
              feedback={feedback}
              onRetry={retry}
              testId="ticket-sessions-read-status"
            />
          }
        >
          <NewSessionControl
            disabled={effectiveCreating}
            placement="rail"
            align="end"
            shortcuts
            onNewChat={onNewChat}
            onNewBrowser={onNewBrowser}
            onNewTerminal={onNewSession}
          />
        </RailFoldHeadingRow>
        {/* ONE field over the WHOLE roster, live rows and record alike — in
            flow, above the rows it narrows, exactly where Home's is. It used to
            live INSIDE the fold and reach only the record, so a reader who
            typed the title of a running Session was told the roster held no
            match for it. */}
        {filterable ? (
          <div className="relative mb-1">
            <MagnifyingGlassIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={rosterQuery}
              onChange={(event) => setRosterQuery(event.target.value)}
              aria-label="Find a session"
              placeholder="Find a session…"
              className="h-8 pl-8 text-ui md:text-ui"
            />
          </div>
        ) : null}
        {feedback?.kind === "reading" ? (
          // The baseline read is in flight. The heading and its "+" stay live
          // above — a pending list blocks nothing about starting a Session —
          // and the rows hold their box below.
          <SessionListSkeleton />
        ) : null}
        {/* A refused baseline knows nothing about this Ticket's Sessions. The
            toast carries the bridge detail; this keeps the block from claiming
            the roster is empty when it has never been read, and carries the one
            action that can change that. */}
        <RailReadFaultBody
          feedback={feedback}
          detail={listingError}
          onRetry={retry}
          testId="ticket-sessions-error"
        />
        {current.length === 0 && (!searching || filteredHistory.length === 0) && canClaimEmpty ? (
          // Nothing to read, so the block is the sentence alone: the header's
          // own control is 20px above it, and a second copy of the same act
          // inside the empty frame would be the same offer twice in one glance.
          // Gated on a read having LANDED — a refused one has proved nothing.
          <p className={SESSION_SECTION_EMPTY}>
            {searching ? "No matching sessions" : "No active sessions"}
          </p>
        ) : null}
        {current.length > 0 ? (
          <SessionList rows={current} variant="current" {...listProps} />
        ) : null}
        {/* The record. While a query is active it is drawn in flow with the live
            matches above it; otherwise it lives under the eyebrow's fold, which
            Radix mounts only while open (and through the close animation), so a
            folded record costs no rows and no age-clock re-derivation. */}
        {searching ? (
          filteredHistory.length > 0 ? (
            <div className="flex flex-col gap-1 pt-1" data-testid="session-history">
              <SessionList rows={filteredHistory} variant="history" {...listProps} />
            </div>
          ) : null
        ) : foldable ? (
          <RailFoldBody>
            <div className="flex flex-col gap-1 pt-1" data-testid="session-history">
              <SessionList rows={filteredHistory} variant="history" {...listProps} />
            </div>
          </RailFoldBody>
        ) : null}
      </section>
    </RailFold>
  );
}

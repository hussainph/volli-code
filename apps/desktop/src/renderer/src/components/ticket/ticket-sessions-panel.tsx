import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { errorMessage, type SessionListingRow, type SessionRecord } from "@volli/shared";

import { renameChatSession } from "@renderer/chat/rename";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import { resumeTicketSession } from "@renderer/components/sessions/session-create";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Badge } from "@renderer/components/ui/badge";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import {
  buildTicketChatSessionRows,
  buildTicketSessionRows,
  canResumeSession,
  filterChatSessionHistory,
  filterSessionHistory,
  groupSessionRows,
  mergeSessionRailRows,
  type SessionRailRow,
  type TicketSessionStatus,
} from "@renderer/components/ticket/session-history";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import {
  launchAdapter,
  sessionPanes,
  ticketScope,
  useSessionsStore,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { phaseFor, useWorktreeStore } from "@renderer/stores/worktree";
import { renameTerminalSession } from "@renderer/terminal/session-lifecycle";

/** Stable empty list so the rows selector never returns a fresh reference
 *  (and re-renders the panel) on unrelated store updates while the cache is cold. */
const NO_ROWS: SessionListingRow[] = [];

const STATUS_LABEL: Record<TicketSessionStatus, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
  setup: "Setup",
};

/** Sessions and History are the same block twice — one shape, one inset, no seam. */
const SECTION = cn("flex flex-col gap-1 pt-4", RAIL_PANEL_INSET);

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
 * A section's title line: the uppercase label at the left, whatever the block
 * offers at the right. Inset by the rows' own `px-2` rather than the section's
 * edge, so the label sits over its list instead of hanging left of it.
 */
function SectionHeadingRow({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2 px-2">
      <SectionHeading>{label}</SectionHeading>
      {children}
    </div>
  );
}

/**
 * Every row's right edge: one tone dot, one short phrase, at label size. A live
 * row says what it is doing and a past one says when it stopped, in the same
 * two-part shape either way — which is what lets the column be read down rather
 * than row by row. Pill chrome read too loud in the 300px rail.
 *
 * The dot takes the STATE, not a colour. This panel used to hold its own
 * status→tone map and the tab strip held a second one that disagreed with it
 * about the same Session — `ui/status-dot.tsx` is now the only place either
 * question is answered. A history row is `exited` by definition, which is why
 * the old `PAST_TONE` constant is gone rather than replaced.
 */
function RowStatus({ state, children }: { state: StatusDotState; children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
      <StatusDot state={state} />
      {children}
    </span>
  );
}

/**
 * One session, flat: kind glyph, title, status — one line, no frame. The frame
 * and the second metadata line the rail used to draw made three sessions look
 * like three cards to inspect; the roster's job is to be read down in a glance,
 * so the border only appears under the pointer and the kind moved off the
 * second line and into the leading glyph
 * (lab/scratches/ticket-right-sidebar.tsx: `SessionRows`).
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
  trailing,
  editing,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResume,
}: {
  kind: "chat" | "terminal";
  /** The live tab title when open (so optimistic renames show), else the durable record title. */
  title: string;
  /** Right-edge metadata: live status for current rows, relative end time for history rows. */
  trailing: React.ReactNode;
  editing: boolean;
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
      // While editing the row is inert: an input inside the activating button
      // would both nest an interactive control and open the Session on every
      // click into the field.
      onActivate={editing ? null : onActivate}
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
          <span className="min-w-0 flex-1 truncate text-ui" onDoubleClick={onStartRename}>
            {title}
          </span>
        )
      }
      trailing={trailing}
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

function SessionList({
  rows,
  variant,
  now,
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
  /** Current rows trail with live status; history rows trail with when they ended. */
  variant: "current" | "history";
  now: number;
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
              // A chat Session's activity is the same vocabulary a terminal
              // row's status is (`ChatSessionRecord.activity` is a subset of
              // `SessionActivityState`), so the two kinds trail with one column
              // rather than a status beside a "Chat · Live". A row in History
              // has no live state left to report, only when it last said
              // anything.
              trailing={
                variant === "current" ? (
                  <RowStatus state={record.activity}>{STATUS_LABEL[record.activity]}</RowStatus>
                ) : (
                  <RowStatus state="exited">{relativeTime(record.lastActivityAt, now)}</RowStatus>
                )
              }
              editing={editingId === sessionId}
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
            trailing={
              variant === "current" ? (
                <RowStatus state={status}>{STATUS_LABEL[status]}</RowStatus>
              ) : (
                <RowStatus state="exited">
                  {relativeTime(record.endedAt ?? record.createdAt, now)}
                </RowStatus>
              )
            }
            editing={editingId === record.id}
            // Exited-but-open panes live in History but still activate their tab
            // and exact split pane; closed records (no live tab, so no `tabId`)
            // remain inert until resume lands.
            onActivate={
              tabId === undefined
                ? null
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
 * The Now page's session content: a "Sessions" working set (one flat row per
 * live session from the unified store) and, under it, a "History" set of the
 * ended/closed durable records — searchable past 4 entries.
 *
 * The two are SIBLING SECTIONS of one shape, not a list plus a drawer. History
 * used to be a `RailDrawer`: a full-bleed `border-t` across the whole column, an
 * uppercase trigger with a rotating caret, and a collapse animation. That
 * primitive existed so History and a Details drawer could stack as siblings;
 * Details folded into the repository card and the properties fold, and one
 * caller was left dragging the old icon-mode rail's chrome — a seam the Calm
 * Stack draws nowhere (lab/scratches/ticket-right-sidebar.tsx has no drawer, no
 * collapsible and no full-bleed rule in the rail at all). Both sections now
 * inset with the column (`RAIL_PANEL_INSET`) instead of a hardcoded `px-4`, so
 * the rail's edge is one straight line at every width.
 *
 * Both sit IN FLOW: the Now page is one scrolling column (ticket-rail.tsx), so
 * this owns no scroller of its own and History is simply the last thing in the
 * stack. The durable list (`api.sessions.listForTicket`) is re-read whenever the
 * live set changes so new sessions appear and closed ones fold into History.
 * Rows rename inline (double-click) or via the right-click menu.
 */
export function TicketSessionsPanel({
  ticketId,
  creating,
  onNewSession,
  onNewChat,
  onActivateSession,
  onActivateChat,
}: {
  ticketId: string;
  creating: boolean;
  onNewSession(): void;
  onNewChat(): void;
  onActivateSession(sessionId: string): void;
  onActivateChat(sessionId: string): void;
}) {
  const liveTabs = useSessionsStore((state) => state.byOwner[ticketId]?.tabs);
  const lastOutputAt = useSessionsStore((state) => state.lastOutputAt);
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
  const rows = useTicketSessionRecordsStore((state) => state.byTicket[ticketId] ?? NO_ROWS);
  const records = rows.flatMap((row) => (row.kind === "terminal" ? [row.record] : []));
  const chatSessions = rows.flatMap((row) => (row.kind === "chat" ? [row.record] : []));
  const [now, setNow] = React.useState(() => Date.now());
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = React.useState("");

  const tabs = liveTabs ?? [];
  // Signature of every currently-open PANE (not just tab roots) — refetch the
  // durable list on any change (create, split, or close), since each split pane
  // has its own durable record that must appear/fold alongside the tab roots.
  const liveSignature = tabs
    .map((tab) =>
      sessionPanes(tab.layout)
        .map((pane) => pane.sessionId)
        .join("/"),
    )
    .join(",");
  const hasLive = tabs.length > 0;

  const refresh = React.useCallback(
    () => useTicketSessionRecordsStore.getState().refresh(ticketId),
    [ticketId],
  );

  React.useEffect(() => {
    void refresh();
  }, [refresh, liveSignature]);

  // Tick while any live session exists so working → idle flips honestly.
  React.useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);

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

  const terminalRows = buildTicketSessionRows({
    records,
    tabs,
    lastOutputAt,
    parkState,
    harness,
    settingUp: worktreePhase === "setting-up",
    now,
  });
  const { current: terminalCurrent, history: terminalHistory } = groupSessionRows(terminalRows);
  // A chat Session's only lifecycle fact is whether its attachment is still
  // open, which is the same current/history line `groupSessionRows` draws.
  const chatRows = buildTicketChatSessionRows(chatSessions);
  const chatCurrent = chatRows.filter((row) => row.isOpen);
  const chatHistory = chatRows.filter((row) => !row.isOpen);

  const current = mergeSessionRailRows(terminalCurrent, chatCurrent);
  const history = mergeSessionRailRows(terminalHistory, chatHistory);
  const filteredHistory = mergeSessionRailRows(
    filterSessionHistory(terminalHistory, historyQuery),
    filterChatSessionHistory(chatHistory, historyQuery),
  );

  const listProps = {
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
    <>
      <section className={SECTION}>
        {/* The heading is inset by the rows' own `px-2`, not by the section's
            edge: a label that hangs left of the list it names reads as a
            divider between blocks rather than as that list's title. The row is
            `justify-between` and carries the reviewed design's always-present
            "+" at its right (the scratch's `SessionRows` header) — the height
            comes from the control, so there is no reserved dead space when the
            roster is full. */}
        <SectionHeadingRow label="Sessions">
          <NewSessionControl
            disabled={effectiveCreating}
            placement="rail"
            align="end"
            shortcuts
            onNewChat={onNewChat}
            onNewTerminal={onNewSession}
          />
        </SectionHeadingRow>
        {current.length === 0 ? (
          // Nothing to read, so the block is the sentence alone: the header's
          // own control is 20px above it, and a second copy of the same act
          // inside the empty frame would be the same offer twice in one glance.
          <p className={SESSION_SECTION_EMPTY}>No active sessions</p>
        ) : (
          <SessionList rows={current} variant="current" now={now} {...listProps} />
        )}
      </section>
      {history.length > 0 ? (
        <section className={SECTION} data-testid="session-history">
          <SectionHeadingRow label="History">
            <Badge variant="count-pill">{history.length}</Badge>
          </SectionHeadingRow>
          {/* Past four rows the column stops being scannable, so the filter
              appears — in flow, like everything else in the stack. */}
          {history.length > 4 ? (
            <div className="relative mb-1">
              <MagnifyingGlassIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                aria-label="Search session history"
                placeholder="Search history…"
                className="h-8 pl-8 text-ui md:text-ui"
              />
            </div>
          ) : null}
          {filteredHistory.length > 0 ? (
            <SessionList rows={filteredHistory} variant="history" now={now} {...listProps} />
          ) : (
            <p className={SESSION_SECTION_EMPTY}>No matching sessions</p>
          )}
        </section>
      ) : null}
    </>
  );
}

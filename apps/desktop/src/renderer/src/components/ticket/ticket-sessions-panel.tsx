import * as React from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { errorMessage, type SessionRecord } from "@volli/shared";

import { InlineRename } from "@renderer/components/sessions/inline-rename";
import { resumeTicketSession } from "@renderer/components/sessions/session-create";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Input } from "@renderer/components/ui/input";
import { RailDrawer } from "@renderer/components/ticket/rail-drawer";
import {
  canResumeSession,
  filterSessionHistory,
  groupSessionRows,
  sessionSourceLabel,
  type TicketSessionRow,
  type TicketSessionStatus,
} from "@renderer/components/ticket/session-history";
import { relativeTime } from "@renderer/lib/relative-time";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import {
  sessionActivityState,
  sessionPanes,
  ticketScope,
  useSessionsStore,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { phaseFor, useWorktreeStore } from "@renderer/stores/worktree";
import { renameTerminalSession } from "@renderer/terminal/session-lifecycle";

/** Stable empty list so the records selector never returns a fresh reference
 *  (and re-renders the panel) on unrelated store updates while the cache is cold. */
const NO_RECORDS: SessionRecord[] = [];

const STATUS_LABEL: Record<TicketSessionStatus, string> = {
  working: "Working",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
  setup: "Setup",
};

/** Honest PTY-derived status, kept quiet: a small colored dot + label-size muted
 * text (the sidebar's ACTIVE SESSIONS dot treatment) — pill chrome read too loud
 * in the 300px rail. `setup` (the worktree's `setting-up` ensure phase) borrows
 * the same dot-plus-label vocabulary rather than inventing a new one. */
function StatusChip({ status }: { status: TicketSessionStatus }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-label text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          (status === "working" || status === "setup") && "bg-emerald-500",
          status === "idle" && "bg-muted-foreground/50",
          status === "parked" && "bg-muted-foreground/35",
          status === "exited" && "bg-muted-foreground/25",
        )}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

function SessionRow({
  record,
  title,
  trailing,
  isOpen,
  editing,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResume,
}: {
  record: SessionRecord;
  /** The live tab title when open (so optimistic renames show), else the durable record title. */
  title: string;
  /** Right-edge metadata: live status for current rows, relative end time for history rows. */
  trailing: React.ReactNode;
  isOpen: boolean;
  editing: boolean;
  onActivate(): void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
  /** Present only for resumable history rows (interrupt/resume, issue #78). */
  onResume?(): void;
}) {
  const titleNode = editing ? (
    <InlineRename
      value={title}
      ariaLabel={`Rename ${title}`}
      className="h-5 w-full text-xs"
      onCommit={onCommitRename}
      onCancel={onCancelRename}
    />
  ) : (
    <span className="truncate text-xs text-foreground" onDoubleClick={onStartRename}>
      {title}
    </span>
  );

  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        {titleNode}
        <span className="truncate text-label text-muted-foreground">
          {sessionSourceLabel(record)}
        </span>
      </span>
      {trailing}
    </>
  );

  // A live row (its terminal tab is still open) activates that tab; a past row
  // is inert for activation — resume is future work — but both can be renamed.
  const row =
    isOpen && !editing ? (
      <button
        type="button"
        onClick={onActivate}
        className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-left transition-colors hover:bg-accent"
      >
        {content}
      </button>
    ) : (
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-2 py-1",
          isOpen ? "border-border/60" : "border-transparent opacity-60",
        )}
      >
        {content}
      </div>
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
  onCommitRename,
  onResumeSession,
}: {
  rows: readonly TicketSessionRow[];
  /** Current rows trail with live status; history rows trail with when they ended. */
  variant: "current" | "history";
  now: number;
  ticketId: string;
  editingId: string | null;
  setEditingId(sessionId: string | null): void;
  setActivePane(ownerId: string, tabId: string, paneId: string): void;
  onActivateSession(sessionId: string): void;
  onCommitRename(record: SessionRecord, isRoot: boolean, next: string): void;
  onResumeSession(record: SessionRecord): void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {rows.map(({ record, title, isOpen, isRoot, tabId, status }) => (
        <SessionRow
          key={record.id}
          record={record}
          title={title}
          trailing={
            variant === "current" ? (
              <StatusChip status={status} />
            ) : (
              <span className="shrink-0 text-label text-muted-foreground/70">
                {relativeTime(record.endedAt ?? record.createdAt, now)}
              </span>
            )
          }
          isOpen={isOpen}
          editing={editingId === record.id}
          // Exited-but-open panes live in History but still activate their tab
          // and exact split pane; closed records remain inert until resume lands.
          onActivate={() => {
            if (tabId === undefined) return;
            onActivateSession(tabId);
            setActivePane(ticketId, tabId, record.id);
          }}
          onStartRename={() => setEditingId(record.id)}
          onCommitRename={(next) => onCommitRename(record, isRoot, next)}
          onCancelRename={() => setEditingId(null)}
          onResume={
            variant === "history" && canResumeSession(record)
              ? () => onResumeSession(record)
              : undefined
          }
        />
      ))}
    </ul>
  );
}

/**
 * The right rail's session content: a scrollable "Sessions" working set (a
 * "New session" button that boots a ticket-scoped terminal, plus one row per
 * live session from the unified store) and a bottom-pinned History drawer (a
 * `RailDrawer` sibling of Details) holding ended/closed durable records —
 * searchable past 4 entries — so the working set stays unlabeled and flat.
 * The durable list (`api.sessions.listForTicket`) is re-read whenever the live
 * set changes so new sessions appear and closed ones fold into History. Rows
 * rename inline (double-click) or via the right-click menu.
 */
export function TicketSessionsPanel({
  ticketId,
  creating,
  onNewSession,
  onActivateSession,
}: {
  ticketId: string;
  creating: boolean;
  onNewSession(): void;
  onActivateSession(sessionId: string): void;
}) {
  const liveTabs = useSessionsStore((state) => state.byOwner[ticketId]?.tabs);
  const lastOutputAt = useSessionsStore((state) => state.lastOutputAt);
  const parkState = useSessionsStore((state) => state.parkState);
  const setActivePane = useSessionsStore((state) => state.setActivePane);
  const worktreePhase = useWorktreeStore((state) => phaseFor(state.phases, ticketId));
  // `creating`/`copying` haven't booted a PTY yet, so there's no session row to
  // chip — they reuse the existing pre-boot "starting" affordance (disables
  // "New session" the same way an in-flight `starting[ticketId]` create does)
  // rather than inventing a second loading state.
  const effectiveCreating = creating || worktreePhase === "creating" || worktreePhase === "copying";
  // The durable list is a shared cache (stores/ticket-session-records.ts), not
  // local state: the exited-pane resume overlay reads the exact same cache
  // (it can't invent a second `listForTicket` fetch — see session-split-layout.tsx),
  // and SessionsLayer's exit handler refreshes it directly so a just-ended
  // session's `endedAt`/resumability lands here without this panel needing to
  // be the one to notice the exit.
  const records = useTicketSessionRecordsStore((state) => state.byTicket[ticketId] ?? NO_RECORDS);
  const [now, setNow] = React.useState(() => Date.now());
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
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

  // paneSessionId → its live state, for EVERY pane of every open tab (not just
  // tab roots): each split pane has its own durable record, so without this a
  // live split pane would render as an inert "Exited" row. `tabTitle` is the
  // live tab title (used for the root pane's optimistic rename); non-root panes
  // fall back to their own durable record title. `tabId` is the tab's root id.
  const liveById = new Map<string, { exitCode: number | null; tabTitle: string; tabId: string }>();
  for (const tab of tabs) {
    for (const pane of sessionPanes(tab.layout)) {
      liveById.set(pane.sessionId, {
        exitCode: pane.exitCode,
        tabTitle: tab.title,
        tabId: tab.sessionId,
      });
    }
  }

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

  // The shared boot pipeline (session-create.ts) — starting-flag guard, engine
  // pre-create, structured-error toast — same as "New session", just with a
  // resume intent instead of a fresh kickoff. Lands as a NEW tab; the ended
  // record's own row stays put in History.
  const handleResume = (record: SessionRecord) => {
    void resumeTicketSession(ticketScope(record.projectId, ticketId), record.id).then(
      (sessionId) => {
        if (sessionId !== null) onActivateSession(sessionId);
      },
    );
  };

  const rows: TicketSessionRow[] = records.map((record) => {
    const live = liveById.get(record.id);
    const isOpen = live !== undefined;
    const isRoot = live !== undefined && live.tabId === record.id;
    // Status derives from THIS pane's own exit code + output, not the tab root's.
    const exited = live !== undefined ? live.exitCode !== null : true;
    const parked = parkState[record.id]?.parked ?? false;
    // While the worktree's ensure pipeline is running its setup script, an open
    // pane's honest `working` status is less informative than naming what it's
    // actually doing — `setup` overrides it for every currently-open, NOT-YET-
    // EXITED row; an exited/crashed pane shows its real exited status even
    // during setup, rather than lying that setup is still in progress.
    const status: TicketSessionStatus =
      isOpen && !exited && worktreePhase === "setting-up"
        ? "setup"
        : isOpen
          ? sessionActivityState(lastOutputAt[record.id] ?? null, exited, now, parked)
          : "exited";
    // Root pane rows prefer the live tab title (optimistic rename shows before
    // the refetch); non-root pane rows show their own durable record title.
    const title = isRoot ? live.tabTitle : record.title;
    return { record, title, isOpen, isRoot, tabId: live?.tabId, status };
  });
  const { current, history } = groupSessionRows(rows);
  const filteredHistory = filterSessionHistory(history, historyQuery);

  const listProps = {
    ticketId,
    editingId,
    setEditingId,
    setActivePane,
    onActivateSession,
    onCommitRename: commitRename,
    onResumeSession: handleResume,
  };

  return (
    <>
      <section className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-label font-medium text-muted-foreground uppercase">Sessions</h2>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={effectiveCreating}
              onClick={onNewSession}
              aria-label="New session"
            >
              <PlusIcon />
            </Button>
          </div>
          {current.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border py-6 text-center">
              <TerminalWindowIcon weight="fill" className="size-4 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">No active sessions</p>
            </div>
          ) : (
            <SessionList rows={current} variant="current" now={now} {...listProps} />
          )}
        </div>
      </section>
      {history.length > 0 ? (
        <RailDrawer
          label="History"
          count={history.length}
          open={historyOpen}
          onOpenChange={(open) => {
            setHistoryOpen(open);
            if (!open) setHistoryQuery("");
          }}
          data-testid="session-history"
        >
          <div className="flex flex-col gap-1.5 px-4 pb-4">
            {history.length > 4 ? (
              <div className="relative">
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
                  className="h-8 pl-8 text-xs md:text-xs"
                />
              </div>
            ) : null}
            {filteredHistory.length > 0 ? (
              <div className="max-h-64 overflow-y-auto">
                <SessionList rows={filteredHistory} variant="history" now={now} {...listProps} />
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
                No matching sessions
              </p>
            )}
          </div>
        </RailDrawer>
      ) : null}
    </>
  );
}

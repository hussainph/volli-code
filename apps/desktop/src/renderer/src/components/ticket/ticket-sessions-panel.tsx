import * as React from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  errorMessage,
  harnessLabel,
  type SessionActivityState,
  type SessionRecord,
} from "@volli/shared";
import { toast } from "sonner";

import { InlineRename } from "@renderer/components/sessions/inline-rename";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { cn } from "@renderer/lib/utils";
import { findSessionPane, sessionActivityState, useSessionsStore } from "@renderer/stores/sessions";
import { renameTerminalSession } from "@renderer/terminal/session-lifecycle";

const STATUS_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  idle: "Idle",
  exited: "Exited",
};

/** Honest PTY-derived status: accent when working, muted when idle, dim outline when exited. */
function StatusChip({ status }: { status: SessionActivityState }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        status === "working" && "border-primary/50 bg-primary/10 text-primary",
        status === "idle" && "border-border bg-muted/40 text-muted-foreground",
        status === "exited" && "border-border/60 text-muted-foreground/70",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function SessionRow({
  record,
  title,
  status,
  isOpen,
  editing,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  record: SessionRecord;
  /** The live tab title when open (so optimistic renames show), else the durable record title. */
  title: string;
  status: SessionActivityState;
  isOpen: boolean;
  editing: boolean;
  onActivate(): void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
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
        <span className="truncate text-[11px] text-muted-foreground">
          {harnessLabel(record.harnessId)}
        </span>
      </span>
      <StatusChip status={status} />
    </>
  );

  // A live row (its terminal tab is still open) activates that tab; a past row
  // is inert for activation — resume is future work — but both can be renamed.
  const row =
    isOpen && !editing ? (
      <button
        type="button"
        onClick={onActivate}
        className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left transition-colors hover:bg-accent"
      >
        {content}
      </button>
    ) : (
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5",
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
          <ContextMenuItem icon={PencilSimpleIcon} onSelect={onStartRename}>
            Rename
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * Right-rail "Sessions" section: a "New session" button that boots a ticket-
 * scoped terminal (env-injected, hosted by the resident overlay above) and the
 * ticket's session rows — live sessions (from the unified store) plus past ones
 * (durable records via `api.sessions.listForTicket`), newest first. The durable
 * list is re-read whenever the live set changes so new sessions appear and
 * closed ones fold into the inert "past" rows. Rows rename inline (double-click)
 * or via the right-click menu.
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
  const [records, setRecords] = React.useState<SessionRecord[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const tabs = liveTabs ?? [];
  // Signature of the currently-open sessions — refetch the durable list on any
  // change (a create or a close), so the two views stay in sync.
  const liveSignature = tabs.map((tab) => tab.sessionId).join(",");
  const hasLive = tabs.length > 0;

  const refresh = React.useCallback(async () => {
    try {
      const result = await window.api.sessions.listForTicket({ ticketId });
      if (!result.ok) {
        toast.error(`Could not load sessions: ${result.error}`);
        return;
      }
      setRecords(result.sessions);
    } catch (error) {
      toast.error(`Could not load sessions: ${errorMessage(error)}`);
    }
  }, [ticketId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh, liveSignature]);

  // Tick while any live session exists so working → idle flips honestly.
  React.useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);

  // sessionId → { exitCode, title } for the open tabs this run.
  const liveById = new Map(
    tabs.map((tab) => [
      tab.sessionId,
      { exitCode: findSessionPane(tab.layout, tab.sessionId)?.exitCode ?? null, title: tab.title },
    ]),
  );

  // Renaming a live session goes through the shared optimistic-persist path; an
  // ended one has no live tab, so persist directly and reconcile the local list.
  const commitRename = (record: SessionRecord, isOpen: boolean, next: string) => {
    setEditingId(null);
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === record.title) return;
    setRecords((rows) => rows.map((r) => (r.id === record.id ? { ...r, title: trimmed } : r)));
    if (isOpen) {
      renameTerminalSession(record.id, trimmed);
      return;
    }
    window.api.sessions
      .rename({ sessionId: record.id, title: trimmed })
      .then((result) => {
        if (!result.ok) {
          toast.error(`Rename failed: ${result.error}`);
          void refresh();
        }
      })
      .catch((error: unknown) => {
        toast.error(`Rename failed: ${errorMessage(error)}`);
        void refresh();
      });
  };

  const rows = records.map((record) => {
    const live = liveById.get(record.id);
    const isOpen = live !== undefined;
    const exited = isOpen ? live.exitCode !== null : true;
    const status: SessionActivityState = isOpen
      ? sessionActivityState(lastOutputAt[record.id] ?? null, exited, now)
      : "exited";
    // Prefer the live tab title so an optimistic rename shows before the refetch.
    return { record, title: live?.title ?? record.title, isOpen, status };
  });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Sessions
        </h2>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={creating}
          onClick={onNewSession}
          aria-label="New session"
        >
          <PlusIcon />
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-border py-6 text-center">
          <TerminalWindowIcon weight="fill" className="size-4 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">No sessions yet</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ record, title, isOpen, status }) => (
            <SessionRow
              key={record.id}
              record={record}
              title={title}
              status={status}
              isOpen={isOpen}
              editing={editingId === record.id}
              onActivate={() => onActivateSession(record.id)}
              onStartRename={() => setEditingId(record.id)}
              onCommitRename={(next) => commitRename(record, isOpen, next)}
              onCancelRename={() => setEditingId(null)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

import * as React from "react";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import {
  errorMessage,
  harnessLabel,
  type SessionActivityState,
  type SessionRecord,
} from "@volli/shared";
import { toast } from "sonner";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { findSessionPane } from "@renderer/stores/sessions";
import { sessionActivityState, useTicketSessionsStore } from "@renderer/stores/ticket-sessions";

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
  status,
  isOpen,
  onActivate,
}: {
  record: SessionRecord;
  status: SessionActivityState;
  isOpen: boolean;
  onActivate(): void;
}) {
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground">{record.title}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {harnessLabel(record.harnessId)}
        </span>
      </span>
      <StatusChip status={status} />
    </>
  );

  // A live row (its terminal tab is still open) activates that tab; a past row
  // is inert — resume is future work, so there's no dead button.
  if (isOpen) {
    return (
      <li>
        <button
          type="button"
          onClick={onActivate}
          className="flex w-full items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left transition-colors hover:bg-accent"
        >
          {content}
        </button>
      </li>
    );
  }
  return (
    <li className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 opacity-60">
      {content}
    </li>
  );
}

/**
 * Right-rail "Sessions" section: a "New session" button that boots a ticket-
 * scoped terminal (env-injected, opened as a tab in the plane above) and the
 * ticket's session rows — live sessions (from the in-memory ticket store) plus
 * past ones (durable records via `api.sessions.listForTicket`), newest first.
 * The durable list is re-read whenever the live set changes so new sessions
 * appear and closed ones fold into the inert "past" rows.
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
  const liveTabs = useTicketSessionsStore((state) => state.byTicket[ticketId]?.tabs);
  const lastOutputAt = useTicketSessionsStore((state) => state.lastOutputAt);
  const [records, setRecords] = React.useState<SessionRecord[]>([]);
  const [now, setNow] = React.useState(() => Date.now());

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

  // sessionId → exit code (null while running) for the open tabs this run.
  const liveById = new Map(
    tabs.map((tab) => [
      tab.sessionId,
      findSessionPane(tab.layout, tab.sessionId)?.exitCode ?? null,
    ]),
  );

  const rows = records.map((record) => {
    const isOpen = liveById.has(record.id);
    const exited = isOpen ? liveById.get(record.id) !== null : true;
    const status: SessionActivityState = isOpen
      ? sessionActivityState(lastOutputAt[record.id] ?? null, exited, now)
      : "exited";
    return { record, isOpen, status };
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
          {rows.map(({ record, isOpen, status }) => (
            <SessionRow
              key={record.id}
              record={record}
              status={status}
              isOpen={isOpen}
              onActivate={() => onActivateSession(record.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

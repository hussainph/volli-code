import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
  type ArchivedTicket,
  type Project,
} from "@volli/shared";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useBoardStore } from "@renderer/stores/board";

/** "Jul 14, 2026" — a compact archived-on stamp. */
function formatArchivedAt(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Opens an http(s) url externally. Reuses the app's one sanctioned external-open
 * seam (the done-flow rail's "Open PR"): a `window.open` of an http(s) target
 * never opens a BrowserWindow — main's `setWindowOpenHandler` denies it and
 * routes the url to `shell.openExternal`. No new IPC needed.
 */
function openExternalUrl(url: string): void {
  window.open(url, "_blank", "noopener");
}

/**
 * One archived-ticket row: identity + title, its retained column, when it was
 * archived, and — the retention record CONCEPT #16 promises the Archive keeps —
 * the retained branch name and a link to its PR (both survive archive on
 * {@link ArchivedTicket}). Plus the two lifecycle actions (Restore / Delete).
 */
export function ArchiveRow({
  project,
  ticket,
  onRequestDelete,
}: {
  project: Project;
  ticket: ArchivedTicket;
  onRequestDelete(ticket: ArchivedTicket): void;
}) {
  const { branch, prUrl } = ticket;
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {displayTicketId(project.ticketPrefix, ticket.ticketNumber)}
          </span>
          <span className="truncate text-sm">{ticket.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          <span>{TICKET_STATUS_LABELS[ticket.status]}</span>
          <span aria-hidden>·</span>
          <span>Archived {formatArchivedAt(ticket.archivedAt)}</span>
          {branch !== null ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate font-mono" title={branch}>
                {branch}
              </span>
            </>
          ) : null}
          {prUrl !== null ? (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => openExternalUrl(prUrl)}
                className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline"
              >
                <GitPullRequestIcon className="size-3" />
                PR
              </button>
            </>
          ) : null}
        </div>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => void useBoardStore.getState().unarchiveTicket(project.id, ticket.id)}
      >
        <ArrowUUpLeftIcon />
        Restore
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Delete permanently"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => onRequestDelete(ticket)}
      >
        <TrashIcon />
      </Button>
    </li>
  );
}

/**
 * The Archive body: fetches the project's archived tickets on mount (Radix
 * remounts this each open, so every open is a fresh read) and lists them with
 * Restore + Delete. Delete routes through a single confirm {@link AlertDialog}
 * — the only destructive act (CONCEPT #16/#92), so it's gated behind an
 * explicit "this can't be undone" step.
 */
function ArchiveList({ project }: { project: Project }) {
  const archived = useBoardStore((state) => state.archivedByProject[project.id]);
  const [pendingDelete, setPendingDelete] = React.useState<ArchivedTicket | null>(null);
  // A failed fetch leaves `archived` undefined — without this flag that's the
  // "Loading…" branch with no way out. Tracked here so the body can offer Retry.
  const [loadFailed, setLoadFailed] = React.useState(false);

  const load = React.useCallback(() => {
    setLoadFailed(false);
    void useBoardStore
      .getState()
      .loadArchived(project.id)
      .then((ok) => {
        if (!ok) setLoadFailed(true);
      });
  }, [project.id]);

  React.useEffect(load, [load]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive</DialogTitle>
        <DialogDescription>Archived tickets in {project.name}</DialogDescription>
      </DialogHeader>
      {/* `undefined` = not loaded yet (a fetch is in flight); `[]` = loaded,
          genuinely empty. Distinguishing them avoids flashing "empty" before
          the first read lands. */}
      {loadFailed && archived === undefined ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
          <p className="text-sm">Couldn’t load the archive.</p>
          <Button variant="outline" size="xs" onClick={load}>
            Retry
          </Button>
        </div>
      ) : archived === undefined ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : archived.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
          <ArchiveIcon className="size-6" />
          <p className="text-sm">No archived tickets.</p>
        </div>
      ) : (
        <ul className="-mx-2 max-h-[min(55vh,26rem)] overflow-y-auto">
          {archived.map((ticket) => (
            <ArchiveRow
              key={ticket.id}
              project={project}
              ticket={ticket}
              onRequestDelete={setPendingDelete}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `${displayTicketId(project.ticketPrefix, pendingDelete.ticketNumber)} “${pendingDelete.title}” and its full history will be permanently deleted. This can’t be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) {
                  void useBoardStore.getState().deleteArchivedTicket(project.id, pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The per-project Archive dialog, owned by the board header — its only entry
 * point, so open state is the header's local useState rather than a global
 * ui-store flag (unlike {@link NewTicketDialog}, whose app-shell mount is
 * justified by the app-wide "c" hotkey). A vanished project can't strand the
 * open flag either: the header unmounts with the board and the state dies
 * with it. The body remounts per open, so every open refetches.
 */
export function ArchiveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const project = useSelectedProject();

  return (
    <Dialog open={open && project !== null} onOpenChange={onOpenChange}>
      <DialogContent>{project !== null && <ArchiveList project={project} />}</DialogContent>
    </Dialog>
  );
}

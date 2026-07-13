import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
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
import { useUiStore } from "@renderer/stores/ui";

/** "Jul 14, 2026" — a compact archived-on stamp. */
function formatArchivedAt(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** One archived-ticket row: identity + title, its retained column, when it was archived, and the two actions. */
function ArchiveRow({
  project,
  ticket,
  onRequestDelete,
}: {
  project: Project;
  ticket: ArchivedTicket;
  onRequestDelete(ticket: ArchivedTicket): void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {displayTicketId(project.ticketPrefix, ticket.ticketNumber)}
          </span>
          <span className="truncate text-sm">{ticket.title}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {TICKET_STATUS_LABELS[ticket.status]} · Archived {formatArchivedAt(ticket.archivedAt)}
        </div>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => useBoardStore.getState().unarchiveTicket(project.id, ticket.id)}
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

  React.useEffect(() => {
    void useBoardStore.getState().loadArchived(project.id);
  }, [project.id]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive</DialogTitle>
        <DialogDescription>Archived tickets in {project.name}</DialogDescription>
      </DialogHeader>
      {/* `undefined` = not loaded yet (a fetch is in flight); `[]` = loaded,
          genuinely empty. Distinguishing them avoids flashing "empty" before
          the first read lands. */}
      {archived === undefined ? (
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
 * The per-project Archive dialog: opened from the board header's Archive
 * button, controlled by the ui store's `archiveOpen` flag plus a selected
 * project (there's no Archive without one). Mirrors {@link NewTicketDialog}'s
 * shape — mounted app-wide, its body remounted per open so each open refetches.
 */
export function ArchiveDialog() {
  const project = useSelectedProject();
  const archiveOpen = useUiStore((state) => state.archiveOpen);
  const open = archiveOpen && project !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) useUiStore.getState().setArchiveOpen(false);
      }}
    >
      <DialogContent>{project !== null && <ArchiveList project={project} />}</DialogContent>
    </Dialog>
  );
}

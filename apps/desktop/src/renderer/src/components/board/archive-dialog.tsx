import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { GitPullRequestIcon } from "@phosphor-icons/react/dist/csr/GitPullRequest";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
  type ArchivedTicket,
  type Project,
} from "@volli/shared";

import { TagChip } from "@renderer/components/board/tag-chip";
import { canWriteNow, readOnlyControl, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { Markdown } from "@renderer/components/ticket/markdown";
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
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { resolveLabelColor } from "@renderer/lib/labels";
import { formatStamp } from "@renderer/lib/relative-time";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

/** "Jul 14, 2026" — a compact archived-on stamp. */
function formatArchivedAt(epochMs: number): string {
  return formatStamp(epochMs);
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
 * Past this many archived tickets the list grows a find field. Below it the
 * whole archive fits in view and a field would only be one more thing to read.
 */
export const ARCHIVE_SEARCH_THRESHOLD = 8;

/**
 * Whether an archived ticket answers a find query: a case-insensitive match on
 * its display id ("VC-12") or its title. A blank query matches everything.
 */
export function matchesArchiveQuery(
  ticketPrefix: string,
  ticket: ArchivedTicket,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    displayTicketId(ticketPrefix, ticket.ticketNumber).toLowerCase().includes(needle) ||
    ticket.title.toLowerCase().includes(needle)
  );
}

/**
 * One archived-ticket row: identity + title, its retained column, when it was
 * archived, and — the retention record CONCEPT #16 promises the Archive keeps —
 * the retained branch name and whether it had a PR (both survive archive on
 * {@link ArchivedTicket}).
 *
 * The row itself opens the ticket read-only ({@link ArchiveInspect}); the two
 * lifecycle actions sit beside it, outside the row's target, and do not look
 * alike: Restore is a labelled pill, permanent delete a quiet glyph after it.
 */
export function ArchiveRow({
  project,
  ticket,
  canWrite,
  onInspect,
  onRequestDelete,
}: {
  project: Project;
  ticket: ArchivedTicket;
  /** The project's host can serve writes (VC-576); Restore and Delete stand down otherwise. */
  canWrite: boolean;
  onInspect(ticket: ArchivedTicket): void;
  onRequestDelete(ticket: ArchivedTicket): void;
}) {
  const { branch, prUrl } = ticket;
  return (
    <li>
      {/* Both text lines are the caller's own elements — the name line is an
          id beside a title, and the meta line is a wrapping strip, which is
          the one thing a truncating row must not straighten. Nothing in them
          is interactive: they sit inside the row's own button. */}
      <ListRow
        density="two-line"
        onActivate={() => onInspect(ticket)}
        data-archived-ticket-id={ticket.id}
        primary={
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 font-mono text-ui text-muted-foreground">
              {displayTicketId(project.ticketPrefix, ticket.ticketNumber)}
            </span>
            <span className="truncate text-sm">{ticket.title}</span>
          </span>
        }
        secondary={
          <span className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-ui text-muted-foreground">
            <span>{TICKET_STATUS_LABELS[ticket.status]}</span>
            <span aria-hidden>·</span>
            <span>Archived {formatArchivedAt(ticket.archivedAt)}</span>
            {branch !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate font-mono">{branch}</span>
              </>
            ) : null}
            {prUrl !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  <GitPullRequestIcon className="size-3" />
                  PR
                </span>
              </>
            ) : null}
          </span>
        }
        actions={
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              {...readOnlyControl(canWrite)}
              onClick={() => {
                if (!canWriteNow(project.id)) return;
                void useBoardStore.getState().unarchiveTicket(project.id, ticket.id);
              }}
            >
              <ArrowUUpLeftIcon />
              Restore
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete permanently"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  {...readOnlyControl(canWrite)}
                  onClick={() => onRequestDelete(ticket)}
                >
                  <TrashIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Delete permanently</TooltipContent>
            </Tooltip>
          </span>
        }
      />
    </li>
  );
}

/**
 * One archived ticket, read-only: its identity, title, retained column and
 * labels, the branch and PR it kept, and its body — everything needed to know
 * what it was without restoring it. Navigation only: Restore and Delete live
 * on the list's rows, never here, so reading a ticket can't change it.
 */
export function ArchiveInspect({
  project,
  ticket,
  onBack,
}: {
  project: Project;
  ticket: ArchivedTicket;
  onBack(): void;
}) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[project.id]);
  const back = React.useRef<HTMLButtonElement>(null);
  // The row that opened this view unmounted with the list; without a landing
  // spot the dialog's focus would fall to the body.
  React.useEffect(() => back.current?.focus(), []);
  const { branch, prUrl } = ticket;
  return (
    <>
      <DialogHeader className="pr-6">
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={back}
                variant="ghost"
                size="icon-sm"
                aria-label="Archive"
                onClick={onBack}
              >
                <CaretLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Archive</TooltipContent>
          </Tooltip>
          <span className="font-mono text-ui text-muted-foreground">
            {displayTicketId(project.ticketPrefix, ticket.ticketNumber)}
          </span>
        </div>
        <DialogTitle className="break-words">{ticket.title}</DialogTitle>
        <DialogDescription>
          {TICKET_STATUS_LABELS[ticket.status]} · Archived {formatArchivedAt(ticket.archivedAt)}
        </DialogDescription>
      </DialogHeader>
      {ticket.labels.length > 0 || branch !== null || prUrl !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
          {ticket.labels.map((name) => (
            <TagChip key={name} tag={name} color={resolveLabelColor(projectLabels, name)} />
          ))}
          {branch !== null ? (
            <span className="min-w-0 truncate font-mono" title={branch}>
              {branch}
            </span>
          ) : null}
          {prUrl !== null ? (
            <button
              type="button"
              onClick={() => openExternalUrl(prUrl)}
              className="inline-flex shrink-0 items-center gap-1 text-primary-text hover:underline"
            >
              <GitPullRequestIcon className="size-3" />
              PR
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="max-h-[min(55vh,26rem)] overflow-y-auto">
        {ticket.body.trim() === "" ? (
          <p className="text-sm text-muted-foreground">No description.</p>
        ) : (
          <Markdown source={ticket.body} />
        )}
      </div>
    </>
  );
}

/**
 * The Archive body: fetches the project's archived tickets on mount (Radix
 * remounts this each open, so every open is a fresh read) and lists them with
 * Restore + Delete; a row opens that ticket read-only in place. Delete routes
 * through a single confirm {@link AlertDialog} — the only destructive act
 * (CONCEPT #16/#92), so it's gated behind an explicit "this can't be undone"
 * step.
 */
export function ArchiveList({ project }: { project: Project }) {
  const archived = useBoardStore((state) => state.archivedByProject[project.id]);
  const canWrite = useCanWrite(project.id);
  const [pendingDelete, setPendingDelete] = React.useState<ArchivedTicket | null>(null);
  const [query, setQuery] = React.useState("");
  // By id, not by object: a reload (or a restore from another window) swaps
  // the list, and a ticket that left the archive drops the view back to it.
  const [inspectingId, setInspectingId] = React.useState<string | null>(null);
  const inspecting =
    inspectingId === null ? undefined : archived?.find((ticket) => ticket.id === inspectingId);
  const list = React.useRef<HTMLUListElement>(null);
  // Back lands on the row it left from, not the top of the dialog.
  const returnTo = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (inspecting !== undefined || returnTo.current === null) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-archived-ticket-id="${CSS.escape(returnTo.current)}"]`)
      ?.focus();
    returnTo.current = null;
  }, [inspecting]);
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

  if (inspecting !== undefined) {
    return (
      <ArchiveInspect
        project={project}
        ticket={inspecting}
        onBack={() => {
          returnTo.current = inspecting.id;
          setInspectingId(null);
        }}
      />
    );
  }

  const searching = query.trim() !== "";
  const filterable = (archived?.length ?? 0) > ARCHIVE_SEARCH_THRESHOLD || searching;
  const shown =
    archived?.filter((ticket) => matchesArchiveQuery(project.ticketPrefix, ticket, query)) ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Archive</DialogTitle>
        <DialogDescription>Archived tickets in {project.name}</DialogDescription>
      </DialogHeader>
      {filterable ? (
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Find an archived ticket"
          placeholder="Find an archived ticket…"
          className="h-8 text-ui md:text-ui"
        />
      ) : null}
      {/* `undefined` = not loaded yet (a fetch is in flight); `[]` = loaded,
          genuinely empty. Distinguishing them avoids flashing "empty" before
          the first read lands. */}
      {loadFailed && archived === undefined ? (
        // All three states take the empty geometry: they hold the same slot in
        // turn, and a different one would jump the dialog as the read lands.
        <div className={cn(EMPTY_PAGE, "gap-4 text-muted-foreground")}>
          <p className="text-sm">Couldn’t load the archive.</p>
          <Button variant="outline" size="xs" onClick={load}>
            Retry
          </Button>
        </div>
      ) : archived === undefined ? (
        <div className={cn(EMPTY_PAGE, "text-muted-foreground")}>
          <p className="text-sm">Loading…</p>
        </div>
      ) : archived.length === 0 ? (
        <div className={cn(EMPTY_PAGE, "text-muted-foreground")}>
          <ArchiveIcon className="size-6" />
          <p className="text-sm">No archived tickets.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className={cn(EMPTY_PAGE, "text-muted-foreground")}>
          <p className="text-sm">No matching tickets.</p>
        </div>
      ) : (
        <ul ref={list} className="-mx-2 max-h-[min(55vh,26rem)] overflow-y-auto">
          {shown.map((ticket) => (
            <ArchiveRow
              key={ticket.id}
              project={project}
              ticket={ticket}
              canWrite={canWrite}
              onInspect={(next) => setInspectingId(next.id)}
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
              {...readOnlyControl(canWrite)}
              onClick={() => {
                if (pendingDelete && canWriteNow(project.id)) {
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

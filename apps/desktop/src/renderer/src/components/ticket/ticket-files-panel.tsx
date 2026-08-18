/**
 * Files navigator — the Calm Stack's files page
 * (lab/scratches/ticket-right-sidebar.tsx `FilesPanel`).
 *
 * A titled header over ONE flat list (decision #46, #53/#54 — never a deep
 * tree). The scratch retires the two uppercase section captions the icon-mode
 * rail used: a row's leading glyph already says whether it is a folder, a file
 * in the worktree, or a path the Ticket Body points at, and the referenced rows
 * repeat that in their sub-line. Worktree entries lead, referenced context
 * follows, because the worktree is what the current directory is about.
 *
 * Selecting a file opens/focuses a ticket file tab via preview/pin (decision
 * #56) — never from an fs event. A folder navigates in place; the header's
 * mono line is the way back out.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowUUpLeft";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { errorMessage, type DirEntry, type Ticket, type TicketAttachment } from "@volli/shared";

import {
  RAIL_PANEL_INSET,
  RailFaultBanner,
  RailPanelSkeleton,
  RailRowActions,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  buildTicketFilesNavigator,
  splitFilesPath,
  type TicketFileRefRow,
  type TicketWorktreeEntry,
} from "@renderer/components/ticket/ticket-files-model";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_INLINE, EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { Input } from "@renderer/components/ui/input";
import { ListRow } from "@renderer/components/ui/list-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { toastError } from "@renderer/lib/toast";

function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

function toWorktreeEntries(cwd: string, entries: readonly DirEntry[]): TicketWorktreeEntry[] {
  return entries.map((entry) => ({
    relPath: joinRel(cwd, entry.name),
    kind: entry.kind === "dir" ? "directory" : "file",
  }));
}

/**
 * The three kinds a row can be, and the glyph each wears — outline, the
 * baseline, on every row (CLAUDE.md: a scannable list is outline throughout
 * except for its own exceptions, and `fill` is never emphasis). Nothing here is
 * an exception among its neighbours: the three glyphs are already three
 * different DRAWINGS — a folder, a page with code marks, a tag — so filling all
 * of them separates nothing and only makes the column heavier to read down.
 */
const ROW_ICONS: Record<"file" | "directory" | "reference", PhosphorIcon> = {
  directory: FolderIcon,
  reference: TagIcon,
  file: FileCodeIcon,
};

function FileRow({
  relPath,
  label,
  kind,
  onActivate,
  onPin,
}: {
  relPath: string;
  label: string;
  kind: "file" | "directory" | "reference";
  onActivate(): void;
  /** Double-click pin — omitted for directories (they only navigate). */
  onPin?(): void;
}) {
  const { filename, parentPath } = splitFilesPath(relPath);
  const primary = kind === "reference" ? label : filename;
  const Icon = ROW_ICONS[kind];
  return (
    <ListRow
      density="two-line"
      data-testid="ticket-files-row"
      data-path={relPath}
      data-kind={kind}
      onActivate={onActivate}
      onDoubleClick={onPin}
      leading={<Icon className="size-4 shrink-0 text-muted-foreground" />}
      primary={`${primary}${kind === "directory" ? "/" : ""}`}
      // A reference says so here rather than under a caption, which is what
      // lets both kinds share one list.
      secondary={kind === "reference" ? `Referenced · ${parentPath}` : parentPath}
      // The chevron is information (this row goes somewhere) and rides inside
      // the target; the copy/open pair are their own click targets and cannot.
      trailing={
        kind === "directory" ? (
          <CaretDownIcon className="-rotate-90 shrink-0 text-muted-foreground" />
        ) : undefined
      }
      actions={
        kind === "directory" ? undefined : (
          <RailRowActions path={relPath} onOpen={() => onPin?.()} />
        )
      }
    />
  );
}

/** Presentational Files list — unit-tested via renderToStaticMarkup. */
export function TicketFilesList({
  referenced,
  worktree,
  onPreviewFile,
  onPinFile,
  onOpenDirectory,
}: {
  referenced: readonly TicketFileRefRow[];
  worktree: readonly TicketWorktreeEntry[];
  /** Single-click: open in the replaceable File preview slot (decision #56). */
  onPreviewFile(relPath: string): void;
  /** Double-click: make the File tab persistent (decision #56). */
  onPinFile(relPath: string): void;
  onOpenDirectory(relPath: string): void;
}) {
  if (referenced.length === 0 && worktree.length === 0) {
    return (
      <p data-testid="ticket-files-empty" className={EMPTY_INLINE}>
        Nothing here yet
      </p>
    );
  }

  return (
    <ul
      data-testid="ticket-files-list"
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-8 [scroll-padding-bottom:2rem]"
    >
      {worktree.map((entry) => (
        <li key={`wt:${entry.relPath}`}>
          <FileRow
            relPath={entry.relPath}
            label={splitFilesPath(entry.relPath).filename}
            kind={entry.kind}
            onActivate={() =>
              entry.kind === "directory"
                ? onOpenDirectory(entry.relPath)
                : onPreviewFile(entry.relPath)
            }
            onPin={entry.kind === "directory" ? undefined : () => onPinFile(entry.relPath)}
          />
        </li>
      ))}
      {referenced.map((row) => (
        <li key={`ref:${row.relPath}`}>
          <FileRow
            relPath={row.relPath}
            label={row.label}
            kind="reference"
            onActivate={() => onPreviewFile(row.relPath)}
            onPin={() => onPinFile(row.relPath)}
          />
        </li>
      ))}
    </ul>
  );
}

const NO_ATTACHMENTS: readonly TicketAttachment[] = [];

/**
 * Ticket Files panel: body refs + optional attachments + worktree directory
 * listing. Attachments are accepted as a prop because the renderer has no
 * attachments IPC yet — hosts that can supply them (or tests) pass them in.
 * Single-click previews; double-click pins (decision #56).
 */
export function TicketFilesPanel({
  ticket,
  attachments = NO_ATTACHMENTS,
  onPreviewFile,
  onPinFile,
}: {
  ticket: Ticket;
  attachments?: readonly TicketAttachment[];
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
}) {
  const [cwd, setCwd] = React.useState("");
  const [entries, setEntries] = React.useState<TicketWorktreeEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(ticket.worktreePath === null);
  const [filtering, setFiltering] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const loadDir = React.useCallback(
    async (nextCwd: string) => {
      if (ticket.worktreePath === null) {
        setEntries([]);
        setError(null);
        setLoaded(true);
        return;
      }
      const abs = nextCwd === "" ? ticket.worktreePath : `${ticket.worktreePath}/${nextCwd}`;
      try {
        const result = await window.api.fs.listDirectory(abs);
        if (!result.ok) {
          setError(result.error);
          toastError(`Couldn't list worktree files: ${result.error}`);
          setLoaded(true);
          return;
        }
        setError(null);
        setEntries(toWorktreeEntries(nextCwd, result.entries));
        setCwd(nextCwd);
        setLoaded(true);
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        toastError(`Couldn't list worktree files: ${message}`);
        setLoaded(true);
      }
    },
    [ticket.worktreePath],
  );

  React.useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const nav = buildTicketFilesNavigator({
    body: ticket.body,
    attachments,
    worktreeEntries: entries,
  });

  if (!loaded && ticket.worktreePath !== null) {
    return <RailPanelSkeleton label="files" testId="ticket-files-loading" />;
  }

  if (ticket.worktreePath === null && nav.referenced.length === 0) {
    return (
      <div data-testid="ticket-files-no-worktree" className={cn("min-h-0 flex-1", EMPTY_PAGE)}>
        <p className="text-ui font-medium text-muted-foreground">
          {ticket.usesWorktree ? "Worktree not created" : "Project checkout in use"}
        </p>
        <p className="text-ui text-muted-foreground/70">
          {ticket.usesWorktree ? (
            <>
              Add an <code className="font-mono">@path</code> reference to the Ticket Body to list a
              file here.
            </>
          ) : (
            "This ticket has no separate worktree."
          )}
        </p>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const match = (path: string) => needle === "" || path.toLowerCase().includes(needle);
  const worktree = nav.worktree.filter((entry) => match(entry.relPath));
  const referenced = nav.referenced.filter((row) => match(row.relPath));

  function navigateUp() {
    const slash = cwd.lastIndexOf("/");
    void loadDir(slash === -1 ? "" : cwd.slice(0, slash));
  }

  return (
    <div data-testid="ticket-files-panel" className="flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-col gap-2 pt-1 pb-4", RAIL_PANEL_INSET)}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium">Ticket files</p>
            {/* The scratch's mono sub-line names the branch, which is what the
                worktree root IS. Once you walk into a folder it names the
                folder instead, and becomes the way back out — the same line
                doing the same job, one level down. */}
            {cwd === "" ? (
              <p className="truncate font-mono text-ui text-muted-foreground">
                {ticket.branch ?? ticket.baseBranch ?? "No branch yet"}
              </p>
            ) : (
              <button
                type="button"
                data-testid="ticket-files-up"
                onClick={navigateUp}
                aria-label={`Leave ${cwd}`}
                className="flex min-w-0 items-center gap-1 font-mono text-ui text-muted-foreground hover:text-foreground"
              >
                <ArrowUUpLeftIcon className="size-3 shrink-0" />
                <span className="truncate">{cwd}</span>
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Filter files"
                aria-pressed={filtering}
                onClick={() =>
                  setFiltering((open) => {
                    if (open) setQuery("");
                    return !open;
                  })
                }
              >
                <MagnifyingGlassIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Filter files</TooltipContent>
          </Tooltip>
        </div>
        {filtering ? (
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter files"
            placeholder="Filter files…"
            className="h-7 text-ui"
          />
        ) : null}
      </header>
      {/* A listing can fail for ONE folder (permissions, a directory the agent
          deleted mid-browse) while the rest of the tree is fine, so the fault
          shows ABOVE the navigator rather than instead of it — the last good
          listing stays on screen, and the header's Up control stays reachable.
          Same banner the two watches use: one fault, one shape. */}
      {error !== null ? (
        <RailFaultBanner
          testId="ticket-files-error"
          label="Folder unreadable"
          error={error}
          onRetry={() => void loadDir(cwd)}
        />
      ) : null}
      <TicketFilesList
        referenced={referenced}
        worktree={worktree}
        onPreviewFile={onPreviewFile}
        onPinFile={onPinFile}
        onOpenDirectory={(relPath) => void loadDir(relPath)}
      />
    </div>
  );
}

/**
 * Files navigator — the Calm Stack's files page
 * (the retired ticket-right-sidebar lab scratch's `FilesPanel`).
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
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { errorMessage, type DirEntry, type Ticket, type NamedBlobLink } from "@volli/shared";
import { AttachmentStrip } from "@renderer/components/attachments/attachment-strip";
import { ComposerAttachButton } from "@renderer/components/attachments/composer-attach-button";
import { fileAttachHandlers } from "@renderer/components/attachments/file-drop";
import { type AttachmentsHandle, useAttachments } from "@renderer/hooks/use-attachments";

import {
  RailFaultBanner,
  RailNavigatorHeader,
  RailPanelSkeleton,
  RailRowActions,
  railNavigatorMatch,
} from "@renderer/components/ticket/rail-panel-parts";
import {
  buildTicketFilesNavigator,
  splitFilesPath,
  type TicketFileRefRow,
  type TicketWorktreeEntry,
} from "@renderer/components/ticket/ticket-files-model";
import { EMPTY_INLINE, EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { ListRow } from "@renderer/components/ui/list-row";
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

/**
 * Ticket Files panel: body refs + attachments + worktree directory listing.
 * Single-click previews; double-click pins (decision #56).
 *
 * Attachments load from the Ticket itself (VC-50). The prop survives for the
 * fixture gallery and the tests, which mount this panel without an IPC bridge —
 * when it is passed, it wins and nothing is fetched.
 *
 * `handle` is the third case (VC-106): the Ticket detail view owns the strip so
 * that a file dropped on the BODY and a file dropped on this rail land in one
 * list. It differs from `attachments` in kind, not degree — that prop is a
 * read-only view someone else renders, this one is the live state itself, so
 * Attach and Remove stay live under it.
 */
export function TicketFilesPanel({
  ticket,
  attachments: providedAttachments,
  handle,
  onPreviewFile,
  onPinFile,
}: {
  ticket: Ticket;
  attachments?: readonly NamedBlobLink[];
  handle?: AttachmentsHandle;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
}) {
  // A repository file attached here resolves to an `@` reference, and the body
  // is where such a reference belongs — the HOST now writes it there (VC-106):
  // the detail view passes `refRoot` and an `onRefInsert` that splices into the
  // Body editor (or appends through the store when the Body tab is closed),
  // exactly as the New-ticket composer's paperclip does.
  //
  // Hooks cannot be conditional, so the panel always has a strip of its own and
  // simply defers to the host's when there is one. The unused instance holds no
  // links and issues no IPC, so it costs a state cell and nothing else.
  const own = useAttachments({
    owner: { ticketId: ticket.id },
    onError: (message) => toastError(message),
  });
  const {
    attachments: loadedAttachments,
    attachFiles,
    remove: removeAttachment,
    reset: resetAttachments,
  } = handle ?? own;
  // A boolean, not `handle` itself: the hook returns a fresh object every
  // render, so depending on it would re-run this effect on every render.
  const hostOwnsStrip = handle !== undefined;
  React.useEffect(() => {
    let cancelled = false;
    // A host that owns the strip has already loaded it; fetching again here
    // would race its own load and could overwrite a just-dropped file.
    if (providedAttachments !== undefined || hostOwnsStrip) return;
    void window.api.attachments.list({ ticketId: ticket.id }).then((result) => {
      if (!cancelled && result.ok) resetAttachments(result.blobs);
    });
    return () => {
      cancelled = true;
    };
  }, [providedAttachments, hostOwnsStrip, resetAttachments, ticket.id]);

  const attachments: readonly NamedBlobLink[] =
    providedAttachments ??
    loadedAttachments.map((entry) => ({
      linkId: entry.linkId ?? entry.blobHash,
      blobHash: entry.blobHash,
      label: entry.label,
      originalName: entry.originalName,
    }));
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
        <p className="text-ui font-medium text-muted-foreground">No worktree yet</p>
        <p className="text-ui text-muted-foreground/70">
          Reference files in the Ticket Body with @path
        </p>
      </div>
    );
  }

  const worktree = nav.worktree.filter((entry) => railNavigatorMatch(query, entry.relPath));
  const referenced = nav.referenced.filter((row) => railNavigatorMatch(query, row.relPath));

  function navigateUp() {
    const slash = cwd.lastIndexOf("/");
    void loadDir(slash === -1 ? "" : cwd.slice(0, slash));
  }

  return (
    <div
      data-testid="ticket-files-panel"
      // The rail is a drop target in its own right: this is the Ticket's file
      // surface, so a file dragged onto the list attaches rather than bouncing.
      {...fileAttachHandlers((picked) => void attachFiles(picked))}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* The scratch's mono sub-line names the branch, which is what the
          worktree root IS. Once you walk into a folder the shared header names
          the folder instead, and it becomes the way back out. */}
      <RailNavigatorHeader
        title="Ticket files"
        root={ticket.branch ?? ticket.baseBranch ?? "No branch yet"}
        cwd={cwd}
        upTestId="ticket-files-up"
        filtering={filtering}
        query={query}
        onToggleFilter={() =>
          setFiltering((open) => {
            if (open) setQuery("");
            return !open;
          })
        }
        onQueryChange={setQuery}
        onNavigateUp={navigateUp}
        // Attach lives beside Filter rather than in the list: it acts on the
        // Ticket, not on whatever row is under the cursor. Hidden when a host
        // supplied the attachments, because then this panel is a view of
        // someone else's list and must not mutate it.
        actions={
          providedAttachments === undefined ? (
            <ComposerAttachButton onFiles={(picked) => void attachFiles(picked)} />
          ) : null
        }
      >
        <AttachmentStrip
          attachments={loadedAttachments}
          {...(providedAttachments === undefined
            ? { onRemove: (attachment) => void removeAttachment(attachment) }
            : {})}
        />
      </RailNavigatorHeader>
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

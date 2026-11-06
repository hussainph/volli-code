import { PanelEmptyState } from "@renderer/components/ui/empty-state";
/**
 * Ticket Files mounts the shared virtual tree over its scoped host index.
 * Body references join that hierarchy; attachments remain in the paperclip.
 * Only a user gesture opens a preview/pinned tab, never a filesystem event.
 * TicketFilesList remains a compatibility drawing for existing list consumers.
 */
import * as React from "react";
import {
  type IconComponent,
  ChevronDownIcon,
  CodeFileIcon,
  AddFileIcon,
  FilesIcon,
  FolderIcon,
  AddFolderIcon,
  EditIcon,
  LabelIcon,
  DeleteIcon,
} from "@renderer/components/ui/icon";

import type { Ticket, NamedBlobLink } from "@volli/shared";
import { AttachmentMenu } from "@renderer/components/files/attachment-menu";
import { FileTreeNavigator } from "@renderer/components/files/file-tree-navigator";
import { CopyPathContextMenuItems } from "@renderer/components/files/copy-path-menu";
import { ExternalAppContextMenu } from "@renderer/components/files/external-app-menu";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import type { SplitDragPayload } from "@renderer/components/split/split-drop";
import type { FileNavigatorControls } from "@renderer/components/files/use-navigator-mutations";
import type { NavigatorEntryKind } from "@renderer/components/files/navigator-mutations";
import { fileAttachHandlers } from "@renderer/components/attachments/file-drop";
import { type AttachmentsHandle, useAttachments } from "@renderer/hooks/use-attachments";

import { RailRowActions } from "@renderer/components/ticket/rail-panel-parts";
import { navigatorScopeKey } from "@renderer/components/files/navigator-scope-state";
import {
  buildTicketFilesNavigator,
  splitFilesPath,
  type TicketFileRefRow,
  type TicketWorktreeEntry,
} from "@renderer/components/ticket/ticket-files-model";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { ListRow } from "@renderer/components/ui/list-row";
import { toastError } from "@renderer/lib/toast";

/**
 * The three kinds a row can be, and the glyph each wears — outline, the
 * baseline, on every row (CLAUDE.md: a scannable list is outline throughout
 * except for its own exceptions, and `fill` is never emphasis). Nothing here is
 * an exception among its neighbours: the three glyphs are already three
 * different DRAWINGS — a folder, a page with code marks, a tag — so filling all
 * of them separates nothing and only makes the column heavier to read down.
 */
const ROW_ICONS: Record<"file" | "directory" | "reference", IconComponent> = {
  directory: FolderIcon,
  reference: LabelIcon,
  file: CodeFileIcon,
};

/**
 * The five items VC-191 adds to a navigator row's menu.
 *
 * REFERENCE ROWS DO NOT GET THEM, and that is a fact about what a reference is
 * rather than a simplification: the row names a path the Ticket Body points at,
 * which may not exist at all (a Dangling Reference), and "Rename…" on something
 * that is not there is an action with no object. The two create items ride on
 * every listing row instead of only on the header, because a right-click in the
 * folder you are looking at is where the gesture starts.
 */
function FileMutationMenuItems({
  relPath,
  kind,
  controls,
}: {
  relPath: string;
  kind: NavigatorEntryKind;
  controls: FileNavigatorControls;
}) {
  return (
    <>
      <ContextMenuItem
        icon={AddFileIcon}
        disabled={!controls.canWrite}
        onSelect={() => controls.startDraft("file")}
      >
        New file…
      </ContextMenuItem>
      <ContextMenuItem
        icon={AddFolderIcon}
        disabled={!controls.canWrite}
        onSelect={() => controls.startDraft("directory")}
      >
        New folder…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={EditIcon}
        disabled={!controls.canWrite}
        onSelect={() => controls.startRename(relPath)}
      >
        Rename…
      </ContextMenuItem>
      {/* Files only: main refuses a directory duplicate out loud, and an item
          that can only fail is worse than one that is not offered. */}
      {kind === "file" ? (
        <ContextMenuItem
          icon={FilesIcon}
          disabled={!controls.canWrite}
          onSelect={() => controls.duplicate(relPath)}
        >
          Duplicate
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        icon={DeleteIcon}
        variant="destructive"
        disabled={!controls.canWrite}
        onSelect={() => controls.remove(relPath, kind)}
      >
        Delete
      </ContextMenuItem>
    </>
  );
}

/**
 * What a navigator row would open on a pane, or `null` for a row that is not a
 * file. The SCOPE is read off the panel's own props: this list is the ticket's
 * worktree when it has a ticket and the Main checkout when it does not
 * (`home-files-panel.tsx` renders the same list without one), which is exactly
 * the distinction a drop needs to resolve the path against.
 */
function fileRowDragPayload(
  projectId: string,
  ticketId: string | undefined,
  relPath: string,
  kind: "file" | "directory" | "reference",
): SplitDragPayload | null {
  if (kind === "directory") return null;
  return ticketId === undefined
    ? { type: "file", scope: "project", projectId, ticketId: null, relPath }
    : { type: "file", scope: "ticket", projectId, ticketId, relPath };
}

function FileRow({
  projectId,
  ticketId,
  relPath,
  label,
  kind,
  controls,
  onActivate,
  onPin,
}: {
  projectId: string;
  ticketId?: string;
  relPath: string;
  label: string;
  kind: "file" | "directory" | "reference";
  /** Absent where the surface has no write authority. */
  controls?: FileNavigatorControls;
  onActivate(): void;
  /** Double-click pin — omitted for directories (they only navigate). */
  onPin?(): void;
}) {
  const { filename, parentPath } = splitFilesPath(relPath);
  const primary = kind === "reference" ? label : filename;
  const Icon = ROW_ICONS[kind];
  const mutable = controls !== undefined && kind !== "reference";
  const renaming = mutable && controls.edit.kind === "rename" && controls.edit.relPath === relPath;
  const row = (
    <ListRow
      // 36px, ONE line (VC-406). The second line every row used to
      // carry was its parent path, and in a flat CURRENT-FOLDER listing that is
      // the folder the header already names — twenty rows repeating "src/"
      // under twenty filenames, for sixteen extra pixels each. A referenced row
      // is the exception that proves it: its path is NOT the current folder, so
      // it keeps its location beside the name where it still says something.
      density="row"
      data-testid="ticket-files-row"
      data-path={relPath}
      data-kind={kind}
      title={kind === "reference" ? `Referenced · ${relPath}` : relPath}
      // While the field is open the row is inert, for `ticket-sessions-panel`'s
      // reason: an input inside the activating button would both nest an
      // interactive control and preview the file on every click into the field.
      onActivate={renaming ? null : onActivate}
      onDoubleClick={renaming ? undefined : onPin}
      // Draggable onto a pane (VC-202 §4), which opens the same preview a click
      // does — just somewhere the person chose. A DIRECTORY is not a surface,
      // and a row being renamed is not a target: the pointer is in its field.
      {...splitDragSourceProps(
        renaming ? null : fileRowDragPayload(projectId, ticketId, relPath, kind),
      )}
      leading={<Icon className="size-4 shrink-0 text-muted-foreground" />}
      primary={
        renaming ? (
          <InlineRename
            value={filename}
            ariaLabel={`Rename ${filename}`}
            className="min-w-0 flex-1 font-mono"
            onCommit={(next) => controls.commitRename(relPath, next)}
            onCancel={controls.cancelEdit}
          />
        ) : (
          `${primary}${kind === "directory" ? "/" : ""}`
        )
      }
      // A reference says where it lives on the name's own line — it is the one
      // row whose path is not the folder on screen.
      primaryTrailing={
        kind === "reference" && parentPath !== "" ? (
          <span className="min-w-0 shrink truncate font-mono text-label text-muted-foreground/70">
            {parentPath}
          </span>
        ) : undefined
      }
      // The chevron is information (this row goes somewhere) and rides inside
      // the target; the copy/open pair are their own click targets and cannot.
      trailing={
        kind === "directory" ? (
          <ChevronDownIcon className="-rotate-90 shrink-0 text-muted-foreground" />
        ) : undefined
      }
      actions={
        kind === "directory" || renaming ? undefined : (
          <RailRowActions path={relPath} onOpen={() => onPin?.()} />
        )
      }
    />
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ExternalAppContextMenu target={{ kind: "file", projectId, ticketId, relPath }} />
        <ContextMenuSeparator />
        {/* The row's hover Copy button already writes the relative path; these
            two are the keyboard-and-right-click route to both spellings, and
            the only route to the absolute one. */}
        <CopyPathContextMenuItems target={{ projectId, ticketId, relPath }} />
        {mutable ? (
          <>
            <ContextMenuSeparator />
            <FileMutationMenuItems
              relPath={relPath}
              kind={kind === "directory" ? "directory" : "file"}
              controls={controls}
            />
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The unnamed row a New File… / New Folder… gesture puts at the top of the
 * listing — the same field a rename opens, in a row that has no file behind it
 * yet.
 *
 * A row rather than a dialog because this is where the answer belongs: the name
 * is relative to the folder on screen, and a modal would take that folder away
 * to ask about it. Empty commits nothing ({@link InlineRename} cancels on an
 * empty field), so Escape and "never mind" are the same gesture.
 */
function DraftRow({
  entry,
  controls,
}: {
  entry: NavigatorEntryKind;
  controls: FileNavigatorControls;
}) {
  const Icon = entry === "directory" ? AddFolderIcon : AddFileIcon;
  return (
    <ListRow
      // The rows around it are one line, so this one is too: a draft that stood
      // 16px taller than the list it is joining reads as a different object.
      // The glyph and the field's own label say which kind is being made.
      density="row"
      data-testid="ticket-files-draft-row"
      data-kind={entry}
      onActivate={null}
      leading={<Icon className="size-4 shrink-0 text-muted-foreground" />}
      primary={
        <InlineRename
          value=""
          ariaLabel={entry === "directory" ? "New folder name" : "New file name"}
          className="min-w-0 flex-1 font-mono"
          onCommit={controls.commitDraft}
          onCancel={controls.cancelEdit}
        />
      }
    />
  );
}

/** Presentational Files list — unit-tested via renderToStaticMarkup. */
export function TicketFilesList({
  projectId,
  ticketId,
  referenced,
  worktree,
  controls,
  canClaimEmpty = true,
  emptyLabel = "No files",
  onPreviewFile,
  onPinFile,
  onOpenDirectory,
}: {
  projectId: string;
  ticketId?: string;
  referenced: readonly TicketFileRefRow[];
  worktree: readonly TicketWorktreeEntry[];
  /**
   * Whether a read has LANDED (`rail-read-feedback.ts`). "Nothing here yet" is
   * a claim about what a read returned, so a list with no completed read draws
   * no rows and no sentence — its panel is already saying why.
   */
  canClaimEmpty?: boolean;
  /** What an empty-but-read listing says — a filter that matched nothing differs. */
  emptyLabel?: string;
  /**
   * The create/rename/duplicate/delete controller (VC-191). A navigator
   * without a controller is read-only.
   */
  controls?: FileNavigatorControls;
  /** Single-click: open in the replaceable File preview slot (decision #56). */
  onPreviewFile(relPath: string): void;
  /** Double-click: make the File tab persistent (decision #56). */
  onPinFile(relPath: string): void;
  onOpenDirectory(relPath: string): void;
}) {
  const draft = controls?.edit.kind === "draft" ? controls.edit.entry : null;

  // An empty folder is exactly where New File… gets used, so the draft row wins
  // over the empty hint rather than being hidden behind it.
  if (draft === null && referenced.length === 0 && worktree.length === 0) {
    if (!canClaimEmpty) return null;
    return (
      <div data-testid="ticket-files-empty">
        <PanelEmptyState
          illustration="file"
          title={emptyLabel}
          action={
            controls
              ? {
                  label: "New file",
                  onAction: () => controls.startDraft("file"),
                  disabled: !controls.canWrite,
                }
              : undefined
          }
        />
      </div>
    );
  }

  return (
    <ul
      data-testid="ticket-files-list"
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-8 [scroll-padding-bottom:2rem]"
    >
      {draft !== null && controls !== undefined ? (
        <li>
          <DraftRow entry={draft} controls={controls} />
        </li>
      ) : null}
      {worktree.map((entry) => (
        <li key={`wt:${entry.relPath}`}>
          <FileRow
            projectId={projectId}
            ticketId={ticketId}
            relPath={entry.relPath}
            label={splitFilesPath(entry.relPath).filename}
            kind={entry.kind}
            controls={controls}
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
            projectId={projectId}
            ticketId={ticketId}
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
 * Ticket Files panel: body refs + the attachments menu + worktree directory
 * listing. Single-click previews; double-click pins (decision #56).
 *
 * Attachments load from the Ticket itself (VC-50) and are read through the
 * header's paperclip menu (`files/attachment-menu.tsx`), not from a strip that
 * is always on screen. The prop survives for the fixture gallery and the tests,
 * which mount this panel without an IPC bridge — when it is passed, it wins,
 * nothing is fetched, and the menu is READ-ONLY, because the list belongs to
 * whoever supplied it.
 *
 * `handle` is the third case (VC-106): the Ticket detail view owns the live list
 * so that a file dropped on the BODY and a file dropped on this rail land in
 * one place. It differs from `attachments` in kind, not degree — that prop is a
 * read-only view someone else renders, this one is the live state itself, so
 * Attach and Remove stay live under it.
 */
export interface TicketFilesPanelProps {
  ticket: Ticket;
  attachments?: readonly NamedBlobLink[];
  handle?: AttachmentsHandle;
  onPreviewFile(relPath: string): void;
  onPinFile(relPath: string): void;
  /** A file this navigator just created: opened PINNED and focused (VC-191). */
  onOpenCreatedFile(relPath: string): void;
  /** A file this navigator just renamed: the host moves any open tab across. */
  onRenameFile(from: string, to: string): void;
}

export function TicketFilesPanel(props: TicketFilesPanelProps) {
  // THE SCOPE IS THE IDENTITY, and it is spent as a `key` so the swap is
  // SYNCHRONOUS. This panel is mounted once and handed a different ticket, so
  // an effect that cleared the listing ran after the frame that had already
  // drawn the previous worktree's rows, its read state and its attachments
  // under the new ticket's branch. A new key is a new component instance: fresh
  // state in the same commit, and the old instance's teardown — the read's
  // request counter — runs there too, so a listing still in flight can never
  // land on the ticket that replaced it.
  return (
    <TicketFilesScope
      key={navigatorScopeKey("files", {
        projectId: props.ticket.projectId,
        ticketId: props.ticket.id,
      })}
      {...props}
    />
  );
}

function TicketFilesScope({
  ticket,
  attachments: providedAttachments,
  handle,
  onPreviewFile,
  onPinFile,
  onOpenCreatedFile,
  onRenameFile,
}: TicketFilesPanelProps) {
  // A repository file attached here resolves to an `@` reference, and the body
  // is where such a reference belongs — the HOST now writes it there (VC-106):
  // the detail view passes `refRoot` and an `onRefInsert` that splices into the
  // Body editor (or appends through the store when the Body tab is closed),
  // exactly as the New-ticket composer's paperclip does.
  //
  // Hooks cannot be conditional, so the panel always has a list of its own and
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
  // The paperclip, and what it may do. A host that SUPPLIED the list owns it:
  // this panel is then a view of someone else's attachments and may neither add
  // to them nor remove from them — and with nothing supplied there is no menu
  // at all, because a control that can neither list nor add has no object. With
  // no `attachments` prop the live list is ours (our own hook, or the host's
  // `handle`), so both verbs are offered whatever the listing below is doing.
  const attachmentMenu =
    providedAttachments === undefined ? (
      <AttachmentMenu
        attachments={loadedAttachments}
        onAttachFiles={(picked) => void attachFiles(picked)}
        onRemove={(attachment) => void removeAttachment(attachment)}
      />
    ) : providedAttachments.length === 0 ? undefined : (
      <AttachmentMenu attachments={providedAttachments} />
    );

  const nav = buildTicketFilesNavigator({ body: ticket.body, attachments, worktreeEntries: [] });
  return (
    <div
      data-testid="ticket-files-panel"
      className="flex min-h-0 flex-1 flex-col"
      {...fileAttachHandlers(
        providedAttachments === undefined ? (picked) => void attachFiles(picked) : undefined,
      )}
    >
      <FileTreeNavigator
        projectId={ticket.projectId}
        ticketId={ticket.id}
        root={ticket.branch ?? ticket.baseBranch ?? "No branch yet"}
        available={ticket.worktreePath !== null}
        attachmentMenu={attachmentMenu}
        referenced={nav.referenced.map((row) => ({ path: row.relPath, referenced: true }))}
        onOpen={onPreviewFile}
        onPin={onPinFile}
        onRename={onRenameFile}
        onCreated={onOpenCreatedFile}
      />
    </div>
  );
}

import * as React from "react";
import {
  ChevronDownIcon as CaretDown,
  ChevronRightIcon as CaretRight,
  CodeFileIcon as FileCode,
  DocumentIcon as FileText,
  FolderIcon as Folder,
  FolderOpenIcon as FolderOpen,
  AttachmentIcon as Paperclip,
  PinIcon as PushPin,
  AddFileIcon as FilePlus,
  AddFolderIcon as FolderPlus,
  EditIcon as PencilSimple,
  FilesIcon as Files,
  DeleteIcon as Trash,
} from "@renderer/components/ui/icon";

import {
  buildTree,
  flattenTree,
  fuzzyIndices,
  type FileEntry,
  type TreeRow,
} from "./file-tree-model";
import type { FileNavigatorControls } from "./use-navigator-mutations";
import { CopyPathContextMenuItems } from "./copy-path-menu";
import { ExternalAppContextMenu } from "./external-app-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@renderer/components/ui/context-menu";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { SOURCE_LIST_ROW } from "@renderer/components/ui/list-row";
import { NextActionIllustration } from "@renderer/components/ui/next-action-illustration";
import { splitDragSourceProps } from "@renderer/components/split/split-drag-source";
import { cn } from "@renderer/lib/utils";

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const rowKey = (row: TreeRow) => JSON.stringify([row.node.path, row.match?.line ?? null]);

function PathLabel({ label, query }: { label: string; query: string }) {
  const hits = new Set(fuzzyIndices(label, query) ?? []);
  return (
    <>
      {[...label].map((letter, index) =>
        hits.has(index) ? (
          <mark
            key={label.slice(0, index + 1)}
            className="rounded-keycap bg-(--accent-selected) text-primary-text"
          >
            {letter}
          </mark>
        ) : (
          <React.Fragment key={label.slice(0, index + 1)}>{letter}</React.Fragment>
        ),
      )}
    </>
  );
}

/** Path identity, one tab stop and overscanned rows, shared by both sidebars.
 * Filtering opens matching ancestry without changing the saved folder folds.
 */
export function FileTree({
  entries,
  projectId,
  ticketId,
  query = "",
  initialFolder = "",
  selected,
  controls,
  onOpen,
  onPin,
  onFolder,
  onExpandedChange,
  searchMatches,
  scrollingHeading,
}: {
  entries: readonly FileEntry[];
  scrollingHeading?: React.ReactNode;
  projectId: string;
  ticketId?: string;
  query?: string;
  initialFolder?: string;
  selected?: string | null;
  controls?: FileNavigatorControls;
  onOpen(path: string): void;
  onPin(path: string): void;
  onFolder?(path: string): void;
  onExpandedChange?(paths: readonly string[]): void;
  /** Content results keep the navigator's ancestry and one keyboard cursor. */
  searchMatches?: {
    render(match: { line: number; text: string }, path: string): React.ReactNode;
    onOpen(path: string, line: number): void;
  };
}) {
  const [expanded, setExpanded] = React.useState(
    () =>
      new Set(
        initialFolder.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ),
  );
  const [focus, setFocus] = React.useState<string | null>(null);
  const [scroll, setScroll] = React.useState(0);
  const headingHeight = scrollingHeading ? 32 : 0;
  const [height, setHeight] = React.useState(400);
  const scroller = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const rowId = (path: string) => `${id}-${encodeURIComponent(path)}`;
  const tree = React.useMemo(() => buildTree(entries), [entries]);
  const rows = React.useMemo(
    () => flattenTree(tree, expanded, query, false, "", Boolean(searchMatches)),
    [tree, expanded, query, searchMatches],
  );
  const focused = rows.some((row) => rowKey(row) === focus) ? focus : rows[0] && rowKey(rows[0]);
  const focusedIndex = rows.findIndex((row) => rowKey(row) === focused);
  const first = Math.max(0, Math.floor((scroll - headingHeight) / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_HEIGHT) + OVERSCAN);
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
  if (focusedIndex >= 0 && (focusedIndex < first || focusedIndex >= last))
    indices.push(focusedIndex);

  React.useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScroll(0);
  }, [query]);
  // Watch only the directories represented on the page (including auto-open
  // filter ancestry), never every indexed file.
  const openPaths = indices
    .map((index) => rows[index]!)
    .flatMap((row) => (row.expanded ? [row.node.path] : row.parent ? [row.parent] : []));
  const openPathsKey = JSON.stringify(openPaths);
  React.useEffect(
    () => onExpandedChange?.(JSON.parse(openPathsKey) as string[]),
    [openPathsKey, onExpandedChange],
  );
  function toggle(path: string) {
    setExpanded((before) => {
      const next = new Set(before);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    onFolder?.(expanded.has(path) ? path.split("/").slice(0, -1).join("/") : path);
  }
  function focusRow(index: number) {
    const bounded = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[bounded];
    const element = scroller.current;
    if (!row || !element) return;
    setFocus(rowKey(row));
    const top = headingHeight + bounded * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  }
  function keyDown(event: React.KeyboardEvent) {
    if (event.target !== event.currentTarget) return;
    const row = rows[focusedIndex];
    if (!row) return;
    if (
      ["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight", "Enter", " "].includes(
        event.key,
      )
    )
      event.preventDefault();
    if (event.key === "ArrowDown") focusRow(focusedIndex + 1);
    if (event.key === "ArrowUp") focusRow(focusedIndex - 1);
    if (event.key === "Home") focusRow(0);
    if (event.key === "End") focusRow(rows.length - 1);
    if (event.key === "ArrowRight" && !row.node.file) {
      if (row.expanded) {
        if (row.node.children.length > 0) focusRow(focusedIndex + 1);
      } else toggle(row.node.path);
    }
    if (
      event.key === "ArrowRight" &&
      row.node.file &&
      !row.match &&
      searchMatches &&
      row.node.file.matches?.length
    ) {
      focusRow(focusedIndex + 1);
    }
    if (event.key === "ArrowLeft") {
      if (row.expanded && !query) toggle(row.node.path);
      else if (row.parent) focusRow(rows.findIndex((item) => item.node.path === row.parent));
    }
    if (event.key === "Enter" || event.key === " ") {
      if (row.match) searchMatches?.onOpen(row.node.path, row.match.line);
      else if (!row.node.file) toggle(row.node.path);
      else {
        onFolder?.(row.node.path.split("/").slice(0, -1).join("/"));
        if (event.metaKey || event.ctrlKey) onPin(row.node.path);
        else onOpen(row.node.path);
      }
    }
    if (event.key === "F2" && controls) {
      event.preventDefault();
      controls?.startRename(row.node.path);
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const item = document.getElementById(rowId(rowKey(row)));
      const box = item?.getBoundingClientRect();
      item?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: box?.left, clientY: box?.bottom }),
      );
    }
  }
  return (
    <>
      {controls?.edit.kind === "draft" && (
        <div className="flex shrink-0 items-center gap-2 px-4 py-1">
          <FilePlus aria-hidden className="size-4 text-muted-foreground" />
          <InlineRename
            value=""
            ariaLabel={controls.edit.entry === "file" ? "New file name" : "New folder name"}
            onCommit={controls.commitDraft}
            onCancel={controls.cancelEdit}
          />
        </div>
      )}
      <div
        ref={scroller}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        aria-activedescendant={focused ? rowId(focused) : undefined}
        className="group/tree relative min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={keyDown}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        {scrollingHeading ? <div className="h-8">{scrollingHeading}</div> : null}
        <div className="relative mx-2" style={{ height: rows.length * ROW_HEIGHT }}>
          {indices.map((index) => {
            const row = rows[index]!;
            const { node, depth } = row;
            const path = node.path;
            const key = rowKey(row);
            const file = node.file;
            const renaming = controls?.edit.kind === "rename" && controls.edit.relPath === path;
            const Icon = file
              ? /\.(tsx?|jsx?|json|css)$/.test(path)
                ? FileCode
                : FileText
              : row.expanded
                ? FolderOpen
                : Folder;
            const target = { projectId, ticketId, relPath: path };
            // The paperclip is drawn for sighted eyes only; the name and the
            // hover text say what it means, as the flat list's row once did.
            const referenced = !row.match && file?.referenced === true;
            return (
              <ContextMenu key={key}>
                <ContextMenuTrigger asChild>
                  <div
                    id={rowId(key)}
                    role="treeitem"
                    aria-label={
                      row.match
                        ? `${path}, line ${row.match.line}: ${row.match.text}`
                        : referenced
                          ? `${path}, referenced`
                          : path
                    }
                    aria-level={depth + 1}
                    aria-posinset={row.position}
                    aria-setsize={row.siblings}
                    aria-expanded={
                      !file ? row.expanded : searchMatches && !row.match ? true : undefined
                    }
                    aria-selected={selected === path}
                    data-testid={
                      searchMatches
                        ? row.match
                          ? "file-search-match"
                          : file
                            ? "file-search-file"
                            : "file-search-folder"
                        : "ticket-files-row"
                    }
                    data-line={row.match?.line}
                    data-selected={selected === path || undefined}
                    data-path={path}
                    data-kind={row.match ? "match" : file ? "file" : "directory"}
                    title={row.match ? row.match.text : referenced ? `Referenced · ${path}` : path}
                    className={cn(
                      "absolute inset-x-0 flex cursor-default select-none items-center gap-1.5 px-2 text-ui",
                      SOURCE_LIST_ROW,
                      focused === key &&
                        "group-focus-visible/tree:inset-ring-1 group-focus-visible/tree:inset-ring-ring",
                    )}
                    style={{
                      top: index * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      paddingLeft: 8 + depth * 16,
                    }}
                    onClick={() => {
                      if (renaming) return;
                      setFocus(key);
                      scroller.current?.focus();
                      if (row.match) searchMatches?.onOpen(path, row.match.line);
                      else if (file) {
                        onFolder?.(path.split("/").slice(0, -1).join("/"));
                        onOpen(path);
                      } else toggle(path);
                    }}
                    onContextMenu={() => {
                      setFocus(key);
                      onFolder?.(file ? path.split("/").slice(0, -1).join("/") : path);
                    }}
                    onDoubleClick={() => {
                      if (file && !renaming && !row.match) onPin(path);
                    }}
                    {...splitDragSourceProps(
                      file && !renaming && !row.match
                        ? ticketId
                          ? { type: "file", scope: "ticket", projectId, ticketId, relPath: path }
                          : {
                              type: "file",
                              scope: "project",
                              projectId,
                              ticketId: null,
                              relPath: path,
                            }
                        : null,
                    )}
                  >
                    {Array.from({ length: depth }, (_, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 w-px bg-border/70"
                        style={{ left: 15 + i * 16 }}
                      />
                    ))}
                    {row.match ? null : file ? (
                      <span className="w-3 shrink-0" />
                    ) : row.expanded ? (
                      <CaretDown
                        aria-hidden
                        strokeWidth={2.25}
                        className="size-3 shrink-0 text-muted-foreground"
                      />
                    ) : (
                      <CaretRight
                        aria-hidden
                        strokeWidth={2.25}
                        className="size-3 shrink-0 text-muted-foreground"
                      />
                    )}
                    {row.match ? null : (
                      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    {row.match && searchMatches ? (
                      searchMatches.render(row.match, path)
                    ) : renaming && controls ? (
                      <InlineRename
                        value={path.split("/").at(-1)!}
                        ariaLabel={`Rename ${path.split("/").at(-1)}`}
                        onCommit={(name) => controls.commitRename(path, name)}
                        onCancel={controls.cancelEdit}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate">
                        <PathLabel label={node.label} query={query} />
                      </span>
                    )}
                    {referenced && (
                      <Paperclip aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {file && searchMatches ? (
                    <ContextMenuItem
                      icon={FileText}
                      onSelect={() =>
                        row.match ? searchMatches.onOpen(path, row.match.line) : onOpen(path)
                      }
                    >
                      Open result
                    </ContextMenuItem>
                  ) : file ? (
                    <ContextMenuItem icon={PushPin} onSelect={() => onPin(path)}>
                      Open in tab
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem icon={FolderOpen} onSelect={() => toggle(path)}>
                      {row.expanded ? "Collapse folder" : "Expand folder"}
                    </ContextMenuItem>
                  )}
                  <ExternalAppContextMenu target={{ kind: "file", ...target }} />
                  <ContextMenuSeparator />
                  <CopyPathContextMenuItems target={target} />
                  {controls && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        icon={FilePlus}
                        disabled={!controls.canWrite}
                        onSelect={() => controls.startDraft("file")}
                      >
                        New file…
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={FolderPlus}
                        disabled={!controls.canWrite}
                        onSelect={() => controls.startDraft("directory")}
                      >
                        New folder…
                      </ContextMenuItem>
                      <ContextMenuItem
                        icon={PencilSimple}
                        disabled={!controls.canWrite}
                        onSelect={() => controls.startRename(path)}
                      >
                        Rename…
                      </ContextMenuItem>
                      {file && (
                        <ContextMenuItem
                          icon={Files}
                          disabled={!controls.canWrite}
                          onSelect={() => controls.duplicate(path)}
                        >
                          Duplicate
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        icon={Trash}
                        variant="destructive"
                        disabled={!controls.canWrite}
                        onSelect={() => controls.remove(path, file ? "file" : "directory")}
                      >
                        Delete
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        {rows.length === 0 &&
          (query ? (
            <p className="p-4 text-ui text-muted-foreground">No matches</p>
          ) : (
            <div className="flex flex-col gap-2 p-4 text-ui text-muted-foreground">
              <NextActionIllustration kind="files" />
              <p>No files</p>
            </div>
          ))}
      </div>
    </>
  );
}

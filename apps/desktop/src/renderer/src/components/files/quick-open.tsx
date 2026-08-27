/**
 * Quick-open (⌘P) — jump to a file by name (plan §4.4, wall W4).
 *
 * A thin surface over machinery that already existed. The index is
 * `volli:file-index`, the ranking is the `@` picker's, the preview/pin
 * transitions are the rail navigator's store actions, and the drawing is the
 * ⌘K palette's. What this file adds is the overlay and the wiring between them.
 *
 * SCOPE FOLLOWS THE SURFACE, and it is resolved at OPEN. Home searches the
 * project's Main checkout; a Ticket workspace searches that ticket's worktree —
 * see {@link quickOpenScope}, and `volli-fs.ts` for the main-process half,
 * which resolves the pair through the same seam a file READ resolves through.
 * A pick lands in the surface you invoked from, which is the same statement
 * said twice: the scope decides which index you searched and which store action
 * opens the row.
 *
 * ENTER PREVIEWS, ⌘ENTER PINS — the navigator's grammar, decided by
 * {@link quickOpenIntent} rather than here. `pinIntent` is a ref, not state,
 * because it is read once during the select that follows the very gesture that
 * set it; as state it would schedule a render nobody paints (the dialog closes
 * in the same tick) and could be read stale.
 */
import * as React from "react";
import { FileIcon } from "@phosphor-icons/react/dist/csr/File";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Command } from "cmdk";
import { errorMessage, type IndexedFile } from "@volli/shared";

import {
  quickOpenIntent,
  quickOpenRows,
  quickOpenScope,
  quickOpenSurfaceFiles,
} from "@renderer/components/files/quick-open-model";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { MENU_ROW_STATE_CMDK } from "@renderer/components/ui/menu-classes";
import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * One file row. Single line, not the palette's stacked title-over-context: a
 * file's name and its folder are one fact read left to right, and the list is
 * long enough that 52px rows would show half as many of them.
 */
const QUICK_OPEN_ROW = `flex h-7 cursor-pointer items-center gap-2 rounded-lg px-2 outline-none ${MENU_ROW_STATE_CMDK}`;

/** The row's leading glyph: bare and muted, exactly the palette's. */
const QUICK_OPEN_ROW_ICON = "size-4 shrink-0 text-muted-foreground";

/** ⌘P: fuzzy file search over the surface's own checkout. */
export function QuickOpen({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const projectId = useProjectsStore((state) => state.selectedProjectId);
  const nav = useWorkspaceStore(
    (state) =>
      (projectId === null ? undefined : state.byProject[projectId]?.nav) ??
      DEFAULT_WORKSPACE_UI.nav,
  );
  const homeActiveTab = useWorkspaceStore(
    (state) =>
      (projectId === null ? undefined : state.byProject[projectId]?.homeActiveTab) ??
      DEFAULT_WORKSPACE_UI.homeActiveTab,
  );
  const openTicketId = useWorkspaceStore((state) =>
    projectId === null ? null : (state.byProject[projectId]?.openTicketId ?? null),
  );

  const scope = React.useMemo(
    () => quickOpenScope({ projectId, nav, homeActiveTab, openTicketId }),
    [projectId, nav, homeActiveTab, openTicketId],
  );

  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState<readonly IndexedFile[]>([]);
  const [truncated, setTruncated] = React.useState(false);
  // The gesture that is about to select: ⌘Enter, or a ⌘-click. See the header
  // for why this is a ref.
  const pinIntent = React.useRef(false);

  // Fetched fresh per open, exactly as the `@` picker's index is: an overlay
  // that opens on a stale list is an overlay that cannot find the file the
  // agent wrote thirty seconds ago. A closed overlay holds no index at all.
  const scopeKind = scope?.kind ?? null;
  const scopeProjectId = scope?.projectId ?? null;
  const scopeTicketId = scope?.kind === "ticket" ? scope.ticketId : null;
  React.useEffect(() => {
    if (!open || scopeKind === null || scopeProjectId === null) {
      setIndex([]);
      setTruncated(false);
      return;
    }
    let current = true;
    const input =
      scopeTicketId === null
        ? { projectId: scopeProjectId }
        : { projectId: scopeProjectId, ticketId: scopeTicketId };
    void window.api.files
      .index(input)
      .then((result) => {
        if (!current) return;
        if (!result.ok) {
          toastError(`Couldn't load the file index: ${result.error}`);
          return;
        }
        setIndex(result.files);
        setTruncated(result.truncated);
      })
      .catch((error: unknown) => {
        if (current) toastError(`Couldn't load the file index: ${errorMessage(error)}`);
      });
    return () => {
      current = false;
    };
  }, [open, scopeKind, scopeProjectId, scopeTicketId]);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      pinIntent.current = false;
    }
  }, [open]);

  const rows = React.useMemo(() => quickOpenRows({ query, index }), [query, index]);

  const openRow = React.useCallback(
    (relPath: string) => {
      const pin = pinIntent.current;
      pinIntent.current = false;
      if (scope === null) return;
      const workspace = useWorkspaceStore.getState();
      const surface = quickOpenSurfaceFiles(
        scope,
        workspace.byProject[scope.projectId] ?? DEFAULT_WORKSPACE_UI,
      );
      const intent = quickOpenIntent({ relPath, pin, ...surface });
      if (scope.kind === "ticket") {
        if (intent === "pin") workspace.pinTicketFile(scope.projectId, scope.ticketId, relPath);
        else workspace.previewTicketFile(scope.projectId, scope.ticketId, relPath);
      } else if (intent === "pin") {
        workspace.pinHomeFile(scope.projectId, relPath);
      } else {
        workspace.previewHomeFile(scope.projectId, relPath);
      }
      // Settings is chrome over the workspace the file just landed in — the
      // same step ⌘K takes before it navigates.
      useUiStore.getState().setSettingsOpen(false);
      onOpenChange(false);
    },
    [scope, onOpenChange],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search files"
      loop
      shouldFilter={false}
      // The ⌘K palette's overlay, to the token: two surfaces summoned by two
      // chords onto the same spot are one drawing, not two that resemble
      // each other.
      overlayClassName="fixed inset-0 z-50 bg-scrim backdrop-blur-[2px]"
      contentClassName="fixed top-[18%] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-overlay outline-none"
    >
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            // Recorded, not acted on: cmdk owns Enter, and its root handler
            // runs after this one bubbles. Both Enter arms set the ref, so a
            // plain ⏎ after a ⌘-click can never inherit that click's pin.
            if (event.key === "Enter") pinIntent.current = event.metaKey;
          }}
          placeholder={
            scope?.kind === "ticket" ? "Search files in this worktree…" : "Search project files…"
          }
          disabled={scope === null}
          className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded-md border border-border bg-muted px-1 py-1 text-label text-muted-foreground">
          esc
        </kbd>
      </div>
      <Command.List
        data-testid="quick-open-list"
        className="max-h-[min(460px,60vh)] overflow-y-auto p-2 [scrollbar-gutter:stable]"
      >
        <Command.Empty className={EMPTY_INLINE}>
          {/* Three different nothings, said apart. "No matching files" over a
              window with no project selected would be true of the query and
              false about the reason; the truncation line is said only where it
              could matter — a file genuinely absent from a capped index — so a
              standing "20k limit" note is not chrome about nothing. */}
          {scope === null
            ? "Select a project to search its files."
            : truncated
              ? "No matching files — the index hit its size limit."
              : "No matching files."}
        </Command.Empty>
        {rows.map((row) => (
          <Command.Item
            key={row.relPath}
            value={row.relPath}
            onPointerDown={(event) => {
              pinIntent.current = event.metaKey;
            }}
            onSelect={openRow}
            className={QUICK_OPEN_ROW}
          >
            <FileIcon aria-hidden className={QUICK_OPEN_ROW_ICON} />
            <span className="truncate text-ui">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
              {row.detail}
            </span>
          </Command.Item>
        ))}
      </Command.List>
      <div className="flex h-9 items-center justify-end gap-4 border-t border-border px-4 text-label text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ preview</span>
        <span>⌘↵ pin</span>
      </div>
    </Command.Dialog>
  );
}

/**
 * The Project Files tab strip (CONCEPT #55/#56) — the full-width row above the
 * editor in the Files workbench. Deliberately NOT a reuse of the ticket
 * detail's strip: that one is ticket-shaped (Doc/session/file kinds, renames,
 * a "+" session button) and is being reworked separately. This one speaks the
 * editor vocabulary instead:
 *
 *  - a PREVIEW tab (unpinned, the single replaceable slot) is italic — the
 *    convention every code editor already taught the user;
 *  - double-clicking a preview tab, or "Keep Open" in its context menu, pins it;
 *  - a DIRTY tab's close button is a dot until you point at it, so unsaved work
 *    is visible from across the strip and can still be closed in one click.
 *
 * Purely presentational: labels come from the pure {@link fileTabLabels}, and
 * every gesture is reported to the workbench, which owns the store writes and
 * the dirty-close guard.
 */
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { XSquareIcon } from "@phosphor-icons/react/dist/csr/XSquare";
import type { FileWorkspaceTab } from "@volli/shared";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { cn } from "@renderer/lib/utils";

import { fileTabLabels } from "./file-tab-labels";

/**
 * Roving-tabindex arrow navigation across the strip's `role="tab"` children,
 * found live in the DOM under the enclosing `role="tablist"` (same technique as
 * the ticket strip — no ref registry to keep in sync with the tab list).
 */
function moveTabFocus(from: HTMLElement, to: "prev" | "next" | "first" | "last") {
  const tablist = from.closest('[role="tablist"]');
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.indexOf(from);
  if (i === -1) return;
  const target =
    to === "first"
      ? tabs[0]
      : to === "last"
        ? tabs[tabs.length - 1]
        : to === "next"
          ? tabs[(i + 1) % tabs.length]
          : tabs[(i - 1 + tabs.length) % tabs.length];
  target?.focus();
}

export interface FileTabStripProps {
  /** The workspace's tabs in strip order (`@volli/shared`'s FileWorkspaceState.tabs). */
  tabs: readonly FileWorkspaceTab[];
  activeRelPath: string | null;
  /** relPaths whose editor holds unsaved work — drives the dot and the close guard. */
  dirtyPaths: ReadonlySet<string>;
  onSelect(relPath: string): void;
  /** Double-click / "Keep Open": promote the preview tab to persistent. */
  onPin(relPath: string): void;
  /** Close request — the workbench decides whether a guard is needed first. */
  onClose(relPath: string): void;
  onCloseOthers(relPath: string): void;
}

function FileTab({
  relPath,
  name,
  hint,
  preview,
  dirty,
  active,
  onSelect,
  onPin,
  onClose,
  onCloseOthers,
}: {
  relPath: string;
  name: string;
  hint: string | null;
  preview: boolean;
  dirty: boolean;
  active: boolean;
  onSelect(): void;
  onPin(): void;
  onClose(): void;
  onCloseOthers(): void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          data-testid="file-tab"
          data-rel-path={relPath}
          data-preview={preview ? "true" : "false"}
          data-dirty={dirty ? "true" : "false"}
          // The label alone: without it the accessible name would absorb the
          // close button's "Close <name>" and read doubled.
          aria-label={name}
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          onClick={onSelect}
          onDoubleClick={preview ? onPin : undefined}
          onKeyDown={(event) => {
            switch (event.key) {
              case "ArrowRight":
                event.preventDefault();
                moveTabFocus(event.currentTarget, "next");
                break;
              case "ArrowLeft":
                event.preventDefault();
                moveTabFocus(event.currentTarget, "prev");
                break;
              case "Home":
                event.preventDefault();
                moveTabFocus(event.currentTarget, "first");
                break;
              case "End":
                event.preventDefault();
                moveTabFocus(event.currentTarget, "last");
                break;
              case "Enter":
              case " ":
                event.preventDefault();
                onSelect();
                break;
            }
          }}
          className={cn(
            "group relative flex h-8 shrink-0 items-center gap-1.5 rounded-t-lg pr-1 pl-3 text-sm outline-none transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            active
              ? // -mb-px lets the tab's fill cover the strip's bottom border, so
                // it reads as physically joined to the editor plane below.
                "-mb-px bg-background text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span className={cn("max-w-40 truncate font-medium", preview && "italic")}>{name}</span>
          {hint !== null ? (
            <span
              data-testid="file-tab-hint"
              className="max-w-28 shrink-0 truncate text-xs text-muted-foreground"
            >
              {hint}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="file-tab-close"
            data-rel-path={relPath}
            aria-label={`Close ${name}`}
            // Never let the close reach the tab's own select handler.
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className={cn(
              "group/close ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
              // A dirty tab's control is always present (it IS the unsaved dot);
              // a clean tab's × stays out of the way until the tab is pointed at.
              dirty
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            {dirty ? (
              <span
                data-testid="file-tab-dirty"
                title="Unsaved changes"
                aria-label="Unsaved changes"
                className="size-2 rounded-full bg-primary group-hover/close:hidden"
              />
            ) : null}
            <XIcon className={cn("size-3", dirty && "hidden group-hover/close:block")} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={PushPinIcon} disabled={!preview} onSelect={onPin}>
          Keep Open
        </ContextMenuItem>
        <ContextMenuItem icon={XIcon} onSelect={onClose}>
          Close
        </ContextMenuItem>
        <ContextMenuItem icon={XSquareIcon} onSelect={onCloseOthers}>
          Close Others
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function FileTabStrip({
  tabs,
  activeRelPath,
  dirtyPaths,
  onSelect,
  onPin,
  onClose,
  onCloseOthers,
}: FileTabStripProps) {
  // Not memoized: a strip holds a handful of tabs, and the store hands over a
  // fresh array on most updates anyway, so a memo keyed on it would never hit.
  const labels = fileTabLabels(tabs.map((tab) => tab.relPath));

  if (tabs.length === 0) return null;

  return (
    <div
      data-testid="file-tab-strip"
      className="flex shrink-0 items-end border-b border-border bg-rail pt-1.5"
    >
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-orientation="horizontal" className="flex items-end gap-0.5">
          {tabs.map((tab, index) => {
            const label = labels[index] ?? { name: tab.relPath, hint: null };
            return (
              <FileTab
                key={tab.relPath}
                relPath={tab.relPath}
                name={label.name}
                hint={label.hint}
                preview={!tab.pinned}
                dirty={dirtyPaths.has(tab.relPath)}
                active={tab.relPath === activeRelPath}
                onSelect={() => onSelect(tab.relPath)}
                onPin={() => onPin(tab.relPath)}
                onClose={() => onClose(tab.relPath)}
                onCloseOthers={() => onCloseOthers(tab.relPath)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

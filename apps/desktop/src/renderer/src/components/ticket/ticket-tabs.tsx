/**
 * The ticket detail's tab strip (ticket-detail-mvp decision #6, restyled to the
 * Chrome-browser metaphor): a full-width row at the very top of the detail view
 * — `<TicketId> | <file tabs…> | <session tabs…> | +` — spanning above both the
 * main column and the right rail. The active tab is a raised surface on the
 * content background with rounded top corners so it reads as physically
 * connected to the content below; inactive tabs are flat on the recessed rail
 * band. Data-driven by design: `TicketTabDescriptor` is the one shape a tab
 * needs, so ticket-detail.tsx appends one `"file"`-kind descriptor per open
 * `@file` ref and one `"session"`-kind descriptor per linked terminal. Content
 * routing stays with the caller, keyed off each tab's `kind`; file and session
 * tabs are closable, session tabs alone are renameable.
 */
import * as React from "react";
import { CornersOutIcon } from "@phosphor-icons/react/dist/csr/CornersOut";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { InlineRename } from "@renderer/components/sessions/inline-rename";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { cn } from "@renderer/lib/utils";

/**
 * Roving-tabindex arrow navigation across a strip's `role="tab"` children.
 * Scoped to the enclosing `role="tablist"` so both tab strips share one
 * behavior without a ref registry — the tabs are found live in the DOM.
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

export type TicketTabKind = "doc" | "session" | "file";

export interface TicketTabDescriptor {
  /** Stable tab identity — a session tab's id is its session id; a file tab's is `file:<relPath>`. */
  id: string;
  kind: TicketTabKind;
  label: string;
  /** The project-relative path a `"file"`-kind tab opens (absent for other kinds). */
  relPath?: string;
  /** A `"file"` tab whose file resolved from the ticket's worktree copy shows a subtle badge (decision #6). */
  badge?: "worktree";
  /**
   * A `"file"` tab whose editor holds unsaved work. Repository files save only
   * on ⌘S (CONCEPT #49), so the draft has to be visible from across the strip —
   * and ticket-detail.tsx guards the close on the same flag.
   */
  dirty?: boolean;
}

interface TicketTabStripProps {
  tabs: readonly TicketTabDescriptor[];
  activeTabId: string;
  /** Disables the "+" button while a session is booting. */
  creating: boolean;
  onSelectTab(tabId: string): void;
  /** Closes a session tab (kill-on-close) or a file tab. Doc has no close affordance. */
  onCloseTab(tab: TicketTabDescriptor): void;
  /** Commits a session-tab rename (double-click / context menu). Ignored for Doc/file tabs. */
  onRenameSessionTab(tabId: string, title: string): void;
  /** Boots a new session tab — the same path as the rail's New-session button. */
  onNewSession(): void;
  /** Focus mode is only meaningful when the active descriptor is a resident session tab. */
  canFocusTerminal: boolean;
  onEnterTerminalFocus(): void;
}

/**
 * A single Chrome-style tab. The active tab lifts onto the content background
 * with rounded top corners (no bottom edge, so it fuses with the content plane
 * beneath the strip); inactive tabs sit flat and muted on the recessed band
 * with a hover surface. Session tabs carry a hover-revealed close ×, double-
 * click inline rename, and a right-click Rename menu.
 */
function TicketTab({
  tab,
  active,
  editing,
  onSelect,
  onClose,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  tab: TicketTabDescriptor;
  active: boolean;
  editing: boolean;
  onSelect(): void;
  onClose(): void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
}) {
  const isSession = tab.kind === "session";
  const closable = tab.kind === "session" || tab.kind === "file";
  const dirty = tab.dirty === true;

  const inner = (
    // The tab itself is the focusable role="tab" — the direct child of the
    // tablist (valid ARIA). Roving tabindex + arrow keys move focus; click,
    // Enter, and Space activate. h-8 (not an arbitrary 34px): the tab carries
    // no borders of its own, so nothing pins it to a 32+2 alignment.
    <div
      role="tab"
      // Explicit name: without it the tab's accessible name is computed from
      // the whole subtree — label + the close button's "Close <label>" — which
      // reads doubled to AT (and breaks exact-name lookups).
      aria-label={tab.label}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={isSession ? onStartRename : undefined}
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
        "group relative flex h-8 shrink-0 items-center rounded-t-lg text-sm outline-none transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        closable ? "pr-1 pl-3" : "px-3.5",
        active
          ? // -mb-px pulls the active tab 1px past the strip's bottom border so
            // its content-colored fill covers that seam — the tab reads as
            // physically connected to the content plane below (no dividing line).
            "-mb-px bg-background text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {tab.badge === "worktree" ? (
        // A quiet dot marking a file resolved from the ticket's worktree copy
        // rather than the main checkout (decision #6).
        <span
          aria-label="Worktree copy"
          title="Worktree copy"
          className="mr-1.5 size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      {editing ? (
        <InlineRename
          value={tab.label}
          ariaLabel={`Rename ${tab.label}`}
          className="h-5 w-32 text-sm"
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        // The clickable/selectable target is the tab div (role="tab") above,
        // so the label is a plain span — no nested interactive control.
        <span className="max-w-40 truncate font-medium">{tab.label}</span>
      )}
      {closable && !editing ? (
        <button
          type="button"
          aria-label={`Close ${tab.label}`}
          // Stop the click from bubbling to the tab's own onClick (select).
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "group/close ml-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
            // Same idiom as the Project Files strip: a dirty tab's control is
            // always present because it IS the unsaved dot, and turns back into
            // an × on hover so the tab still closes in one click. A clean tab's
            // × stays out of the way until the tab is pointed at.
            dirty
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {dirty ? (
            <span
              data-testid="ticket-tab-dirty"
              title="Unsaved changes"
              aria-label="Unsaved changes"
              className="size-2 rounded-full bg-primary group-hover/close:hidden"
            />
          ) : null}
          <XIcon className={cn("size-3", dirty && "hidden group-hover/close:block")} />
        </button>
      ) : null}
    </div>
  );

  // Only session tabs rename, so Doc and file tabs skip the context menu.
  if (!isSession) return inner;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{inner}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={PencilSimpleIcon} onSelect={onStartRename}>
          Rename
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Purely presentational tab strip — content lives in the caller (ticket-detail.tsx). */
export function TicketTabStrip({
  tabs,
  activeTabId,
  creating,
  onSelectTab,
  onCloseTab,
  onRenameSessionTab,
  onNewSession,
  canFocusTerminal,
  onEnterTerminalFocus,
}: TicketTabStripProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <div className="flex shrink-0 items-end border-b border-border bg-rail pt-1.5">
      {/* Tabs and their creation affordance scroll as one cluster, keeping +
          immediately beside the last tab instead of pinning it away from its
          destination. The focus control owns a stable slot at the far right. */}
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-orientation="horizontal" className="flex items-end gap-0.5">
          {tabs.map((tab) => (
            <TicketTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              editing={editingId === tab.id}
              onSelect={() => onSelectTab(tab.id)}
              onClose={() => onCloseTab(tab)}
              onStartRename={() => setEditingId(tab.id)}
              onCommitRename={(next) => {
                setEditingId(null);
                onRenameSessionTab(tab.id, next);
              }}
              onCancelRename={() => setEditingId(null)}
            />
          ))}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={creating}
          onClick={onNewSession}
          aria-label="New session"
          className="mb-1 ml-0.5 shrink-0"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      {/* Full-height corner control: self-stretch ignores the parent's items-end
          and -mt-1.5 cancels its pt-1.5 so this column spans the strip's true
          top edge to bottom (the framed card's rounded-t-lg + overflow clips the
          outer corner). The button fills that height (h-full over size-5's height,
          width kept) with a rectangular hover (rounded-none) so it reads as a
          corner region, not a tall pill. */}
      <div className="-mt-1.5 flex shrink-0 items-stretch self-stretch border-l border-border/70 px-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          className="h-full rounded-none"
          disabled={!canFocusTerminal}
          onClick={onEnterTerminalFocus}
          aria-label="Enter terminal focus"
          aria-pressed={false}
          title={
            canFocusTerminal
              ? "Enter terminal focus"
              : "Select a terminal tab to enter terminal focus"
          }
        >
          <CornersOutIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

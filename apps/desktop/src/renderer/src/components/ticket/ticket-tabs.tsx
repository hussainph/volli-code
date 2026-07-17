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

  const inner = (
    <div
      className={cn(
        "group relative flex h-[34px] shrink-0 items-center rounded-t-lg text-sm transition-colors duration-150 ease-out",
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
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={onSelect}
          onDoubleClick={isSession ? onStartRename : undefined}
          className="max-w-40 truncate font-medium"
        >
          {tab.label}
        </button>
      )}
      {closable && !editing ? (
        <button
          type="button"
          aria-label={`Close ${tab.label}`}
          onClick={onClose}
          className="ml-1.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-border hover:text-foreground"
        >
          <XIcon className="size-3" />
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
}: TicketTabStripProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <div
      role="tablist"
      className="flex shrink-0 items-end gap-0.5 border-b border-border bg-rail px-2 pt-1.5"
    >
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
  );
}

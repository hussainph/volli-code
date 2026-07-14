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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { cn } from "@renderer/lib/utils";
import { sessionPanes, type SessionTab } from "@renderer/stores/sessions";

interface SessionTabsProps {
  tabs: SessionTab[];
  activeSessionId: string | null;
  onSelect(sessionId: string): void;
  onClose(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onNew(): void;
  creating: boolean;
}

/**
 * The terminal tab strip: small, dark, ember-orange active accent — matching
 * the chrome band the sessions surface sits under. A trailing "+" opens a new
 * session in the current workspace; each tab carries a hover-revealed close,
 * a right-click Rename/Close menu, and double-click inline rename.
 */
export function SessionTabs({
  tabs,
  activeSessionId,
  onSelect,
  onClose,
  onRename,
  onNew,
  creating,
}: SessionTabsProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-rail px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.sessionId === activeSessionId;
          const panes = sessionPanes(tab.layout);
          const exited = panes.every((pane) => pane.exitCode !== null);
          const exitCode = panes.find((pane) => pane.exitCode !== null)?.exitCode ?? null;
          const editing = editingId === tab.sessionId;
          return (
            <ContextMenu key={tab.sessionId}>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    "group flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs transition-colors",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {editing ? (
                    <InlineRename
                      value={tab.title}
                      ariaLabel={`Rename ${tab.title}`}
                      className="h-5 w-40 text-xs"
                      onCommit={(next) => {
                        setEditingId(null);
                        onRename(tab.sessionId, next);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(tab.sessionId)}
                      onDoubleClick={() => setEditingId(tab.sessionId)}
                      className="flex min-w-0 items-center gap-1.5"
                      // Active tab gets an ember dot; exited tabs read as muted.
                      title={exited ? `Exited (${exitCode})` : tab.title}
                    >
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          exited ? "bg-muted-foreground" : active ? "bg-primary" : "bg-transparent",
                        )}
                      />
                      <span className={cn("max-w-40 truncate", exited && "line-through")}>
                        {tab.title}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    onClick={() => onClose(tab.sessionId)}
                    className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-border hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  icon={PencilSimpleIcon}
                  onSelect={() => setEditingId(tab.sessionId)}
                >
                  Rename
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  icon={XIcon}
                  variant="destructive"
                  onSelect={() => onClose(tab.sessionId)}
                >
                  Close
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={onNew}
        disabled={creating}
        aria-label="New session"
        className="shrink-0"
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}

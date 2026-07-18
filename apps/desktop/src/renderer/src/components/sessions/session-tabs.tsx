import * as React from "react";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { errorMessage, type TerminalIoResult } from "@volli/shared";

import { InlineRename } from "@renderer/components/sessions/inline-rename";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";
import { sessionPanes, useSessionsStore, type SessionTab } from "@renderer/stores/sessions";

/**
 * Roving-tabindex arrow navigation across the strip's `role="tab"` children.
 * Scoped to the enclosing `role="tablist"`, mirroring the ticket tab strip so
 * both behave identically. Found live in the DOM — no ref registry needed.
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

/**
 * Runs a park/wake/pin mutation against every LIVE pane of a tab (issue #51
 * warm-park tier) and surfaces any failure — CLAUDE.md's "never silently
 * swallow errors" applies to these fire-and-forget context-menu actions the
 * same as any other mutation.
 */
function runOnLivePanes(
  tab: SessionTab,
  action: (paneId: string) => Promise<TerminalIoResult>,
  failureLabel: string,
): void {
  for (const pane of sessionPanes(tab.layout)) {
    if (pane.exitCode !== null) continue;
    action(pane.sessionId)
      .then((result) => {
        if (!result.ok) toastError(`${failureLabel} failed: ${result.error}`);
      })
      .catch((error: unknown) => {
        toastError(`${failureLabel} failed: ${errorMessage(error)}`);
      });
  }
}

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
  const parkState = useSessionsStore((state) => state.parkState);
  // Roving tabindex: the active tab is the strip's single tab-stop; when no tab
  // is active yet, the first tab holds the stop so the strip stays reachable.
  const focusableSessionId = activeSessionId ?? tabs[0]?.sessionId ?? null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-rail px-2">
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.sessionId === activeSessionId;
          const panes = sessionPanes(tab.layout);
          const exited = panes.every((pane) => pane.exitCode !== null);
          const exitCode = panes.find((pane) => pane.exitCode !== null)?.exitCode ?? null;
          const editing = editingId === tab.sessionId;
          const livePanes = panes.filter((pane) => pane.exitCode === null);
          // Fully parked: every LIVE pane is parked (vacuously true with no
          // live panes, but the badge/menu below always gate on `!exited` too,
          // so an exited tab never shows the moon badge or "Park Now").
          const parked = livePanes.every((pane) => parkState[pane.sessionId]?.parked ?? false);
          const keptAwake = livePanes.some((pane) => parkState[pane.sessionId]?.keepAwake ?? false);
          const showParkControls = livePanes.length > 0;
          // Select the tab and, if it was fully parked, wake it — the explicit
          // wake the visibility effect can't cover (see below). Shared by click
          // and keyboard (Enter/Space) so both paths behave identically.
          const activate = () => {
            onSelect(tab.sessionId);
            // Clicking/activating the ALREADY-active tab changes no visibility
            // state, so the visibility effect never re-fires — the promised
            // wake-on-click must be explicit. Idempotent for the
            // select-a-different-tab case (visibility wiring wakes it too; the
            // second wake is a no-op).
            if (parked && !exited) {
              runOnLivePanes(tab, (paneId) => window.api.terminal.wake(paneId), "Wake");
            }
          };
          return (
            <ContextMenu key={tab.sessionId}>
              <ContextMenuTrigger asChild>
                <div
                  role="tab"
                  // Explicit name — subtree naming would append the close
                  // button's label and read doubled to AT (see ticket-tabs).
                  aria-label={tab.title}
                  aria-selected={active}
                  tabIndex={tab.sessionId === focusableSessionId ? 0 : -1}
                  onClick={activate}
                  onDoubleClick={() => setEditingId(tab.sessionId)}
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
                        activate();
                        break;
                    }
                  }}
                  // Active tab gets an ember dot; exited tabs read as muted;
                  // a parked (and live) tab explains itself on hover.
                  title={
                    exited
                      ? `Exited (${exitCode})`
                      : parked
                        ? "Parked — memory reclaimed; wakes on click or keypress"
                        : tab.title
                  }
                  className={cn(
                    "group flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs outline-none transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
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
                    // Label content only — the tab div (role="tab") above owns
                    // click/keyboard activation, so no nested interactive control.
                    <span className="flex min-w-0 items-center gap-1.5">
                      {parked && !exited ? (
                        <MoonIcon
                          weight="fill"
                          className="size-2.5 shrink-0 text-muted-foreground"
                        />
                      ) : (
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            exited
                              ? "bg-muted-foreground"
                              : active
                                ? "bg-primary"
                                : "bg-transparent",
                          )}
                        />
                      )}
                      <span className={cn("max-w-40 truncate", exited && "line-through")}>
                        {tab.title}
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    // Stop the click from bubbling to the tab's onClick (select).
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(tab.sessionId);
                    }}
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
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
                {showParkControls && (
                  <>
                    <ContextMenuSeparator />
                    {!parked && (
                      <ContextMenuItem
                        icon={MoonIcon}
                        onSelect={() =>
                          runOnLivePanes(tab, (paneId) => window.api.terminal.park(paneId), "Park")
                        }
                      >
                        Park Now
                      </ContextMenuItem>
                    )}
                    {parked && (
                      <ContextMenuItem
                        icon={SunIcon}
                        onSelect={() =>
                          runOnLivePanes(tab, (paneId) => window.api.terminal.wake(paneId), "Wake")
                        }
                      >
                        Wake
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem
                      icon={keptAwake ? PushPinSlashIcon : PushPinIcon}
                      onSelect={() =>
                        runOnLivePanes(
                          tab,
                          (paneId) => window.api.terminal.setKeepAwake(paneId, !keptAwake),
                          keptAwake ? "Allow Parking" : "Keep Awake",
                        )
                      }
                    >
                      {keptAwake ? "Allow Parking" : "Keep Awake"}
                    </ContextMenuItem>
                  </>
                )}
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

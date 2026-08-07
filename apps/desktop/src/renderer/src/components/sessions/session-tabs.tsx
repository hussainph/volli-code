import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { errorMessage, type TerminalIoResult } from "@volli/shared";

import { InlineRename } from "@renderer/components/sessions/inline-rename";
import { NewSessionMenu } from "@renderer/components/sessions/new-session-menu";
import { TAB_STATUS_CLASS, type TicketTabStatus } from "@renderer/components/ticket/ticket-tabs";
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
 * What the scratch strip draws, per kind.
 *
 * A terminal tab carries its whole store record — park state, panes and exit
 * codes are all read off it — while a chat tab carries the two facts a chat has
 * on a strip: its title and its liveness. `id` is the tab's identity in the
 * merged strip and in `sessionsActiveTab`; a chat's is `chat:`-prefixed
 * (`ticket-chat-tab.ts`), so the two id spaces never collide.
 */
export type SessionTabDescriptor =
  | { kind: "terminal"; id: string; tab: SessionTab }
  | { kind: "chat"; id: string; sessionId: string; title: string; status: TicketTabStatus };

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
 * Hand focus to the tab that will survive this close — the one to the right, or
 * the left when the closed tab was last.
 *
 * Called BEFORE the close lands, from inside the × that is about to unmount:
 * the successor is picked from the strip as it stands, and focus never spends a
 * frame on `<body>`, so the next Arrow keeps moving from where the closed tab
 * was. Closing the only tab has no successor and lands on the empty state,
 * which carries its own control.
 */
function focusNeighborTab(from: HTMLElement): void {
  const tab = from.closest<HTMLElement>('[role="tab"]');
  const tablist = tab?.closest('[role="tablist"]');
  if (!tab || !tablist) return;
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const i = tabs.indexOf(tab);
  if (i === -1) return;
  (tabs[i + 1] ?? tabs[i - 1])?.focus();
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
  tabs: readonly SessionTabDescriptor[];
  activeTabId: string | null;
  onSelect(tab: SessionTabDescriptor): void;
  onClose(tab: SessionTabDescriptor): void;
  onRename(tab: SessionTabDescriptor, title: string): void;
  onNewSession(): void;
  onNewChat(): void;
  /** A Session of either kind is already booting. */
  creating: boolean;
}

/**
 * The scratch tab strip: small, dark, ember-orange active accent — matching the
 * chrome band the sessions surface sits under. It holds both kinds of Session a
 * project can run without a ticket, terminals first and chats after, each in
 * the order it was opened. A trailing "+" starts either; each tab carries a
 * hover-revealed close, a right-click menu, and double-click inline rename.
 *
 * Only the terminal kind talks about parking: the moon badge, the wake-on-click
 * and the Park/Wake/Keep Awake items are all about a PTY holding memory (issue
 * #51), and a chat Session holds none.
 */
export function SessionTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onRename,
  onNewSession,
  onNewChat,
  creating,
}: SessionTabsProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  // Roving tabindex: the active tab is the strip's single tab-stop; when no tab
  // is active yet, the first tab holds the stop so the strip stays reachable.
  const focusableTabId = activeTabId ?? tabs[0]?.id ?? null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-rail px-2">
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((descriptor) => {
          // One set of callbacks for both kinds — what differs between them is
          // what each tab DRAWS and what its menu offers, never how the strip
          // reports a selection, a close, or a rename.
          const shared = {
            active: descriptor.id === activeTabId,
            focusable: descriptor.id === focusableTabId,
            editing: editingId === descriptor.id,
            onClose: () => onClose(descriptor),
            onStartRename: () => setEditingId(descriptor.id),
            onCommitRename: (next: string) => {
              setEditingId(null);
              onRename(descriptor, next);
            },
            onCancelRename: () => setEditingId(null),
          };
          return descriptor.kind === "terminal" ? (
            <TerminalTab
              key={descriptor.id}
              {...shared}
              tab={descriptor.tab}
              onSelect={() => onSelect(descriptor)}
            />
          ) : (
            <ChatTab
              key={descriptor.id}
              {...shared}
              title={descriptor.title}
              status={descriptor.status}
              onSelect={() => onSelect(descriptor)}
            />
          );
        })}
      </div>
      <NewSessionMenu
        disabled={creating}
        // The trigger sits at the strip's right edge, so the menu hangs back
        // into the window rather than off it.
        align="end"
        className="shrink-0"
        onNewSession={onNewSession}
        onNewChat={onNewChat}
      />
    </div>
  );
}

/**
 * Extends the div's own props because this component is what each kind hands to
 * `ContextMenuTrigger asChild`: Radix's Slot merges the trigger's pointer
 * listeners, its ref and its `data-state` into this element's props, and a
 * shell that dropped them would be a tab whose right-click opens nothing.
 */
interface TabShellProps extends React.ComponentPropsWithRef<"div"> {
  label: string;
  /** Native tooltip — the one line a hover can add to what the tab already says. */
  hint: string;
  active: boolean;
  focusable: boolean;
  editing: boolean;
  /** The glyphs ahead of the label: a liveness dot, a kind mark, or both. */
  leading: React.ReactNode;
  labelClassName?: string;
  /** Not `onSelect`, which a div already owns as a DOM event. */
  onActivate(): void;
  onClose(): void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
}

/**
 * The tab itself, identical for every kind: one focusable `role="tab"` (the
 * direct child of the tablist, valid ARIA), arrow-key roving focus, click /
 * Enter / Space to select, double-click to rename, and a hover-revealed ×. What
 * a kind contributes is `leading` and the menu its caller wraps this in — so
 * two tabs of different kinds are the same size, in the same place, with the
 * same press feedback, and switching between them moves nothing.
 */
function TabShell({
  label,
  hint,
  active,
  focusable,
  editing,
  leading,
  labelClassName,
  onActivate,
  onClose,
  onStartRename,
  onCommitRename,
  onCancelRename,
  ...trigger
}: TabShellProps) {
  return (
    <div
      {...trigger}
      role="tab"
      // Explicit name — subtree naming would append the close button's label
      // and read doubled to AT (see ticket-tabs).
      aria-label={label}
      aria-selected={active}
      tabIndex={focusable ? 0 : -1}
      onClick={onActivate}
      onDoubleClick={onStartRename}
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
            onActivate();
            break;
        }
      }}
      title={hint}
      className={cn(
        "group flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs outline-none transition-[color,background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {editing ? (
        <InlineRename
          value={label}
          ariaLabel={`Rename ${label}`}
          className="h-5 w-40 text-xs"
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        // Label content only — the tab div (role="tab") above owns click/keyboard
        // activation, so no nested interactive control.
        <span className="flex min-w-0 items-center gap-1.5">
          {leading}
          <span className={cn("max-w-40 truncate", labelClassName)}>{label}</span>
        </span>
      )}
      <button
        type="button"
        aria-label={`Close ${label}`}
        // Stop the click from bubbling to the tab's onClick (select), and pass
        // the keyboard on to a tab that will still be here afterwards.
        onClick={(event) => {
          event.stopPropagation();
          focusNeighborTab(event.currentTarget);
          onClose();
        }}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

interface KindTabProps {
  active: boolean;
  focusable: boolean;
  editing: boolean;
  onSelect(): void;
  onClose(): void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
}

/** One terminal tab: a live PTY tree, with the warm-park tier's vocabulary on it. */
function TerminalTab({ tab, onSelect, ...shell }: KindTabProps & { tab: SessionTab }) {
  const parkState = useSessionsStore((state) => state.parkState);
  const panes = sessionPanes(tab.layout);
  const exited = panes.every((pane) => pane.exitCode !== null);
  const exitCode = panes.find((pane) => pane.exitCode !== null)?.exitCode ?? null;
  const livePanes = panes.filter((pane) => pane.exitCode === null);
  // Fully parked: every LIVE pane is parked (vacuously true with no live panes,
  // but the badge/menu below always gate on `!exited` too, so an exited tab
  // never shows the moon badge or "Park Now").
  const parked = livePanes.every((pane) => parkState[pane.sessionId]?.parked ?? false);
  const keptAwake = livePanes.some((pane) => parkState[pane.sessionId]?.keepAwake ?? false);
  const showParkControls = livePanes.length > 0;
  // Select the tab and, if it was fully parked, wake it — the explicit wake the
  // visibility effect can't cover (see below). Shared by click and keyboard
  // (Enter/Space) so both paths behave identically.
  const activate = () => {
    onSelect();
    // Clicking/activating the ALREADY-active tab changes no visibility state,
    // so the visibility effect never re-fires — the promised wake-on-click must
    // be explicit. Idempotent for the select-a-different-tab case (visibility
    // wiring wakes it too; the second wake is a no-op).
    if (parked && !exited) {
      runOnLivePanes(tab, (paneId) => window.api.terminal.wake(paneId), "Wake");
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TabShell
          {...shell}
          label={tab.title}
          // Active tab gets an ember dot; exited tabs read as muted; a parked
          // (and live) tab explains itself on hover.
          hint={
            exited
              ? `Exited (${exitCode})`
              : parked
                ? "Parked to save memory. Click to wake."
                : tab.title
          }
          labelClassName={exited ? "line-through" : undefined}
          leading={
            parked && !exited ? (
              <MoonIcon weight="fill" className="size-2.5 shrink-0 text-muted-foreground" />
            ) : (
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  exited ? "bg-muted-foreground" : shell.active ? "bg-primary" : "bg-transparent",
                )}
              />
            )
          }
          onActivate={activate}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={PencilSimpleIcon} onSelect={shell.onStartRename}>
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
        <ContextMenuItem icon={XIcon} variant="destructive" onSelect={shell.onClose}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One chat tab. The dot sits in the same leading slot a terminal's does, so the
 * column reads as liveness whatever the kind; the bubble beside it is the only
 * thing that says this row is not a terminal — the exception is marked, the
 * default is not.
 *
 * No park, no split: a chat Session's stream, fold and queue live in the
 * resident client, which outlives every view, so there is nothing here to hold
 * open or to hand memory back from.
 */
function ChatTab({
  title,
  status,
  onSelect,
  ...shell
}: KindTabProps & { title: string; status: TicketTabStatus }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TabShell
          {...shell}
          label={title}
          hint={title}
          onActivate={onSelect}
          leading={
            <>
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", TAB_STATUS_CLASS[status])}
              />
              <ChatCircleIcon weight="fill" className="size-3 shrink-0 text-muted-foreground" />
            </>
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={PencilSimpleIcon} onSelect={shell.onStartRename}>
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={XIcon} variant="destructive" onSelect={shell.onClose}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The ticket detail's tab strip (ticket-detail-mvp decision #6, restyled to the
 * Chrome-browser metaphor): a full-width row at the very top of the detail view
 * — `<TicketId> | <file tabs…> | <session tabs…> | [ + Chat ▾ ]` — spanning above both the
 * main column and the right rail. The active tab is a raised surface on the
 * content background with rounded top corners so it reads as physically
 * connected to the content below; inactive tabs are flat on the recessed rail
 * band. Data-driven by design: `TicketTabDescriptor` is the one shape a tab
 * needs, so ticket-detail.tsx appends one `"file"`-kind descriptor per open
 * `@file` ref, one `"diff"`-kind descriptor per open Change Set diff, and one
 * `"session"`-kind descriptor per linked terminal, and one `"chat"`-kind
 * descriptor per open chat Session. Content routing stays with the caller,
 * keyed off each tab's `kind`; file, diff, session, and chat tabs are closable,
 * and the two Session kinds — session and chat — are renamable.
 */
import * as React from "react";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { InlineRename } from "@renderer/components/sessions/inline-rename";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import {
  runOnLivePanes,
  terminalTabState,
  type TerminalTabState,
} from "@renderer/components/sessions/terminal-tab-state";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";
import { useSessionsStore } from "@renderer/stores/sessions";

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

/**
 * Hand focus to the tab that will survive this close — the one to the right, or
 * the left when the closed tab was last.
 *
 * Called BEFORE the close lands, from inside the × that is about to unmount, so
 * focus never spends a frame on `<body>` and the next Arrow keeps moving from
 * where the closed tab was. Shared verbatim with the Sessions strip, because
 * "where does focus go when a tab closes" is not a question the two surfaces get
 * to answer differently.
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

export type TicketTabKind = "body" | "session" | "file" | "diff" | "chat";

/**
 * A session tab's liveness. It rides the tab because the tab already names the
 * Session — a chat plane with its own status header would be a third chrome
 * band saying a word the tab has said already. A terminal tab reads it off its
 * PTY, a chat tab off its resident slice's lifecycle.
 */
export type TicketTabStatus = "idle" | "starting" | "ready" | "working" | "error";

/** Whether a ticket-strip tab of this kind shows a close affordance. */
export function isClosableTicketTab(kind: TicketTabKind): boolean {
  return kind === "session" || kind === "file" || kind === "diff" || kind === "chat";
}

/**
 * {@link terminalTabState}'s facts for a tab named only by its session id — what
 * the ticket strip has, since `ticket-detail.tsx` hands it descriptors rather
 * than store records.
 *
 * `sessionOwner` resolves any pane (root or split leaf) to its owner, so one
 * index lookup finds the container without the caller knowing whether a ticket
 * or a project owns it. Null for every other tab kind, and callable
 * unconditionally with `null` so a component that renders all five kinds can
 * still ask.
 */
function useTerminalTabState(sessionId: string | null): TerminalTabState | null {
  // Returns a store-held object, never a fresh one — a selector that built its
  // own would hand React a snapshot that never compares equal.
  const tab = useSessionsStore((state) => {
    if (sessionId === null) return undefined;
    const ownerId = state.sessionOwner[sessionId];
    return ownerId === undefined
      ? undefined
      : state.byOwner[ownerId]?.tabs.find((candidate) => candidate.sessionId === sessionId);
  });
  const parkState = useSessionsStore((state) => state.parkState);
  return tab === undefined ? null : terminalTabState(tab, parkState);
}

export interface TicketTabDescriptor {
  /**
   * Stable tab identity — session id, `file:<relPath>`, `diff:<relPath>`, or
   * `chat:<sessionId>`. A chat tab's id is prefixed and a terminal tab's is
   * not, so the two never collide in one strip.
   */
  id: string;
  kind: TicketTabKind;
  label: string;
  /** The project-relative path a `"file"` / `"diff"` tab opens (absent for other kinds). */
  relPath?: string;
  /**
   * Prior path for a rename diff (Change Set `previousPath`). Absent for
   * non-diff tabs and for diffs that are not renames.
   */
  previousPath?: string | null;
  /** A `"file"` tab whose file resolved from the ticket's worktree copy shows a subtle badge (decision #6). */
  badge?: "worktree";
  /** Session and chat tabs: a leading liveness dot. Absent renders no dot. */
  status?: TicketTabStatus;
  /**
   * A `"file"` tab in the replaceable preview slot (decision #56). Diff tabs
   * are always persistent and never set this. Preview labels render italic.
   */
  preview?: boolean;
  /**
   * A `"file"` / `"diff"` tab whose shared live model holds unsaved work.
   * Repository files save only on ⌘S (CONCEPT #49), so the draft has to be
   * visible from across the strip — and ticket-detail.tsx guards the close on
   * the same flag.
   */
  dirty?: boolean;
}

interface TicketTabStripProps {
  tabs: readonly TicketTabDescriptor[];
  activeTabId: string;
  /** Disables the session-start control while a session of either kind is booting. */
  creating: boolean;
  onSelectTab(tabId: string): void;
  /** Closes a session, chat, file, or diff tab. Doc has no close affordance. */
  onCloseTab(tab: TicketTabDescriptor): void;
  /**
   * Double-click a preview File tab → pin it (decision #56). Ignored for
   * Diff/session/Doc tabs.
   */
  onPinFileTab?(relPath: string): void;
  /**
   * Commits a Session-tab rename (double-click / context menu), for a terminal
   * or a chat tab — the caller discriminates on the tab id. Ignored for
   * Doc/file/diff tabs, which never raise it.
   */
  onRenameSessionTab(tabId: string, title: string): void;
  /** Boots a terminal session tab — the same path as the rail's Terminal control. */
  onNewSession(): void;
  /** Mints a chat Session and opens its tab. */
  onNewChat(): void;
  /** Drives the corner control's label — the details rail's current state. */
  railCollapsed: boolean;
  onToggleRail(): void;
}

/**
 * A single Chrome-style tab. The active tab lifts onto the content background
 * with rounded top corners (no bottom edge, so it fuses with the content plane
 * beneath the strip); inactive tabs sit flat and muted on the recessed band
 * with a hover surface. Session tabs (terminal and chat alike) carry a hover-
 * revealed close ×, double-click inline rename, and a right-click Rename menu.
 */
function TicketTab({
  tab,
  active,
  editing,
  onSelect,
  onClose,
  onPin,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  tab: TicketTabDescriptor;
  active: boolean;
  editing: boolean;
  onSelect(): void;
  onClose(): void;
  /** Pin a preview File tab (decision #56); undefined for other kinds. */
  onPin?: () => void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
}) {
  // Both Session kinds rename: the label is the Session's durable title either
  // way, and one `session.retitle` moves it — the consumer routes by tab id
  // (chat ids are `chat:`-prefixed) to the store that holds that title.
  const renamable = tab.kind === "session" || tab.kind === "chat";
  const closable = isClosableTicketTab(tab.kind);
  const dirty = tab.dirty === true;
  const preview = tab.preview === true;
  // A terminal tab's own PTY facts. Called for every kind (hooks are not
  // conditional) and null for the four that have no PTY.
  const terminal = useTerminalTabState(tab.kind === "session" ? tab.id : null);
  const parked = terminal !== null && terminal.parked && !terminal.exited;
  const exited = terminal?.exited === true;
  const showParkControls = (terminal?.livePaneIds.length ?? 0) > 0;

  // Select the tab and, if it was fully parked, wake it. Clicking the ALREADY
  // active tab changes no visibility state, so `TerminalView`'s own reveal-wake
  // never re-fires and the promised wake-on-click has to be explicit. Idempotent
  // for the select-a-different-tab case, where the visibility wiring wakes it too.
  const activate = () => {
    onSelect();
    if (parked && terminal !== null) {
      runOnLivePanes(terminal.livePaneIds, (id) => window.api.terminal.wake(id), "Wake");
    }
  };

  // The one line a hover can add to what the tab already says. Silent for every
  // tab whose label is the whole truth.
  const hint = exited
    ? `Exited (${terminal?.exitCode ?? "?"})`
    : parked
      ? "Parked to save memory. Click to wake."
      : tab.label;

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
      data-preview={preview ? "true" : undefined}
      tabIndex={active ? 0 : -1}
      onClick={activate}
      onDoubleClick={renamable ? onStartRename : preview && onPin !== undefined ? onPin : undefined}
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
      title={hint}
      className={cn(
        // `scale` is in the transition list and `scale-100!` is the
        // reduced-motion cancel — see the press note in `ui/button.tsx`.
        "group relative flex h-8 shrink-0 items-center rounded-t-lg text-sm outline-none transition-[color,background-color,box-shadow,transform,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:scale-100! focus-visible:ring-2 focus-visible:ring-ring/45",
        closable ? "pr-1 pl-4" : "px-4",
        active
          ? // -mb-px pulls the active tab 1px past the strip's bottom border so
            // its content-colored fill covers that seam — the tab reads as
            // physically connected to the content plane below (no dividing line).
            // `shadow-raised` is the halo that says "active", carried here
            // rather than by the `[role="tab"][aria-selected="true"]` rule
            // globals.css used to hold.
            "-mb-px bg-background text-foreground shadow-raised"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {tab.status !== undefined ? (
        <StatusDot state={tab.status} size="md" className="mr-1" />
      ) : terminal !== null ? (
        // A terminal tab's liveness, in the SAME leading slot and at the same
        // size as a chat tab's dot, so the column reads as liveness whatever the
        // kind. Without this a ticket's terminal tab was the one Session tab on
        // either strip that said nothing at all about being parked or dead — you
        // found out by clicking it.
        parked ? (
          <MoonIcon
            aria-hidden
            weight="bold"
            className="mr-1 size-3 shrink-0 text-muted-foreground"
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "mr-1 size-2 shrink-0 rounded-full",
              exited ? "bg-muted-foreground/30" : active ? "bg-primary" : "bg-muted-foreground",
            )}
          />
        )
      ) : null}
      {tab.badge === "worktree" ? (
        // A quiet dot marking a file resolved from the ticket's worktree copy
        // rather than the main checkout (decision #6).
        <span
          aria-label="Worktree copy"
          title="Worktree copy"
          className="mr-1 size-1.5 shrink-0 rounded-full bg-primary"
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
        // Preview File tabs are italic (same convention as Project Files).
        // An exited terminal is struck through, the same as on the other strip.
        <span
          className={cn(
            "max-w-40 truncate font-medium",
            preview && "italic",
            exited && "line-through",
          )}
        >
          {tab.label}
        </span>
      )}
      {closable && !editing ? (
        <button
          type="button"
          aria-label={`Close ${tab.label}`}
          // Stop the click from bubbling to the tab's own onClick (select), and
          // pass the keyboard on to a tab that will still be here afterwards.
          onClick={(event) => {
            event.stopPropagation();
            focusNeighborTab(event.currentTarget);
            onClose();
          }}
          className={cn(
            "group/close ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/45",
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

  // Session and chat tabs rename; preview File tabs get Keep Open (decision
  // #56). Doc / Diff / pinned File tabs skip the menu.
  if (!renamable && !(preview && onPin !== undefined)) return inner;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{inner}</ContextMenuTrigger>
      <ContextMenuContent>
        {renamable ? (
          <ContextMenuItem icon={PencilSimpleIcon} onSelect={onStartRename}>
            Rename
          </ContextMenuItem>
        ) : (
          <ContextMenuItem icon={PushPinIcon} onSelect={onPin}>
            Keep Open
          </ContextMenuItem>
        )}
        {/* The warm-park tier (issue #51) is about a PTY holding memory, and a
            ticket's PTY holds exactly as much as the project's — these items
            were simply never ported over when this strip learned about Sessions.
            Chat tabs get none of it: a chat's stream, fold and queue live in the
            resident client, so there is nothing here to hand memory back from. */}
        {terminal !== null && showParkControls ? (
          <>
            <ContextMenuSeparator />
            {parked ? (
              <ContextMenuItem
                icon={SunIcon}
                onSelect={() =>
                  runOnLivePanes(terminal.livePaneIds, (id) => window.api.terminal.wake(id), "Wake")
                }
              >
                Wake
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                icon={MoonIcon}
                onSelect={() =>
                  runOnLivePanes(terminal.livePaneIds, (id) => window.api.terminal.park(id), "Park")
                }
              >
                Park Now
              </ContextMenuItem>
            )}
            <ContextMenuItem
              icon={terminal.keptAwake ? PushPinSlashIcon : PushPinIcon}
              onSelect={() =>
                runOnLivePanes(
                  terminal.livePaneIds,
                  (id) => window.api.terminal.setKeepAwake(id, !terminal.keptAwake),
                  terminal.keptAwake ? "Allow Parking" : "Keep Awake",
                )
              }
            >
              {terminal.keptAwake ? "Allow Parking" : "Keep Awake"}
            </ContextMenuItem>
          </>
        ) : null}
        {/* Closing from the menu, not only from a × you have to hover to see —
            the Sessions strip has offered this since it shipped, and a Session
            is the one tab kind whose close the keyboard can otherwise not reach. */}
        {renamable ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem icon={XIcon} variant="destructive" onSelect={onClose}>
              Close
            </ContextMenuItem>
          </>
        ) : null}
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
  onPinFileTab,
  onRenameSessionTab,
  onNewSession,
  onNewChat,
  railCollapsed,
  onToggleRail,
}: TicketTabStripProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <div className="flex shrink-0 items-end border-b border-border bg-rail pt-1">
      {/* Tabs own the left and scroll; actions own the right and do not. The
          session-start control used to ride INSIDE this scroller, immediately
          after the last tab, and that is what made it read as one more tab: same
          row, same baseline, same ghost hover surface as an inactive tab, and in
          dark mode the two surfaces are the same token. Distance is only half
          the fix — see the cluster below for the other half. */}
      <div className="flex min-w-0 flex-1 items-end overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Named, because the details rail draws a tablist of its own on the
            same screen — two unlabeled ones leave AT (and any query by role)
            with no way to say which strip it means. */}
        <div
          role="tablist"
          aria-label="Ticket tabs"
          aria-orientation="horizontal"
          className="flex items-end gap-1"
        >
          {tabs.map((tab) => (
            <TicketTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              editing={editingId === tab.id}
              onSelect={() => onSelectTab(tab.id)}
              onClose={() => onCloseTab(tab)}
              onPin={
                tab.kind === "file" && tab.relPath !== undefined && onPinFileTab !== undefined
                  ? () => onPinFileTab(tab.relPath!)
                  : undefined
              }
              onStartRename={() => setEditingId(tab.id)}
              onCommitRename={(next) => {
                setEditingId(null);
                onRenameSessionTab(tab.id, next);
              }}
              onCancelRename={() => setEditingId(null)}
            />
          ))}
        </div>
      </div>
      {/* The strip's actions, past a divider. Everything here is about the
          STRIP; nothing here is a place you can be. The rule is dividing the two
          populations, and vertical centring is the rest of the fix: the tabs sit
          on the strip's bottom edge (items-end) because they fuse with the
          content plane, so a control centred in the band's full height cannot be
          mistaken for one of them however it is styled.

          -mt-1.5 cancels the strip's pt-1.5 so this column spans the true top
          edge to bottom (the framed card's rounded-t-lg + overflow clips the
          outer corner). */}
      <div className="-mt-1 flex shrink-0 items-stretch self-stretch border-l border-border/70 pr-1 pl-2">
        <div className="flex items-center">
          {/* The chord hint belongs here now: ⌘T / ⌥⌘T resolve against the
              surface in front (`lib/new-session-shortcut.ts`), so inside a ticket
              they start exactly what this control starts. `align="end"` because
              the control now sits at the strip's right edge — the menu hangs back
              into the window rather than off it. */}
          <NewSessionControl
            disabled={creating}
            placement="strip"
            align="end"
            shortcuts
            onNewChat={onNewChat}
            onNewTerminal={onNewSession}
          />
        </div>
        {/* The details rail's collapse control, and the reason this corner has
            no `disabled` state, no reserved slot and no fade: the strip spans
            both columns, so its right corner sits directly on top of the pane
            this button collapses, and that pane is always there to collapse. It
            keeps its full-height rectangular hover (h-full over size-5's height,
            rounded-none) so it reads as a corner REGION rather than a tall pill —
            which is also what tells it apart from the pill beside it.
            (Terminal focus, which WAS conditional on the active tab's kind and
            then briefly lived on the chrome band, is now drawn on the terminal
            pane itself — see `session-split-layout.tsx`.) */}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-1 h-full rounded-none"
          onClick={onToggleRail}
          // No `aria-pressed`: the label below already carries the state, and
          // the button has no pressed appearance for it to describe — the same
          // call the band's own panel toggles make.
          aria-label={railCollapsed ? "Show details rail" : "Hide details rail"}
          title={`${railCollapsed ? "Show" : "Hide"} details (⌥⌘B)`}
        >
          {/* scale-x-[-1] mirrors the left-sidebar glyph so it reads as the
              RIGHT panel (VS Code's secondary-sidebar convention). */}
          <SidebarSimpleIcon className="size-3.5 scale-x-[-1]" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The ticket detail's tab strip (ticket-detail-mvp decision #6): a full-width
 * row at the very top of the detail view — `<TicketId> | <file tabs…> |
 * <session tabs…> | [ + Chat ▾ ]` — spanning above both the main column and the
 * right rail. The drawing and the focus mechanics are `ui/tab-strip.tsx`'s (the
 * folder variant, shared with the Project Files workbench).
 *
 * Data-driven by design: `TicketTabDescriptor` is the one shape a tab needs, so
 * ticket-detail.tsx appends one `"file"`-kind descriptor per open `@file` ref,
 * one `"diff"`-kind descriptor per open Change Set diff, one `"session"`-kind
 * descriptor per linked terminal, and one `"chat"`-kind descriptor per open
 * chat Session. Content routing stays with the caller, keyed off each tab's
 * `kind`; file, diff, session, and chat tabs are closable, and the two Session
 * kinds — session and chat — are renamable.
 */
import * as React from "react";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { SkillReference } from "@volli/shared";

import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import {
  runOnLivePanes,
  terminalTabDot,
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
import { Tab, TabStrip, tabStopIndex } from "@renderer/components/ui/tab-strip";
import { cn } from "@renderer/lib/utils";
import { useSessionsStore } from "@renderer/stores/sessions";

export type TicketTabKind = "body" | "session" | "file" | "diff" | "chat";

/**
 * A session tab's liveness. It rides the tab because the tab already names the
 * Session — a chat plane with its own status header would be a third chrome
 * band saying a word the tab has said already. A terminal tab reads it off its
 * PTY, a chat tab off its resident slice's lifecycle.
 *
 * `waiting` is not a lifecycle: it is a request standing open on a Session that
 * is otherwise `working`, and it is here because a tab is the whole of what a
 * background chat shows of itself. `ui/status-dot.tsx` owns what colour it is,
 * and reserves that one for the single state that is asking for a person.
 */
export type TicketTabStatus = "idle" | "starting" | "ready" | "working" | "waiting" | "error";

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
  /** The project's skills — the "Chat with skill" submenu's rows. */
  skills?: readonly SkillReference[];
  /** Mints a chat Session with one named skill injected at attach time. */
  onNewChatWithSkill?(name: string): void;
  /** Drives the corner control's label — the details rail's current state. */
  railCollapsed: boolean;
  onToggleRail(): void;
}

/**
 * A single tab. Session tabs (terminal and chat alike) carry a hover-revealed
 * close ×, double-click inline rename, and a right-click Rename menu; a preview
 * File tab pins on double-click. Everything else about how it draws is the
 * shared primitive's.
 */
function TicketTab({
  tab,
  active,
  tabStop,
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
  /** This tab is the strip's single roving-tabindex entry point. */
  tabStop: boolean;
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
  const preview = tab.preview === true;
  // A terminal tab's own PTY facts. Called for every kind (hooks are not
  // conditional) and null for the four that have no PTY.
  const terminal = useTerminalTabState(tab.kind === "session" ? tab.id : null);
  const parked = terminal !== null && terminal.parked && !terminal.exited;
  const exited = terminal?.exited === true;
  const showParkControls = (terminal?.livePaneIds.length ?? 0) > 0;
  // A terminal tab's liveness, in the SAME leading slot and at the same size as
  // a chat tab's dot, so the column reads as liveness whatever the kind.
  // Without this a ticket's terminal tab was the one Session tab on either
  // strip that said nothing at all about being parked or dead — you found out
  // by clicking it.
  const terminalDot = terminal === null ? null : terminalTabDot(terminal);

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

  const inner = (
    <Tab
      data-preview={preview ? "true" : undefined}
      label={tab.label}
      active={active}
      tabStop={tabStop}
      closable={closable}
      dirty={tab.dirty === true}
      // The one line a hover can add to what the tab already says. Silent for
      // every tab whose label is the whole truth.
      //
      // The waiting dot gets one, in the sidebar's own words: this is the only
      // surface where that dot stands with nothing beside it to say what it
      // means, and "a Session is asking you something" is not a colour anyone
      // should have to have learnt.
      title={
        exited
          ? `Exited (${terminal?.exitCode ?? "?"})`
          : parked
            ? "Parked to save memory. Click to wake."
            : tab.status === "waiting"
              ? `${tab.label}\nWaiting for you`
              : tab.label
      }
      // Preview File tabs are italic (same convention as Project Files); an
      // exited terminal is struck through, the same as on the other strip.
      labelClassName={cn(preview && "italic", exited && "line-through")}
      status={tab.status ?? terminalDot ?? undefined}
      leading={
        terminalDot === null && terminal !== null ? (
          <MoonIcon aria-hidden weight="bold" className="size-3 shrink-0 text-muted-foreground" />
        ) : null
      }
      badge={
        tab.badge === "worktree" ? (
          // A quiet dot marking a file resolved from the ticket's worktree copy
          // rather than the main checkout (decision #6).
          <span
            aria-label="Worktree copy"
            title="Worktree copy"
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : null
      }
      renaming={
        editing ? { value: tab.label, onCommit: onCommitRename, onCancel: onCancelRename } : null
      }
      onActivate={activate}
      onDoubleClick={renamable ? onStartRename : preview ? onPin : undefined}
      onClose={onClose}
    />
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
            Home's strip has offered this since it shipped, and a Session
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
  skills,
  onNewChatWithSkill,
  railCollapsed,
  onToggleRail,
}: TicketTabStripProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const stop = tabStopIndex(
    tabs.length,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );

  return (
    <TabStrip
      label="Ticket tabs"
      actions={
        <>
          <div className="flex items-center">
            {/* The chord hint belongs here: ⌘T / ⌥⌘T resolve against the
                surface in front (`lib/new-session-shortcut.ts`), so inside a
                ticket they start exactly what this control starts.
                `align="end"` because the control sits at the strip's right edge
                — the menu hangs back into the window rather than off it. */}
            <NewSessionControl
              disabled={creating}
              placement="strip"
              align="end"
              shortcuts
              skills={skills}
              onNewChat={onNewChat}
              onNewChatWithSkill={onNewChatWithSkill}
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
        </>
      }
    >
      {tabs.map((tab, index) => (
        <TicketTab
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          tabStop={index === stop}
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
    </TabStrip>
  );
}

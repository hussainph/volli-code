import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { XSquareIcon } from "@phosphor-icons/react/dist/csr/XSquare";

import type { SkillReference } from "@volli/shared";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import {
  runOnLivePanes,
  terminalTabDot,
  terminalTabState,
} from "@renderer/components/sessions/terminal-tab-state";
import type { TicketTabStatus } from "@renderer/components/ticket/ticket-tabs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Button } from "@renderer/components/ui/button";
import { Tab, TabStrip, tabStopIndex, type TabProps } from "@renderer/components/ui/tab-strip";
import { useSessionsStore, type SessionTab } from "@renderer/stores/sessions";

/**
 * What the Home strip draws, per kind.
 *
 * The `board` kind carries nothing at all: it is the permanent first tab, and
 * every fact about it is a constant. It is the exact analogue of the ticket
 * strip's always-present Body tab — same position, same permanence, same
 * absence of a close — which is what makes Home read as the ticket workspace
 * one scope up rather than as a new kind of thing.
 *
 * A terminal tab carries its whole store record — park state, panes and exit
 * codes are all read off it — while a chat tab carries the two facts a chat has
 * on a strip: its title and its liveness. A File tab carries the Main-checkout
 * path plus preview/dirty presentation. `id` is the identity in the merged
 * strip and in `homeActiveTab`; chat and File ids are prefixed, terminal ids are
 * UUIDs, and the Board is a bare word, so the four spaces never collide.
 */
export type HomeTabDescriptor =
  | { kind: "board"; id: typeof HOME_BOARD_TAB_ID }
  | { kind: "terminal"; id: string; tab: SessionTab }
  | { kind: "chat"; id: string; sessionId: string; title: string; status: TicketTabStatus }
  | {
      kind: "file";
      id: string;
      relPath: string;
      title: string;
      hint: string | null;
      preview: boolean;
      dirty: boolean;
    };

/** The Board tab, spelled once. */
export const HOME_BOARD_TAB: HomeTabDescriptor = { kind: "board", id: HOME_BOARD_TAB_ID };

interface HomeTabStripProps {
  tabs: readonly HomeTabDescriptor[];
  activeTabId: string;
  onSelect(tab: HomeTabDescriptor): void;
  /** Never raised for the Board tab, which carries no close affordance. */
  onClose(tab: HomeTabDescriptor): void;
  /** Never raised for the Board or File tabs, which are not renamable. */
  onRename(tab: HomeTabDescriptor, title: string): void;
  /** Double-click / Keep Open on a preview File tab. */
  onPinFile(relPath: string): void;
  /** "Close Others" on a File tab — closes every OTHER File tab, guards included. */
  onCloseOtherFiles(relPath: string): void;
  onNewSession(): void;
  onNewChat(): void;
  /** The project's skills — the "Chat with skill" submenu's rows. */
  skills?: readonly SkillReference[];
  /** Mints a chat Session with one named skill injected at attach time. */
  onNewChatWithSkill?(name: string): void;
  /** A Session of either kind is already booting. */
  creating: boolean;
  /** Whether Home's details rail is collapsed — the corner control's state. */
  railCollapsed: boolean;
  /**
   * Whether there is a rail to talk about at all. The Board tab has none: a
   * rail about the Session in front, over a board, would be about nothing.
   */
  railTogglable: boolean;
  onToggleRail(): void;
}

/**
 * Home's tab strip: the FOLDER variant of `ui/tab-strip.tsx`, the same drawing
 * the ticket workspace uses and in the same place — the top edge of the content
 * card, with the active tab bleeding one pixel past the strip's border so it
 * fuses with the plane below. That is not a coincidence to be tidied away
 * later: Home and a ticket workspace are the same object at two scopes, and
 * drawing them alike is how the app says so without prose.
 *
 * (It was the PILL variant while this strip belonged to the Sessions page,
 * where it floated above a surface it did not own. It owns this one.)
 *
 * The permanent Board tab leads, then both kinds of Session a project can run
 * without a ticket — terminals first and chats after — then Main-checkout File
 * tabs in their reducer order. A trailing split control starts either Session;
 * every tab but the Board carries a hover-revealed close and a right-click
 * menu. Session tabs rename on double-click; preview File tabs pin.
 *
 * Only the terminal kind talks about parking: the moon badge, the wake-on-click
 * and the Park/Wake/Keep Awake items are all about a PTY holding memory (issue
 * #51), and a chat Session holds none.
 */
export function HomeTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onRename,
  onPinFile,
  onCloseOtherFiles,
  onNewSession,
  onNewChat,
  skills,
  onNewChatWithSkill,
  creating,
  railCollapsed,
  railTogglable,
  onToggleRail,
}: HomeTabStripProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const stop = tabStopIndex(
    tabs.length,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );

  return (
    <TabStrip
      variant="folder"
      label="Home tabs"
      actions={
        <>
          {/* The chord hint stays: ⌘T / ⌥⌘T resolve against the surface in front
              (`lib/new-session-shortcut.ts`), and on Home that is this project's
              ticketless Sessions — exactly what this control mints, from the Board
              tab as well as from a Session tab. `align="end"` so the menu hangs
              back into the window rather than off its edge. */}
          <div className="flex items-center">
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
          {/* The rail's collapse control, in the same corner the ticket strip
              puts it — same glyph, same chord, same full-height rectangular
              hover, because it is the same control one scope up. It is ABSENT
              on the Board tab rather than disabled: the strip's right corner
              sits over the box the rail would occupy, and on the board there is
              no such box. */}
          {railTogglable ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-1 h-full rounded-none"
              onClick={onToggleRail}
              aria-label={railCollapsed ? "Show details rail" : "Hide details rail"}
              title={`${railCollapsed ? "Show" : "Hide"} details (⌥⌘B)`}
            >
              {/* scale-x-[-1] mirrors the left-sidebar glyph so it reads as the
                  RIGHT panel (VS Code's secondary-sidebar convention). */}
              <SidebarSimpleIcon className="size-3.5 scale-x-[-1]" />
            </Button>
          ) : null}
        </>
      }
    >
      {tabs.map((descriptor, index) => {
        const active = descriptor.id === activeTabId;
        const tabStop = index === stop;
        if (descriptor.kind === "board") {
          return (
            <BoardTab
              key={descriptor.id}
              active={active}
              tabStop={tabStop}
              onSelect={() => onSelect(descriptor)}
            />
          );
        }
        if (descriptor.kind === "file") {
          return (
            <HomeFileTab
              key={descriptor.id}
              tab={descriptor}
              active={active}
              tabStop={tabStop}
              onSelect={() => onSelect(descriptor)}
              onPin={() => onPinFile(descriptor.relPath)}
              onClose={() => onClose(descriptor)}
              onCloseOthers={() => onCloseOtherFiles(descriptor.relPath)}
            />
          );
        }
        // One set of callbacks for both Session kinds — what differs between
        // them is what each tab DRAWS and what its menu offers, never how the
        // strip reports a selection, a close, or a rename.
        const shared = {
          active,
          tabStop,
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
    </TabStrip>
  );
}

/**
 * The permanent first tab.
 *
 * No close, no rename, no context menu — there is nothing to offer about a tab
 * that cannot go away, and an empty menu is worse than none. The Kanban glyph
 * stays with the board rather than following the nav row: on the nav row it had
 * to name a whole environment and stopped fitting, while here it names exactly
 * one tab among Sessions and is the one item that is neither a chat nor a
 * terminal. It stays outline like its neighbours — `fill` is a different
 * drawing rather than a heavier one (CLAUDE.md), and position plus shape
 * already say this tab is not one of the others.
 */
function BoardTab({
  active,
  tabStop,
  onSelect,
}: {
  active: boolean;
  tabStop: boolean;
  onSelect(): void;
}) {
  return (
    <Tab
      label="Board"
      active={active}
      tabStop={tabStop}
      closable={false}
      onActivate={onSelect}
      // size-3 and `bold`, the leading-glyph tier the chat bubble and the moon
      // beside it already take: at 12px regular draws lighter than the label.
      leading={
        <KanbanIcon aria-hidden weight="bold" className="size-3 shrink-0 text-muted-foreground" />
      }
    />
  );
}

/**
 * One Main-checkout File tab.
 *
 * It speaks the PROJECT FILES strip's vocabulary rather than the ticket
 * strip's, and that is the deliberate half of the choice: these are main
 * checkout files, opened out of the same `FileWorkspaceState` the Files
 * workbench reduces, so `file-tab-strip.tsx`'s menu is the one a person has
 * already met on the same files — Keep Open (disabled once pinned, so the menu
 * keeps one shape), Close, Close Others. The ticket strip differs because a
 * pinned ticket File tab has no menu at all, which would leave Home's keyboard
 * users with no route to Close.
 */
function HomeFileTab({
  tab,
  active,
  tabStop,
  onSelect,
  onPin,
  onClose,
  onCloseOthers,
}: {
  tab: Extract<HomeTabDescriptor, { kind: "file" }>;
  active: boolean;
  tabStop: boolean;
  onSelect(): void;
  onPin(): void;
  onClose(): void;
  onCloseOthers(): void;
}) {
  const inner = (
    <Tab
      data-testid="home-file-tab"
      data-rel-path={tab.relPath}
      // Spelled both ways, as on the Files strip: a test and the smoke read
      // "false" rather than having to tell an absent attribute from a stale one.
      data-preview={tab.preview ? "true" : "false"}
      data-dirty={tab.dirty ? "true" : "false"}
      label={tab.title}
      hint={tab.hint ?? undefined}
      active={active}
      tabStop={tabStop}
      dirty={tab.dirty}
      labelClassName={tab.preview ? "italic" : undefined}
      onActivate={onSelect}
      onDoubleClick={tab.preview ? onPin : undefined}
      onClose={onClose}
    />
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{inner}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon={PushPinIcon} disabled={!tab.preview} onSelect={onPin}>
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

interface KindTabProps {
  active: boolean;
  tabStop: boolean;
  editing: boolean;
  onSelect(): void;
  onClose(): void;
  onStartRename(): void;
  onCommitRename(next: string): void;
  onCancelRename(): void;
}

/**
 * The `Tab` props every kind here shares, so the two kinds cannot drift the
 * rename plumbing apart. What a kind contributes on top is its label, its
 * leading glyphs, its hover line and the menu its caller wraps the tab in.
 */
function sharedTabProps(
  label: string,
  {
    active,
    tabStop,
    editing,
    onClose,
    onStartRename,
    onCommitRename,
    onCancelRename,
  }: Omit<KindTabProps, "onSelect">,
): Pick<TabProps, "active" | "tabStop" | "renaming" | "onClose" | "onDoubleClick"> {
  return {
    active,
    tabStop,
    renaming: editing ? { value: label, onCommit: onCommitRename, onCancel: onCancelRename } : null,
    onClose,
    onDoubleClick: onStartRename,
  };
}

/** One terminal tab: a live PTY tree, with the warm-park tier's vocabulary on it. */
function TerminalTab({ tab, onSelect, ...shell }: KindTabProps & { tab: SessionTab }) {
  const parkState = useSessionsStore((state) => state.parkState);
  // The derivation moved to `terminal-tab-state.ts` so the ticket strip could
  // read it too — it was the reason a ticket's terminal tab used to say nothing
  // about being parked or dead. Nothing about the reading changed.
  const terminal = terminalTabState(tab, parkState);
  const { exited, exitCode, parked, keptAwake, livePaneIds } = terminal;
  const showParkControls = livePaneIds.length > 0;
  const dot = terminalTabDot(terminal);
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
      runOnLivePanes(livePaneIds, (paneId) => window.api.terminal.wake(paneId), "Wake");
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tab
          {...sharedTabProps(tab.title, shell)}
          label={tab.title}
          // Exited tabs read as muted; a parked (and live) tab explains itself
          // on hover.
          title={
            exited
              ? `Exited (${exitCode})`
              : parked
                ? "Parked to save memory. Click to wake."
                : tab.title
          }
          labelClassName={exited ? "line-through" : undefined}
          status={dot ?? undefined}
          leading={
            // size-3, the same as the chat bubble that shares this slot and the
            // same as the ticket strip's moon — one leading glyph size now that
            // the two strips are one tab.
            dot === null ? (
              <MoonIcon
                aria-hidden
                weight="bold"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null
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
                  runOnLivePanes(livePaneIds, (paneId) => window.api.terminal.park(paneId), "Park")
                }
              >
                Park Now
              </ContextMenuItem>
            )}
            {parked && (
              <ContextMenuItem
                icon={SunIcon}
                onSelect={() =>
                  runOnLivePanes(livePaneIds, (paneId) => window.api.terminal.wake(paneId), "Wake")
                }
              >
                Wake
              </ContextMenuItem>
            )}
            <ContextMenuItem
              icon={keptAwake ? PushPinSlashIcon : PushPinIcon}
              onSelect={() =>
                runOnLivePanes(
                  livePaneIds,
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
        <Tab
          {...sharedTabProps(title, shell)}
          label={title}
          // The waiting dot's one line of hover, in the sidebar's own words: a
          // tab is the only place that dot stands with nothing beside it to say
          // what it means.
          title={status === "waiting" ? `${title}\nWaiting for you` : title}
          onActivate={onSelect}
          status={status}
          leading={
            // Bold, not filled: the dot beside it is already a solid object,
            // and two in a 12px row is one too many. Same treatment as the
            // sidebar's kind glyph — at this size regular draws lighter than
            // its own label and bold puts the pen back on the text stem.
            <ChatCircleIcon weight="bold" className="size-3 shrink-0 text-muted-foreground" />
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

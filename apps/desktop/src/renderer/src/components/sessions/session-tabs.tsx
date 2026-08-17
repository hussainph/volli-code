import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import type { SkillReference } from "@volli/shared";

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
import { Tab, TabStrip, tabStopIndex, type TabProps } from "@renderer/components/ui/tab-strip";
import { useSessionsStore, type SessionTab } from "@renderer/stores/sessions";

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

interface SessionTabsProps {
  tabs: readonly SessionTabDescriptor[];
  activeTabId: string | null;
  onSelect(tab: SessionTabDescriptor): void;
  onClose(tab: SessionTabDescriptor): void;
  onRename(tab: SessionTabDescriptor, title: string): void;
  onNewSession(): void;
  onNewChat(): void;
  /** The project's skills — the "Chat with skill" submenu's rows. */
  skills?: readonly SkillReference[];
  /** Mints a chat Session with one named skill injected at attach time. */
  onNewChatWithSkill?(name: string): void;
  /** A Session of either kind is already booting. */
  creating: boolean;
}

/**
 * The scratch tab strip: the pill variant of `ui/tab-strip.tsx`, matching the
 * chrome band the sessions surface sits under. It holds both kinds of Session a
 * project can run without a ticket, terminals first and chats after, each in
 * the order it was opened. A trailing split control starts either; each tab
 * carries a hover-revealed close, a right-click menu, and double-click inline
 * rename.
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
  skills,
  onNewChatWithSkill,
  creating,
}: SessionTabsProps) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const stop = tabStopIndex(
    tabs.length,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );

  return (
    <TabStrip
      variant="pill"
      label="Session tabs"
      actions={
        // The chord hint stays: ⌘T / ⌥⌘T resolve against the surface in front
        // (`lib/new-session-shortcut.ts`), and on this page that is this
        // project's ticketless Sessions — exactly what this control mints.
        // `align="end"` so the menu hangs back into the window rather than off
        // its edge.
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
      }
    >
      {tabs.map((descriptor, index) => {
        // One set of callbacks for both kinds — what differs between them is
        // what each tab DRAWS and what its menu offers, never how the strip
        // reports a selection, a close, or a rename.
        const shared = {
          active: descriptor.id === activeTabId,
          tabStop: index === stop,
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

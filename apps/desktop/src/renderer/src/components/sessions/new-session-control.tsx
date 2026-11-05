/** One anchored tab chooser; direct Session shortcuts keep their existing scope.
 * The context menu is the same offer. A Browser is a tab, not a Session, and a
 * cloud launch offers only Chat plus the existing Runner picker.
 */
import * as React from "react";
import { BrowserIcon, ChatIcon, AddIcon, TerminalIcon } from "@renderer/components/ui/icon";

import { readOnlyMark } from "@renderer/components/hosts/use-hosts";
import { useCanSendSession } from "@renderer/lib/cloud-session-read-only";
import { launchStore } from "@renderer/stores/launch";
import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";
import { RunnerPicker, useRunnerPicker } from "@renderer/components/chat/runner-picker";

/** The chord each kind announces in a menu's trailing slot. */
const CHORD = { chat: "⌘T", terminal: "⌥⌘T" } as const;

/**
 * Which room the control is in. One axis, not three — every value is a real
 * place, and bundling scale, emphasis and label keeps a caller from inventing a
 * combination nobody drew.
 */
export type NewSessionPlacement = "strip" | "rail" | "empty";

/** Control scale, emphasis and label per room. */
const DRAWING = {
  strip: { size: "icon", variant: "ghost" },
  rail: { size: "icon-xs", variant: "ghost" },
  empty: { size: "icon-sm", variant: "default" },
} as const;

/** What every row in either menu needs, and nothing about how it is drawn. */
export interface NewSessionMenuRowHandlers {
  shortcuts?: boolean;
  onNewChat(): void;
  onNewBrowser?(): void;
  /** Absent drops the row: a cloud launch's terminals run on no runner yet. */
  onNewTerminal?(): void;
}

/**
 * The rows, written once for the two menus that must offer the same acts.
 *
 * The caret menu and the right-click menu are the same offer reached two ways,
 * and keeping one list is what stops them drifting into two. The split is only
 * in the drawing: Radix gives each menu its own item and shortcut components,
 * and the context flavour takes its icon as a prop where the dropdown takes it
 * as a child.
 *
 * Exported and hook-free so a test can read the rows directly — both menus are
 * portalled and closed at rest, so rendered markup never contains them.
 */
export function newSessionMenuRows(
  menu: "dropdown" | "context",
  { shortcuts = false, onNewChat, onNewBrowser, onNewTerminal }: NewSessionMenuRowHandlers,
): React.ReactNode {
  if (menu === "context") {
    return (
      <>
        <ContextMenuItem icon={ChatIcon} onSelect={onNewChat}>
          Chat
          {shortcuts ? <ContextMenuShortcut>{CHORD.chat}</ContextMenuShortcut> : null}
        </ContextMenuItem>
        {onNewTerminal === undefined ? null : (
          <ContextMenuItem icon={TerminalIcon} onSelect={onNewTerminal}>
            Terminal
            {shortcuts ? <ContextMenuShortcut>{CHORD.terminal}</ContextMenuShortcut> : null}
          </ContextMenuItem>
        )}
        {onNewBrowser === undefined ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem icon={BrowserIcon} onSelect={onNewBrowser}>
              Browser
            </ContextMenuItem>
          </>
        )}
      </>
    );
  }
  return (
    <>
      <DropdownMenuItem onSelect={onNewChat}>
        <ChatIcon />
        Chat
        {shortcuts ? <DropdownMenuShortcut>{CHORD.chat}</DropdownMenuShortcut> : null}
      </DropdownMenuItem>
      {onNewTerminal === undefined ? null : (
        <DropdownMenuItem onSelect={onNewTerminal}>
          <TerminalIcon />
          Terminal
          {shortcuts ? <DropdownMenuShortcut>{CHORD.terminal}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
      )}
      {onNewBrowser === undefined ? null : (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onNewBrowser}>
            <BrowserIcon />
            Browser
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

export function NewSessionControl({
  projectId,
  disabled: booting,
  placement = "strip",
  align = "start",
  shortcuts = false,
  className,
  onNewChat,
  onNewBrowser,
  onNewTerminal,
}: {
  /**
   * The project a new Session would run in. While its host cannot serve
   * (VC-576) the whole control stands down.
   */
  projectId: string | null;
  /** A Session of either kind is already booting. */
  disabled: boolean;
  placement?: NewSessionPlacement;
  /** Which edge the menus hang from — `"end"` where the control sits at a right edge. */
  align?: "start" | "end";
  /**
   * Announce ⌘T / ⌥⌘T beside the menu items.
   *
   * ON only where a press of the chord starts the same thing the item does —
   * which, since the chords began resolving against the surface in front
   * (`lib/new-session-shortcut.ts`), is every mount that lives ON one of those
   * surfaces. A ticket's controls announce the chords because inside a ticket
   * the chord mints a ticket Session; Home's strip announces them because
   * on that page it mints a ticketless one. The flag survives rather than
   * becoming a constant because "a menu may only advertise a key that does what
   * the item does" is the rule, not "everything advertises": a control that ever
   * appears somewhere the chord resolves elsewhere must be able to stay quiet.
   */
  shortcuts?: boolean;
  className?: string;
  onNewChat(): void;
  /**
   * Open a blank Browser Tab in this surface's scope.
   *
   * Optional, and absent simply drops the row: a mount that cannot host a
   * native Browser Tab must not offer one, for the reason the skills submenu
   * used to state — an item is a promise the press has to keep.
   */
  onNewBrowser?(): void;
  onNewTerminal(): void;
}) {
  const drawing = DRAWING[placement];
  const runners = useRunnerPicker(projectId);
  // A new chat is a send (VC-895): in a cloud launch this Mac's runner starts
  // it, so the cloud link decides. Terminals and Browser Tabs are this Mac's
  // alone and have no cloud Session to belong to, so a cloud launch offers
  // neither.
  const canWrite = useCanSendSession(projectId);
  const cloud = launchStore() === "cloud";
  const disabled = booting || !canWrite || (cloud && runners.selected === null);
  const newTerminal = cloud ? undefined : onNewTerminal;
  const newBrowser = cloud ? undefined : onNewBrowser;

  // Whether the menu that is closing should keep its hands off the caret.
  //
  // A menu returns focus to its own trigger as it closes, which is right for
  // every row here but one: a blank Browser Tab exists to be typed into, and
  // its address bar takes the caret as it mounts. Those two acts raced, and the
  // menu won — the built-app smoke caught the "+" button still focused over an
  // empty address bar. So the Browser row declines the restore instead, and the
  // pane's own focus is left standing.
  //
  // Scoped to that one row on purpose: Escape, an outside click, and both
  // Session rows still hand the caret back to the trigger, which is what a
  // keyboard reader expects and the only behaviour that has somewhere to
  // return to.
  const yieldFocus = React.useRef(false);
  const handleCloseAutoFocus = (event: Event) => {
    if (!yieldFocus.current) return;
    yieldFocus.current = false;
    event.preventDefault();
  };
  const handleNewBrowser =
    newBrowser === undefined
      ? undefined
      : () => {
          yieldFocus.current = true;
          newBrowser();
        };

  const items = newSessionMenuRows("dropdown", {
    shortcuts,
    onNewChat,
    onNewBrowser: handleNewBrowser,
    onNewTerminal: newTerminal,
  });

  return (
    <div {...readOnlyMark(canWrite)} className="inline-flex min-w-0 items-center gap-1">
      <ContextMenu>
        <DropdownMenu>
          <ContextMenuTrigger asChild disabled={disabled}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant={drawing.variant}
                size={drawing.size}
                disabled={disabled}
                aria-label="Open a tab"
                title="Open a tab"
                className={cn("shrink-0", className)}
              >
                <AddIcon />
              </Button>
            </DropdownMenuTrigger>
          </ContextMenuTrigger>
          <DropdownMenuContent
            className="min-w-52"
            align={align}
            onCloseAutoFocus={handleCloseAutoFocus}
          >
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
        <ContextMenuContent className="min-w-52" onCloseAutoFocus={handleCloseAutoFocus}>
          {newSessionMenuRows("context", {
            shortcuts,
            onNewChat,
            onNewBrowser: handleNewBrowser,
            onNewTerminal: newTerminal,
          })}
        </ContextMenuContent>
      </ContextMenu>
      {cloud ? <RunnerPicker state={runners} disabled={booting} /> : null}
    </div>
  );
}

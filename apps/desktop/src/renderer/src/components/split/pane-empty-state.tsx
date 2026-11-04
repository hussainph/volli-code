import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FileMagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/FileMagnifyingGlass";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Icon } from "@phosphor-icons/react";

import { MENU_SHORTCUT } from "@renderer/components/ui/menu-classes";
import { Button } from "@renderer/components/ui/button";

/**
 * WHAT AN EMPTY PANE OFFERS (VC-202 §3).
 *
 * A pane opened by `⌘\` holds nothing, and the honest thing to put in it is the
 * list of surfaces it could hold: chats, terminals, browsers and files.
 *
 * NO PROSE. There is no heading, no "drag a tab here", no explanation of what a
 * split is: the rows are verbs and the chords beside them are the same chords
 * that work while this pane has focus, so the menu teaches itself by being
 * redundant (CLAUDE.md, "let controls talk"). Browser has no chord; its row is
 * the discoverable path.
 *
 * The rows do not carry pane plumbing either. `⌘T` and `⌥⌘T` start a Session on
 * the surface and `⌘P` previews a file on it; each lands HERE because an empty
 * pane is by definition the focused pane, and a tab OPENED while a group is
 * shown joins the focused pane (`split-view.ts`'s `openTab`). Close pane is the
 * one row that is about the pane itself.
 *
 * Rows use the shared push-button geometry and keyboard focus treatment.
 * Chords use the menu hint recipe so the same command reads consistently.
 */
export interface PaneEmptyStateProps {
  onNewChat(): void;
  onNewTerminal(): void;
  onNewBrowser(): void;
  /** Opens quick-open (⌘P); the file it previews lands in this pane. */
  onOpenFile(): void;
  onClosePane(): void;
}

export function PaneEmptyState({
  onNewChat,
  onNewTerminal,
  onNewBrowser,
  onOpenFile,
  onClosePane,
}: PaneEmptyStateProps) {
  return (
    <div
      data-slot="pane-empty-state"
      className="flex min-h-0 flex-1 flex-col items-center justify-center p-4"
    >
      <div className="flex w-full max-w-72 flex-col gap-1">
        <PaneEmptyRow
          icon={ChatCircleIcon}
          label="New chat"
          shortcut="⌘T"
          keyshortcuts="Meta+T"
          onSelect={onNewChat}
        />
        <PaneEmptyRow
          icon={TerminalWindowIcon}
          label="New terminal"
          shortcut="⌥⌘T"
          keyshortcuts="Alt+Meta+T"
          onSelect={onNewTerminal}
        />
        <PaneEmptyRow icon={BrowserIcon} label="New browser" onSelect={onNewBrowser} />
        <PaneEmptyRow
          icon={FileMagnifyingGlassIcon}
          label="Open file…"
          shortcut="⌘P"
          keyshortcuts="Meta+P"
          onSelect={onOpenFile}
        />
        <PaneEmptyRow icon={XIcon} label="Close pane" onSelect={onClosePane} />
      </div>
    </div>
  );
}

function PaneEmptyRow({
  icon: Glyph,
  label,
  shortcut,
  keyshortcuts,
  onSelect,
}: {
  icon: Icon;
  label: string;
  /** The chord this row also answers to, drawn in the trailing slot. */
  shortcut?: string;
  /** The same chord, spelled for AT. */
  keyshortcuts?: string;
  onSelect(): void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      data-slot="pane-empty-row"
      aria-label={label}
      {...(keyshortcuts === undefined ? {} : { "aria-keyshortcuts": keyshortcuts })}
      onClick={onSelect}
      className="w-full justify-start text-ui"
    >
      {/* Outline at 14px: these are five peers, and none of them is the
          exception the fill weight marks (CLAUDE.md). */}
      <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {shortcut === undefined ? null : <span className={MENU_SHORTCUT}>{shortcut}</span>}
    </Button>
  );
}

import {
  BrowserIcon,
  ChatIcon,
  FindFileIcon,
  TerminalIcon,
  CloseIcon,
  type IconComponent as Icon,
} from "@renderer/components/ui/icon";

import { MENU_SHORTCUT } from "@renderer/components/ui/menu-classes";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

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
 * Large shared push buttons: `docs/DESIGN.md`'s `lg` rung, the one it reserves for "rare hero
 * actions (empty states)", which is exactly what these are. The shortcut hint
 * is the menus' own (`MENU_SHORTCUT`) so a chord reads the same here as in the
 * menu that also offers it.
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
          icon={ChatIcon}
          label="New chat"
          shortcut="⌘T"
          keyshortcuts="Meta+T"
          onSelect={onNewChat}
        />
        <PaneEmptyRow
          icon={TerminalIcon}
          label="New terminal"
          shortcut="⌥⌘T"
          keyshortcuts="Alt+Meta+T"
          onSelect={onNewTerminal}
        />
        <PaneEmptyRow icon={BrowserIcon} label="New browser" onSelect={onNewBrowser} />
        <PaneEmptyRow
          icon={FindFileIcon}
          label="Open file…"
          shortcut="⌘P"
          keyshortcuts="Meta+P"
          onSelect={onOpenFile}
        />
        <PaneEmptyRow icon={CloseIcon} label="Close pane" onSelect={onClosePane} close />
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
  close = false,
}: {
  close?: boolean;
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
      size={close ? "default" : "lg"}
      // The row a `⌘\` pane hands keyboard focus to — see
      // `hooks/use-split-shortcuts.ts` for why a keyboard split moves focus
      // when a pointer one deliberately does not.
      data-slot="pane-empty-row"
      // Explicit, so the trailing chord is not read as part of the name.
      aria-label={label}
      {...(keyshortcuts === undefined ? {} : { "aria-keyshortcuts": keyshortcuts })}
      onClick={onSelect}
      className={cn(
        "w-full justify-start rounded-row px-2 text-ui hover:bg-(--accent-tint)",
        close && "mt-2 text-muted-foreground",
      )}
    >
      {/* Shared outline family; the close acts on the pane rather than filling it. */}
      <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {shortcut === undefined ? null : <span className={MENU_SHORTCUT}>{shortcut}</span>}
    </Button>
  );
}

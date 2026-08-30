import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { FileMagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/FileMagnifyingGlass";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Icon } from "@phosphor-icons/react";

import { MENU_SHORTCUT } from "@renderer/components/ui/menu-classes";
import { cn } from "@renderer/lib/utils";

/**
 * WHAT AN EMPTY PANE OFFERS (VC-202 §3).
 *
 * A pane opened by `⌘\` holds nothing, and the honest thing to put in it is the
 * list of surfaces it could hold — the same list Codex draws in its own empty
 * pane, and the same three verbs this app already answers to from anywhere.
 *
 * NO PROSE. There is no heading, no "drag a tab here", no explanation of what a
 * split is: the rows are verbs and the chords beside them are the same chords
 * that work while this pane has focus, so the menu teaches itself by being
 * redundant (CLAUDE.md, "let controls talk"). Every row is reachable two ways
 * on purpose — the chord is the fast path for the second time, the row is the
 * discoverable one for the first.
 *
 * The rows do not carry pane plumbing either. `⌘T` and `⌥⌘T` start a Session on
 * the surface and `⌘P` previews a file on it; each lands HERE because an empty
 * pane is by definition the focused pane and every "make this tab active" write
 * runs through the split view's own write-through (`split-view.ts`'s
 * `activateTab`). Close pane is the one row that is about the pane itself.
 *
 * 32px rows: `docs/DESIGN.md`'s `lg` rung, the one it reserves for "rare hero
 * actions (empty states)", which is exactly what these are. The shortcut hint
 * is the menus' own (`MENU_SHORTCUT`) so a chord reads the same here as in the
 * menu that also offers it.
 */
export interface PaneEmptyStateProps {
  onNewChat(): void;
  onNewTerminal(): void;
  /** Opens quick-open (⌘P); the file it previews lands in this pane. */
  onOpenFile(): void;
  onClosePane(): void;
}

export function PaneEmptyState({
  onNewChat,
  onNewTerminal,
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
    <button
      type="button"
      // The row a `⌘\` pane hands keyboard focus to — see
      // `hooks/use-split-shortcuts.ts` for why a keyboard split moves focus
      // when a pointer one deliberately does not.
      data-slot="pane-empty-row"
      // Explicit, so the trailing chord is not read as part of the name.
      aria-label={label}
      {...(keyshortcuts === undefined ? {} : { "aria-keyshortcuts": keyshortcuts })}
      onClick={onSelect}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-ui text-foreground outline-none",
        // Colour on hover, and the house press feedback: a row that does not
        // move under the finger reads as a label rather than a control
        // (`ui/button.tsx` documents the scale and its reduced-motion cancel).
        "transition-[color,background-color,scale] duration-150 ease-out",
        "hover:bg-accent/50 active:scale-[0.97] active:bg-accent/70",
        "motion-reduce:transition-[color,background-color] motion-reduce:scale-100!",
        "focus-visible:ring-2 focus-visible:ring-ring/45",
      )}
    >
      {/* Outline at 14px: these are four peers, and none of them is the
          exception the fill weight marks (CLAUDE.md). */}
      <Glyph aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {shortcut === undefined ? null : <span className={MENU_SHORTCUT}>{shortcut}</span>}
    </button>
  );
}

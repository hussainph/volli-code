/**
 * Starting a Session — one control, wherever one is offered.
 *
 * A split button: `[ + Chat │ ▾ ]`. The press starts a chat, the caret admits
 * the exception exists, and right-click reaches the same two items wherever the
 * caret happens to be drawn. It replaces the two shapes this app used to have
 * for one job — a two-button Chat/Terminal cluster in the ticket surfaces and a
 * bare "+" menu on the Sessions strip — which cost the ticket a peer it does not
 * have and cost Sessions a click on the act it exists for.
 *
 * The asymmetry it draws is one the code already has and neither shipped drawing
 * expressed: `@volli/agent-runtime` is the one structured executor, and a
 * terminal is an explicit manual companion, never a silent structured fallback
 * (CLAUDE.md). A split says exactly that — the default is a press, the companion
 * is a press plus something — where two identical ghost icon buttons say the
 * opposite.
 *
 * The word earns its width twice over: it is what a first-run user reads, and a
 * labelled target is a BIGGER target, so Fitts pays for it again at the
 * hundredth use.
 *
 * Motion is CSS and compositor-only (transform/opacity/color), interruptible
 * because a transition restarts from the computed value, and given overshoot
 * nowhere — none of these presses carries momentum.
 */
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import { Button } from "@renderer/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { cn } from "@renderer/lib/utils";

/** The chord each kind announces in a menu's trailing slot. */
const CHORD = { chat: "⌘T", terminal: "⌥⌘T" } as const;

/**
 * Which room the control is in. One axis, not three — every value is a real
 * place, and bundling scale, emphasis and label keeps a caller from inventing a
 * combination nobody drew.
 */
export type NewSessionPlacement = "strip" | "rail" | "empty";

/** Pill scale, emphasis and label per room. */
const DRAWING = {
  // A tab strip: h-6 beside h-7/h-8 tabs, ghost so the tabs stay the loud thing.
  strip: { size: "sm", caret: "icon-sm", variant: "ghost", label: "Chat" },
  // The 300px ticket rail's Sessions header: one step down, level with a
  // text-label heading.
  rail: { size: "xs", caret: "icon-xs", variant: "ghost", label: "Chat" },
  // The only affordance on an empty surface, so it is solid and says what it
  // does rather than naming a kind among tabs that no longer exist.
  empty: { size: "sm", caret: "icon-sm", variant: "default", label: "New chat" },
} as const satisfies Record<
  NewSessionPlacement,
  { size: "sm" | "xs"; caret: "icon-sm" | "icon-xs"; variant: "ghost" | "default"; label: string }
>;

export function NewSessionControl({
  disabled,
  placement = "strip",
  align = "start",
  shortcuts = false,
  className,
  onNewChat,
  onNewTerminal,
}: {
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
   * the chord mints a ticket Session; the Sessions strip announces them because
   * on that page it mints a ticketless one. The flag survives rather than
   * becoming a constant because "a menu may only advertise a key that does what
   * the item does" is the rule, not "everything advertises": a control that ever
   * appears somewhere the chord resolves elsewhere must be able to stay quiet.
   */
  shortcuts?: boolean;
  className?: string;
  onNewChat(): void;
  onNewTerminal(): void;
}) {
  const drawing = DRAWING[placement];

  const items = (
    <>
      <DropdownMenuItem onSelect={onNewChat}>
        <ChatCircleIcon />
        Chat
        {shortcuts ? <DropdownMenuShortcut>{CHORD.chat}</DropdownMenuShortcut> : null}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onNewTerminal}>
        <TerminalWindowIcon />
        Terminal
        {shortcuts ? <DropdownMenuShortcut>{CHORD.terminal}</DropdownMenuShortcut> : null}
      </DropdownMenuItem>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* The press-scale sits on the WRAPPER, not on each half: `:active`
            matches an ancestor of the pressed element, so the whole pill
            depresses as one object. Halves scaling independently would open a
            seam mid-press, which reads as two buttons that happen to touch —
            the exact thing this shape is trying not to be. Disabled dims here
            too (and the halves cancel their own `disabled:opacity-50`, which
            would otherwise multiply into an unreadable 25%). */}
        <div
          className={cn(
            "inline-flex shrink-0 items-center rounded-full transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transform-none",
            disabled && "pointer-events-none opacity-50",
            className,
          )}
        >
          <Button
            type="button"
            variant={drawing.variant}
            size={drawing.size}
            disabled={disabled}
            aria-label="New chat"
            {...(shortcuts ? { "aria-keyshortcuts": "Meta+T" } : {})}
            onClick={onNewChat}
            className="rounded-r-none pr-1.5 active:scale-100 disabled:opacity-100"
          >
            {/* Outline, the baseline. The Button's own size rule draws this at
                14px in `strip`/`empty`, above CLAUDE.md's ≤12px small-size tier
                — and a weight step that only half its rooms earn is not a step.
                The caret below is `size-3` in every room, so it keeps bold. */}
            <PlusIcon />
            {drawing.label}
          </Button>
          <span aria-hidden className="h-3 w-px bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant={drawing.variant}
                size={drawing.caret}
                disabled={disabled}
                aria-label="Other session kinds"
                // Narrower than a stock icon button: this segment holds one
                // 12px caret and exists to be SEEN, not aimed at — the whole
                // menu is also on right-click, so a tab strip pays the smallest
                // width that still says "there is another kind".
                className="group w-4! rounded-l-none px-0 active:scale-100 disabled:opacity-100"
              >
                <CaretDownIcon
                  weight="bold"
                  className="size-3 transition-transform duration-150 ease-out group-data-[state=open]:rotate-180 motion-reduce:transform-none"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={align}>{items}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      {/* The same two items on right-click, so turning to the caret is a
          convenience and never the only route. */}
      <ContextMenuContent>
        <ContextMenuItem icon={ChatCircleIcon} onSelect={onNewChat}>
          Chat
          {shortcuts ? <ContextMenuShortcut>{CHORD.chat}</ContextMenuShortcut> : null}
        </ContextMenuItem>
        <ContextMenuItem icon={TerminalWindowIcon} onSelect={onNewTerminal}>
          Terminal
          {shortcuts ? <ContextMenuShortcut>{CHORD.terminal}</ContextMenuShortcut> : null}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

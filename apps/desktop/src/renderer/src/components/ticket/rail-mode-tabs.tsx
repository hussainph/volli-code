/**
 * The rail's page switcher — one object, drawn by both rails.
 *
 * The ticket rail (decision #46) and Home's rail (VC-55) are the same panel at
 * two scopes, so their headers were the same header: a centred pill where only
 * the selected tab wears its label, floating above whichever page is showing.
 * They were also, for one commit, the same seventy lines of code twice — the
 * same spring, the same label pop, the same tooltip suppression, the same
 * roving-tabindex walk, the same class strings. `ui/tab-strip.tsx` was written
 * because three tab strips had drifted apart exactly that way; this is that
 * lesson applied before the drift rather than after it.
 *
 * WHAT STAYS WITH THE CALLER: which pages exist, which is selected, what
 * selecting one means, and the page bodies. This file owns the drawing, the
 * focus mechanics and the motion — nothing else.
 *
 * ONLY THE SELECTED TAB WEARS ITS LABEL, which is what lets four pages fit the
 * pill at the rail's narrowest width without ever truncating a word. The
 * inactive ones are icons, and carry their name in `aria-label` and a tooltip
 * so neither a screen reader nor a pointer has to guess.
 *
 * THE TRACK IS SIZED BY WHAT IT HOLDS, not by a fixed width. It was `w-40` when
 * every rail had exactly three pages, and the arithmetic (one 84px label tab,
 * two 32px glyphs, gaps and padding) happened to land there. Search made it
 * four (VC-193), and a fixed track answers that by SHRINKING its tabs — the
 * selected one first, since it is the widest — which clips the one word the
 * pill exists to show. `w-max` keeps every tab at its own size and lets the
 * pill grow; `max-w-full` keeps it inside a rail dragged to its floor.
 *
 * Translucent and blurred rather than opaque: at `top-0` of a column whose
 * pages scroll beneath it, the bar is a floating material, not a strip the
 * layout gives away.
 *
 * THE SELECTION IS A MOTION LAYOUT ANIMATION, not a width transition. A CSS
 * transition can grow the selected tab, but it cannot make the tabs beside it
 * travel with it — they jump to their new x as soon as the flex row reflows.
 * `layout` measures both frames, so the whole pill rearranges as one object.
 * Arrow-key navigation deliberately opts out (`animateSelection`): a held arrow
 * key walks the tablist faster than a 320ms settle, and an animation that is
 * always mid-flight reads as lag rather than motion. Reduced motion removes
 * both the travel and the crossfade.
 */
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { RAIL_PANEL_INSET } from "@renderer/components/ticket/rail-panel-parts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

/** One page in the pill: the value it selects, its word, and its glyph. */
export interface RailModeTab<K extends string> {
  key: K;
  label: string;
  icon: PhosphorIcon;
}

export interface RailModeTabsProps<K extends string> {
  /** The pages this surface offers, in pill order. */
  modes: readonly RailModeTab<K>[];
  active: K;
  /**
   * The tablist's accessible name. Not optional: a ticket screen draws a second
   * tablist (its own tab strip) on the same frame, so an unnamed one leaves
   * both AT and every `getByRole("tablist")` query with no way to say which.
   */
  label: string;
  /**
   * Spells `${idPrefix}-tab-${key}` and `${idPrefix}-page-${key}` — the aria
   * wiring and the test ids both rails already use. The caller puts the same
   * `-page-` id on the `<section>` each tab controls.
   */
  idPrefix: string;
  onSelect(next: K): void;
}

export function RailModeTabs<K extends string>({
  modes,
  active,
  label,
  idPrefix,
  onSelect,
}: RailModeTabsProps<K>) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [animateSelection, setAnimateSelection] = React.useState(true);
  const reducedMotion = useReducedMotion() ?? false;
  const animated = animateSelection && !reducedMotion;

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? modes.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length;
    const nextMode = modes[next];
    if (nextMode === undefined) return;
    setAnimateSelection(false);
    onSelect(nextMode.key);
    refs.current[next]?.focus();
  }

  return (
    <div
      className={cn(
        "sticky top-0 z-20 shrink-0 bg-sidebar/70 pt-4 pb-4 backdrop-blur-xl",
        RAIL_PANEL_INSET,
      )}
    >
      <div
        role="tablist"
        aria-label={label}
        // No height of its own: the `h-8` tabs inside it plus `p-1` ARE the
        // height (40px), so the track can never disagree with what it holds.
        className="mx-auto flex w-max max-w-full items-center gap-1 rounded-full border border-sidebar-border bg-background/70 p-1 shadow-raised"
      >
        {modes.map((mode, index) => {
          const Icon = mode.icon;
          const selected = mode.key === active;
          const tab = (
            <motion.button
              layout={animated}
              transition={
                animated ? { type: "spring", duration: 0.32, bounce: 0.1 } : { duration: 0 }
              }
              key={mode.key}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${mode.key}`}
              aria-controls={`${idPrefix}-page-${mode.key}`}
              aria-selected={selected}
              aria-label={mode.label}
              tabIndex={selected ? 0 : -1}
              data-testid={`${idPrefix}-tab-${mode.key}`}
              onClick={() => {
                setAnimateSelection(true);
                onSelect(mode.key);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex h-8 items-center justify-center gap-1 overflow-hidden rounded-full text-ui outline-none",
                selected ? "w-[84px]" : "w-8",
                // `scale-100!` is the press's reduced-motion cancel: dropping
                // the transition below only made the depress instant, it never
                // removed it, and `transform-none` could not have — see the
                // press note in `ui/button.tsx`.
                "focus-visible:ring-2 focus-visible:ring-ring/45 active:scale-[0.97] motion-reduce:scale-100!",
                !reducedMotion &&
                  "transition-[color,background-color,box-shadow,transform,scale] duration-150 ease-out",
                selected
                  ? "bg-accent text-foreground shadow-raised"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <motion.span layout="position" className="flex shrink-0 items-center">
                <Icon className="size-3.5" />
              </motion.span>
              <AnimatePresence initial={false} mode="popLayout">
                {selected ? (
                  <motion.span
                    key={`${mode.key}-label`}
                    initial={animated ? { opacity: 0, transform: "translateX(-4px)" } : false}
                    animate={{ opacity: 1, transform: "translateX(0)" }}
                    exit={animated ? { opacity: 0, transform: "translateX(3px)" } : { opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0 : 0.14, ease: [0.23, 1, 0.32, 1] }}
                    className="whitespace-nowrap"
                  >
                    {mode.label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </motion.button>
          );
          // The selected tab already wears its name, so its tooltip would only
          // repeat it — `open={false}` keeps the trigger's accessibility wiring
          // without ever showing the bubble.
          return (
            <Tooltip key={mode.key} open={selected ? false : undefined}>
              <TooltipTrigger asChild>{tab}</TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {mode.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

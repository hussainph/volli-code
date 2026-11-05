/** Approved in-page glass pill. Geometry and the activation gate are shared. */
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import type { IconComponent } from "./icon";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "./tooltip";
import { cn } from "@renderer/lib/utils";
export interface ViewSwitcherMotion {
  /** Whether this selection animates at all — the one condition. */
  animated: boolean;
  /** The pill's own rearrangement: a spring, or nothing. */
  transition: { type: "spring"; duration: number; bounce: number } | { duration: number };
  /** The selected label's entrance and exit, in seconds. */
  labelDuration: number;
}

export function viewSwitcherMotion(input: {
  /** False for a keyboard walk: a held arrow key outruns a 320ms settle. */
  animateSelection: boolean;
  /** The reader's setting or their OS's. */
  reducedMotion: boolean;
}): ViewSwitcherMotion {
  const animated = input.animateSelection && !input.reducedMotion;
  return {
    animated,
    transition: animated
      ? {
          type: "spring",
          duration: GLASS_MOTION.inspectorSpringSeconds,
          bounce: GLASS_MOTION.inspectorSpringBounce,
        }
      : { duration: 0 },
    labelDuration: animated ? GLASS_MOTION.inspectorLabelSeconds : 0,
  };
}

/** One page in the pill: the value it selects, its word, and its glyph. */
export interface ViewSwitcherTab<K extends string> {
  key: K;
  label: string;
  icon?: IconComponent;
}

export interface ViewSwitcherProps<K extends string> {
  /** The pages this surface offers, in pill order. */
  modes: readonly ViewSwitcherTab<K>[];
  active: K;
  /**
   * The tablist's accessible name. Not optional: a ticket screen draws a second
   * tablist (its own tab strip) on the same frame, so an unnamed one leaves
   * both AT and every `getByRole("tablist")` query with no way to say which.
   */
  label: string;
  /**
   * Spells `${prefix}-tab-${key}` and `${prefix}-page-${key}` — the aria
   * wiring and the test ids both rails already use. The caller puts the same
   * `-page-` id on the `<section>` each tab controls.
   */
  idPrefix?: string;
  variant?: "selected-label" | "text" | "icon-only";
  className?: string;
  onSelect(next: K): void;
}

export function ViewSwitcher<K extends string>({
  modes,
  active,
  label,
  idPrefix,
  onSelect,
  variant = "selected-label",
  className,
}: ViewSwitcherProps<K>) {
  const generatedId = React.useId();
  const prefix = idPrefix ?? generatedId;
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [animateSelection, setAnimateSelection] = React.useState(true);
  const reducedMotion = useReducedMotion() ?? false;
  const motionPlan = viewSwitcherMotion({ animateSelection, reducedMotion });
  const animated = motionPlan.animated;

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
    <TooltipProvider>
      <div
        data-slot="view-switcher"
        data-variant={variant}
        role="tablist"
        aria-label={label}
        // The gate's one answer, on the DOM: which activation path a selection
        // came through is otherwise only visible in Motion's props, and the
        // defect here was the path, not the plan.
        data-animated={animated}
        // No height of its own: the `h-8` tabs inside it plus `p-1` ARE the
        // height (40px), so the track can never disagree with what it holds.
        className={cn(
          "glass mx-auto flex w-max max-w-full items-center gap-1 rounded-full p-1",
          className,
        )}
      >
        {modes.map((mode, index) => {
          const Icon = mode.icon;
          const selected = mode.key === active;
          const tab = (
            <motion.button
              layout={animated}
              layoutDependency={active}
              transition={motionPlan.transition}
              key={mode.key}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${prefix}-tab-${mode.key}`}
              aria-controls={idPrefix === undefined ? undefined : `${prefix}-page-${mode.key}`}
              aria-selected={selected}
              aria-label={mode.label}
              tabIndex={selected ? 0 : -1}
              data-testid={`${prefix}-tab-${mode.key}`}
              data-choice={mode.key}
              onClick={(event) => {
                setAnimateSelection(event.detail !== 0);
                onSelect(mode.key);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "relative flex h-8 items-center justify-center gap-1 overflow-hidden rounded-full text-ui outline-none",
                variant === "text"
                  ? "w-auto px-3"
                  : variant === "icon-only"
                    ? "w-8"
                    : selected
                      ? "w-[84px]"
                      : "w-8",
                // `scale-100!` is the press's reduced-motion cancel: dropping
                // the transition below only made the depress instant, it never
                // removed it, and `transform-none` could not have — see the
                // press note in `ui/button.tsx`.
                "focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:scale-100!",
                !reducedMotion &&
                  "transition-[color,background-color,transform,scale] duration-(--duration-menu-in) ease-out",
                selected
                  ? "bg-accent text-foreground shadow-raised"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {/* The glyph travels with the label that grows beside it — under
                  the SAME gate as its button, or a keyboard walk keeps one
                  moving part after the pill itself has stopped. */}
              {Icon ? (
                <motion.span
                  layout={animated ? "position" : false}
                  layoutDependency={active}
                  className="flex shrink-0 items-center"
                >
                  <Icon className="size-3.5" />
                </motion.span>
              ) : null}
              <AnimatePresence initial={false} mode="popLayout">
                {variant === "text" || (variant === "selected-label" && selected) ? (
                  <motion.span
                    data-slot="view-switcher-label"
                    key={`${mode.key}-label`}
                    initial={animated ? { opacity: 0, transform: "translateX(-4px)" } : false}
                    animate={{ opacity: 1, transform: "translateX(0)" }}
                    // The EXIT is gated too, and at zero duration it is a cut
                    // rather than a fade: the word of the tab being left has to
                    // be gone by the time the next keystroke lands.
                    exit={animated ? { opacity: 0, transform: "translateX(3px)" } : { opacity: 0 }}
                    transition={{ duration: motionPlan.labelDuration, ease: GLASS_MOTION.easeOut }}
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
            <Tooltip
              key={mode.key}
              open={variant === "text" || (selected && variant !== "icon-only") ? false : undefined}
            >
              <TooltipTrigger asChild>{tab}</TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {mode.label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

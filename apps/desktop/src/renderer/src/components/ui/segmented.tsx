/**
 * The segmented control: a small closed set, all of it on screen, one member
 * selected.
 *
 * Promoted out of `theme/segmented-choice.tsx`, whose own header called the
 * board's view toggle and the diff presentation toggle "the same shape", warned
 * that "three copies of it would be three places for the pressed-state contract
 * to drift", and then extracted only its own two. There were four by the time
 * this file was written, and a fifth in the harness picker that had drifted far
 * enough to be unrecognisable as the same object — raw `<button>`s with
 * `aria-current`, no press, and **no focus ring at all**. That is the tell: a
 * segmented control is a row of buttons, and every hand-rolled row of buttons
 * re-implements the parts of `ui/button.tsx` its author remembered.
 *
 * Re-selecting the active segment is a NO-OP, and that is a contract rather
 * than an optimisation. Each surface's segments mean a different stored write —
 * "Custom" re-entered while already Custom would re-run the entry write and
 * could silently replace what the user had chosen.
 *
 * WHAT IT IS NOT. `orientation` and `shape` are deliberately absent. The audit
 * named a vertical rotation in `pages/settings-shell.tsx`; that is a `<nav>` of
 * `aria-current="page"` category rows with icons and full-width targets — a
 * place you go, not a value you set, and rotating this control would have made
 * it lie about what it does. `shape` was proposed for the two toggles that draw
 * rounded rectangles inside a bordered track; `docs/DESIGN.md` says a control
 * that acts is a pill and bakes that into the button primitive, so a rectangle
 * axis here would be a second control language, not a variant of this one.
 * `stopPropagation` was proposed for the composer's effort segment, which no
 * longer exists — effort is a slider in a popover now (`chat/composer-effort-ui.tsx`),
 * and nothing else in the app puts a segmented control inside a menu item.
 */
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

export function Segmented<Key extends string>({
  ariaLabel,
  testId,
  value,
  options,
  size = "sm",
  iconOnly = false,
  disabled,
  className,
  onChange,
}: {
  ariaLabel: string;
  testId?: string;
  value: Key;
  options: readonly { key: Key; label: string; icon?: PhosphorIcon }[];
  /**
   * The pill scale's two settings rungs (`docs/DESIGN.md`): `sm` where the
   * control trails a section header, `default` where it is the surface's own
   * primary choice and sits at chip height.
   */
  size?: "sm" | "default";
  /**
   * Draw only each option's icon; its label stays as the accessible name.
   * For a segmented control floating ON a picture (the canvas pad's mode
   * choice), where a word would be copy painted over the user's own gradient.
   * Every option must carry an icon — an icon-only segment with no icon would
   * be an unlabeled blank — so this is not the default and never will be.
   */
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
  onChange(key: Key): void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn("flex items-center gap-1", className)}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.key === value;
        return (
          <Button
            key={option.key}
            size={iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size}
            variant={active ? "secondary" : "ghost"}
            aria-pressed={active}
            data-choice={option.key}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(option.key);
            }}
          >
            {Icon ? <Icon /> : null}
            {iconOnly ? <span className="sr-only">{option.label}</span> : option.label}
          </Button>
        );
      })}
    </div>
  );
}

/** Every themeable surface's inherit/override pair, in its section header. */
export const SURFACE_MODES = [
  { key: "inherit", label: "Inherit" },
  { key: "custom", label: "Custom" },
] as const;

export type SurfaceMode = (typeof SURFACE_MODES)[number]["key"];

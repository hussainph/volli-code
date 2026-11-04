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
 * THE DRAWING IS A TRACK AND A THUMB (docs/DESIGN.md, "Surfaces"): a
 * borderless capsule track with the chosen member as a solid capsule — or a
 * circle, icon-only — inside it, and the rest bare until hovered. It is one of
 * the few capsules in the app (`--radius-segmented`), because it is compact
 * chrome rather than a control standing on its own. A row of separately
 * bordered buttons read as a toolbar of actions, which this is not.
 *
 * WHAT IT IS NOT. `orientation` and `shape` are deliberately absent. The audit
 * named a vertical rotation in `pages/settings-shell.tsx`; that is a `<nav>` of
 * `aria-current="page"` category rows with icons and full-width targets — a
 * place you go, not a value you set, and rotating this control would have made
 * it lie about what it does. A `shape` axis would be a second control
 * language, not a variant of this one.
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
  /**
   * The closed set, in order. A member may be `disabled` on its own — the
   * markdown file band needs it (VC-307): Document view is unavailable for a
   * file with raw HTML while Source and Preview beside it are live, and hiding
   * the segment would answer a question the person never got to ask. This is a
   * segment that is not available, not a new axis of the control.
   */
  options: readonly { key: Key; label: string; icon?: PhosphorIcon; disabled?: boolean }[];
  /**
   * The control scale's two settings rungs (`docs/DESIGN.md`): `sm` where the
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
      // `p-0.5`: the track is its rung's height (28px for `sm`, 32 for
      // `default`) around thumbs one rung down — a recorded spacing exception
      // (docs/DESIGN.md).
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-segmented bg-glass-1 p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.key === value;
        return (
          <Button
            key={option.key}
            size={
              iconOnly ? (size === "sm" ? "icon-sm" : "icon") : size === "sm" ? "sm" : "default"
            }
            // The thumb is the solid primary; the rest sit bare on the track.
            variant={active ? "selected" : "ghost"}
            className="rounded-segmented"
            aria-pressed={active}
            title={iconOnly ? option.label : undefined}
            data-choice={option.key}
            disabled={disabled === true || option.disabled === true}
            onClick={() => {
              if (!active) onChange(option.key);
            }}
          >
            {Icon ? <Icon weight={active ? "fill" : "regular"} /> : null}
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

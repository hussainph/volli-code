import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { Button } from "@renderer/components/ui/button";

/**
 * The app's segmented-control idiom (ui/button.tsx's pill scale, same shape as
 * the board's view toggle and the diff presentation toggle), driven by a data
 * array rather than repeated blocks so a third segment is a row, not a branch.
 *
 * Lifted out of `project-appearance-settings.tsx` when the canvas editor arrived:
 * the same control now states a workspace's inherit/override tri-state AND the
 * light/dark/auto choice at both scopes, and three copies of it would be three
 * places for the pressed-state contract to drift.
 *
 * Re-selecting the active segment is a NO-OP. Each surface's "Custom" means a
 * different stored value, so clicking it while already Custom would re-run that
 * surface's entry write and could silently replace what the user had chosen.
 */
export function SegmentedChoice<Key extends string>({
  ariaLabel,
  testId,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  testId: string;
  value: Key;
  options: readonly { key: Key; label: string; icon?: PhosphorIcon }[];
  disabled?: boolean;
  onChange(key: Key): void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className="flex items-center gap-1"
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <Button
            key={option.key}
            size="sm"
            variant={option.key === value ? "secondary" : "ghost"}
            aria-pressed={option.key === value}
            data-choice={option.key}
            disabled={disabled}
            onClick={() => {
              if (option.key !== value) onChange(option.key);
            }}
          >
            {Icon ? <Icon weight="fill" /> : null}
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

/** Every surface's top-level tri-state, in the section header where it reads as the section's own mode. */
export const SURFACE_MODES = [
  { key: "inherit", label: "Inherit" },
  { key: "custom", label: "Custom" },
] as const;

export type SurfaceMode = (typeof SURFACE_MODES)[number]["key"];

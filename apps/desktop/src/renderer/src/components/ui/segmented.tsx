/** A closed choice with one shared sliding thumb; keyboard changes are instant. */
import type { CSSProperties } from "react";
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
  tabIdPrefix,
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
  /** Page navigation retains tab/tabpanel associations and roving keyboard focus. */
  tabIdPrefix?: string;
  onChange(key: Key): void;
}) {
  return (
    <div
      role={tabIdPrefix === undefined ? "group" : "tablist"}
      aria-label={ariaLabel}
      data-testid={testId}
      data-slot="segmented"
      onPointerDown={(event) => {
        event.currentTarget.dataset.pointerMotion = "true";
      }}
      onKeyDown={(event) => {
        event.currentTarget.dataset.pointerMotion = "false";
        if (tabIdPrefix === undefined || disabled) return;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const available = options.filter((option) => !option.disabled);
        const current = available.findIndex((option) => option.key === value);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? available.length - 1
              : (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) %
                available.length;
        const next = available[index];
        if (next === undefined) return;
        onChange(next.key);
        const target = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
        ).find((button) => button.dataset.choice === next.key);
        target?.focus();
      }}
      style={
        {
          "--segment-count": options.length,
          "--segment-index": Math.max(
            0,
            options.findIndex((option) => option.key === value),
          ),
        } as CSSProperties
      }
      className={cn(
        "segmented relative isolate inline-grid grid-flow-col auto-cols-fr items-center p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.key === value;
        return (
          <Button
            key={option.key}
            size={iconOnly ? (size === "sm" ? "icon" : "icon-lg") : size}
            variant="ghost"
            role={tabIdPrefix === undefined ? undefined : "tab"}
            id={tabIdPrefix === undefined ? undefined : `${tabIdPrefix}-tab-${option.key}`}
            aria-controls={
              tabIdPrefix === undefined ? undefined : `${tabIdPrefix}-page-${option.key}`
            }
            aria-selected={tabIdPrefix === undefined ? undefined : active}
            aria-pressed={tabIdPrefix === undefined ? active : undefined}
            aria-label={iconOnly ? option.label : undefined}
            tabIndex={tabIdPrefix === undefined ? undefined : active ? 0 : -1}
            data-testid={tabIdPrefix === undefined ? undefined : `${tabIdPrefix}-tab-${option.key}`}
            title={iconOnly ? option.label : undefined}
            data-choice={option.key}
            disabled={disabled === true || option.disabled === true}
            onClick={(event) => {
              const track = event.currentTarget.parentElement;
              if (track) track.dataset.pointerMotion = String(event.detail !== 0);
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

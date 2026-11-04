import { CARD_SURFACE } from "@renderer/components/ui/surface-classes";
import { cn } from "@renderer/lib/utils";

/**
 * Shared prompt chrome (VC-335): a writing sheet over a tinted control tray.
 * The frame is the card role (docs/DESIGN.md, "Surfaces") — its fill,
 * hairline and radius, flat — and `prompt-surface` is the hook the writing
 * sheet, the forced-colors edge and the layout probe read. Stacked questions and
 * activity retain COMPOSER_STACK_SHELL so decoration never competes with their
 * content.
 */
export const PROMPT_SURFACE = cn("prompt-surface", CARD_SURFACE);

/** A bounded setting rather than another floating word: a glass chip, on the
 * chip role's radius (`--radius-chip`). */
export const COMPOSER_CONFIG_CHIP =
  "prompt-config rounded-chip border border-glass-edge bg-glass-1";

/** The rung every secondary control in a composer's footer wears: 24px. */
export const COMPOSER_CONTROL_SIZE = "sm" as const;
export const COMPOSER_CONTROL_ICON_SIZE = "icon-sm" as const;

/** A 32px send key, distinct from the 24px settings and their pill shape. */
export const COMPOSER_PRIMARY_SIZE = "icon-lg" as const;

/** Small glyphs need the weight step to stand beside the 13px labels. */
export const COMPOSER_GLYPH_WEIGHT = "bold" as const;

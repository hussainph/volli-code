/**
 * Shared prompt chrome (VC-335): a writing sheet over a tinted control tray.
 * The material recipes live in globals.css and derive entirely from theme
 * tokens. Prompt surfaces opt in here; stacked questions and activity retain
 * COMPOSER_STACK_SHELL so decoration never competes with their content.
 */
export const PROMPT_SURFACE =
  "prompt-surface rounded-container border border-transparent shadow-card";

/** A bounded, softly raised setting rather than another floating word. */
export const COMPOSER_CONFIG_CHIP = "prompt-config border border-border/70 bg-card shadow-raised";

/** The rung every secondary control in a composer's footer wears: 24px. */
export const COMPOSER_CONTROL_SIZE = "sm" as const;
export const COMPOSER_CONTROL_ICON_SIZE = "icon-sm" as const;

/** A 32px send key, distinct from the 24px settings and their pill shape. */
export const COMPOSER_PRIMARY_SIZE = "icon-lg" as const;

/** Small glyphs need the weight step to stand beside the 13px labels. */
export const COMPOSER_GLYPH_WEIGHT = "bold" as const;

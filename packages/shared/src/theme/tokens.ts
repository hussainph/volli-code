/**
 * The canonical list of themeable color tokens — the exact custom-property
 * names authored in `apps/desktop/src/renderer/src/globals.css`. The generator
 * (see ./generate.ts) emits precisely this set, so applying a generated theme
 * replaces every color the app draws with and nothing else.
 *
 * This list is the contract between the three halves of the theming engine:
 * the generator produces it, the renderer's application layer writes it onto
 * `document.documentElement`, and the e2e smoke asserts the live DOM against
 * it. Adding a color token to globals.css means adding it here — a token the
 * generator does not emit silently keeps its authored fallback forever.
 *
 * Non-color tokens (`--radius`, the type scale, `--ease-swift`, the layout
 * tokens) are deliberately absent: theming moves color, never geometry or
 * type. That boundary is what makes an unreadable *layout* structurally
 * impossible the way the generator's clamps do for contrast.
 */

/**
 * Every themeable color token, grouped as authored in globals.css. Order is
 * meaningful only for readability — consumers must not depend on it.
 */
export const THEME_TOKEN_NAMES = [
  // Core surfaces, darkest → lightest.
  "--rail",
  "--background",
  "--card",
  "--popover",
  "--secondary",
  "--muted",
  "--accent",
  "--sidebar",
  // Foregrounds solved against their surface for an APCA target.
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
  "--secondary-foreground",
  "--muted-foreground",
  "--accent-foreground",
  "--sidebar-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  // Edges.
  "--border",
  "--border-hover",
  "--border-strong",
  "--input",
  "--sidebar-border",
  // Accent family.
  "--primary",
  "--primary-foreground",
  // The accent again, at the lightness body copy needs. --primary is pinned at
  // the accent's fill lightness, where it reads as text at only Lc 41; this is
  // the same hue and chroma solved to Lc 60 on --background.
  "--primary-text",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
  // Hue-locked semantics (never follow the seed — see the escape list in
  // docs/plans/theming-engine.md § Derived rules).
  "--destructive",
  "--destructive-foreground",
] as const;

/** One themeable color custom-property name. */
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

/**
 * A fully-resolved token set: every {@link ThemeTokenName} mapped to an
 * sRGB hex string (`#rrggbb`, lowercase). The generator's output type and the
 * exact shape the application layer writes to the DOM.
 */
export type ThemeTokens = Record<ThemeTokenName, string>;

/**
 * Tokens whose hue is frozen regardless of the seed. Without this the
 * "destructive" red follows a red seed into indistinguishability from
 * `--primary`, and a green seed makes it read as success.
 */
export const HUE_LOCKED_TOKENS: readonly ThemeTokenName[] = [
  "--destructive",
  "--destructive-foreground",
];

/** Whether `value` names a themeable color token. */
export function isThemeTokenName(value: string): value is ThemeTokenName {
  return (THEME_TOKEN_NAMES as readonly string[]).includes(value);
}

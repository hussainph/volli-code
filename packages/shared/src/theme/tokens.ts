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
  // Core surfaces, darkest → lightest. `--secondary` is gone: it and `--muted`
  // were one rung of the ladder emitted under two names (see `generate.ts`'s
  // LADDER), and a component choosing between two spellings of one hex is
  // choosing arbitrarily. The sites that meant "the quiet fill" say `--muted`.
  "--rail",
  "--background",
  "--card",
  "--popover",
  "--muted",
  "--accent",
  "--sidebar",
  // Foregrounds solved against their surface for an APCA target — and there are
  // three of them, not six. `--popover-foreground`, `--secondary-foreground` and
  // `--accent-foreground` were each `--foreground` under another name: the ink
  // on a popover, on a secondary fill and on a hover wash is the ink on the
  // page, because all four surfaces are rungs of one neutral ladder. A canvas
  // that ever needs a divergent popover ink gets the token back, with the
  // evidence that it diverged.
  "--foreground",
  "--muted-foreground",
  "--sidebar-foreground",
  // Edges: the hairline, and ONE step above it. There were two — `--border-hover`
  // and `--border-strong` — separated by six 8-bit steps in dark and two in
  // light, which is to say by nothing anyone could see, and they did not even
  // agree on their own order: dark ran border → hover → strong away from the
  // background, light ran border → strong → hover. Two names for one rung whose
  // ranking inverted with appearance. One name cannot invert against itself.
  //
  // `--input` was a third: the same ladder rung as `--border`, named for the one
  // component family that happened to draw it. A field's edge is an edge.
  "--border",
  "--border-strong",
  "--sidebar-border",
  // Accent family.
  "--primary",
  "--primary-foreground",
  // The accent again, at the lightness body copy needs. --primary is pinned at
  // the accent's fill lightness, where it reads as text at only Lc 41; this is
  // the same hue and chroma solved to Lc 60 on --background.
  "--primary-text",
  // Equal to `--primary` today and NOT collapsed into it, unlike the aliases
  // above. Those were one value under several names with nothing to tell them
  // apart; this is one value under two names that answer different questions —
  // "what colour is the brand" and "what colour says the keyboard is here". The
  // focus recipe (`ui/field-classes.ts`) names the second job explicitly, and it
  // is the one that would move first if a canvas ever made ember unreadable as a
  // ring. A collapse here would have to be undone to have that argument at all.
  "--ring",
  // Hue-locked semantics (never follow the seed).
  "--destructive",
  "--destructive-foreground",
  "--positive",
  "--positive-foreground",
  "--attention",
  "--attention-foreground",
  "--info",
  "--info-foreground",
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
 *
 * The same argument holds for the three status semantics, and holds harder:
 * "working", "waiting" and "renamed" are only legible as green, amber and blue
 * BECAUSE those hues are conventional, so a status family that followed the
 * canvas would be a status family that says nothing.
 *
 * HUE IS THE ONLY THING LOCKED. All four are solved for lightness and chroma
 * against the surface they are painted on (`generate.ts`'s `solveStatusTokens`),
 * which is what keeps them readable on any canvas and in either appearance.
 * `--destructive` used to be the exception — a frozen `#e5484d` that scored
 * Lc ~35 on the card while its three peers were solved to 65, so a deletion
 * count read quieter than the addition count beside it. Same family, same
 * treatment; only the hue is a decision.
 */
export const HUE_LOCKED_TOKENS: readonly ThemeTokenName[] = [
  "--destructive",
  "--destructive-foreground",
  "--positive",
  "--positive-foreground",
  "--attention",
  "--attention-foreground",
  "--info",
  "--info-foreground",
];

/** Whether `value` names a themeable color token. */
export function isThemeTokenName(value: string): value is ThemeTokenName {
  return (THEME_TOKEN_NAMES as readonly string[]).includes(value);
}

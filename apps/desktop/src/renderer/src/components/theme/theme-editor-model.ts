/**
 * The theme editor's logic, with no React in it — the same split
 * `theme-picker-model.ts` makes, and for the same reason: the decisions worth
 * pinning are the ones about a theme's *identity*, not about inputs.
 *
 * The rule this module exists to enforce is that **built-in themes are
 * immutable**. Editing one produces a copy the user owns, and the shipped theme
 * is left exactly as it was — so the six themes in `theme/catalog.ts` are the
 * same six on every machine, and "reset to Ember" never needs a repair path.
 * That is enforced structurally here rather than by discipline in the view:
 * {@link beginThemeEdit} is the only way into an edit, and it cannot hand back
 * a draft that aliases a theme the user does not own.
 *
 * Pure: no DOM, no store, no persistence.
 */

import { persistedTheme, slugify } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";

/** Grain is an opacity multiplier (#71), so its slider spans the whole of it. */
export const GRAIN_RANGE = { min: 0, max: 1, step: 0.01 } as const;

/** `#rgb` / `#rrggbb`, matching what `hexToRgb` accepts — it THROWS on anything else. */
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** An open edit: what is being changed, what it came from, and whether it is new. */
export interface ThemeDraft {
  /** The theme being edited — always one the user owns. */
  theme: ThemeDefinition;
  /** The theme the editor opened on. Untouched, whatever happens to the draft. */
  source: ThemeDefinition;
  /** True when {@link beginThemeEdit} had to copy, because `source` was not the user's to edit. */
  duplicated: boolean;
  /**
   * The accent the user last chose, kept alive across a re-lock so the
   * disclosure is a disclosure and not a delete key. Never persisted — an
   * accent that is locked IS `null` in the file (#75), and this only decides
   * what unlocking offers next.
   */
  lastAccent: string | null;
}

/** Whether the generator could parse `value` as a color. */
export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

/**
 * What a native `<input type="color">` should show for an authored color.
 *
 * That input accepts `#rrggbb` and NOTHING else: hand it the perfectly legal
 * `#0af` and it silently shows black, so the swatch would contradict the app
 * repainting behind it. Anything still unparseable lands on black here too —
 * but only after the caller has already declined to preview it.
 */
export function swatchColor(value: string): string {
  const trimmed = value.trim();
  if (!isHexColor(trimmed)) return "#000000";
  const digits = trimmed.slice(1).toLowerCase();
  return digits.length === 3 ? `#${digits.replace(/./g, (digit) => digit + digit)}` : `#${digits}`;
}

/** Replaces the draft's theme, leaving everything else about the edit alone. */
function edited(draft: ThemeDraft, theme: ThemeDefinition): ThemeDraft {
  return { ...draft, theme };
}

/**
 * A new seed, or `null` when what the user has typed so far is not yet a color.
 *
 * Rejecting rather than coercing is the point: the caller previews whatever it
 * gets back, and `generateThemeTokens` throws on a half-typed hex — so a field
 * that guessed at `#00aa` would repaint the app from a color nobody asked for,
 * or crash the render.
 */
export function withSeed(draft: ThemeDraft, seed: string): ThemeDraft | null {
  return isHexColor(seed) ? edited(draft, { ...draft.theme, seed }) : null;
}

/** A new unlocked accent, or `null` while the entry isn't a color yet. */
export function withAccent(draft: ThemeDraft, accent: string): ThemeDraft | null {
  if (!isHexColor(accent)) return null;
  return { ...draft, theme: { ...draft.theme, accent }, lastAccent: accent };
}

/**
 * The accent-unlock disclosure (#75): locked, the accent follows the seed's
 * hue; unlocked, it is an independent color.
 *
 * Unlocking opens on the accent the user last had — and failing that on the
 * seed itself, so the app does not lurch to a different accent the instant the
 * disclosure opens. The unlock is an invitation to change the accent, not a
 * change to it.
 */
export function withAccentUnlocked(draft: ThemeDraft, unlocked: boolean): ThemeDraft {
  if (!unlocked) {
    return {
      ...draft,
      theme: { ...draft.theme, accent: null },
      lastAccent: draft.theme.accent ?? draft.lastAccent,
    };
  }
  const accent = draft.theme.accent ?? draft.lastAccent ?? draft.theme.seed;
  return { ...draft, theme: { ...draft.theme, accent }, lastAccent: accent };
}

/** A new grain multiplier, clamped to {@link GRAIN_RANGE}. */
export function withGrain(draft: ThemeDraft, grain: number): ThemeDraft {
  const clamped = Math.min(GRAIN_RANGE.max, Math.max(GRAIN_RANGE.min, grain));
  return edited(draft, { ...draft.theme, grain: clamped });
}

/**
 * A new display name. The slug does NOT follow it: the slug is the theme's
 * identity — its file name, and what a project override points at — so a rename
 * that moved it would orphan every reference. (It is also why there is no
 * rename IPC verb: renaming is an ordinary save.)
 */
export function withName(draft: ThemeDraft, name: string): ThemeDraft {
  return edited(draft, { ...draft.theme, name });
}

export interface ThemeEditInput {
  /** The theme the editor was opened on. */
  source: ThemeDefinition;
  /** The user's own themes — the only ones editable in place. */
  owned: readonly ThemeDefinition[];
  /** Every theme the picker lists, so a new slug can collide with none of them. */
  catalog: readonly ThemeDefinition[];
}

/**
 * Opens an edit on `source`, duplicating first when it is not the user's.
 *
 * The duplicate is silent and immediate rather than a confirmation prompt: the
 * user asked to change a color, and "you can't, here's a dialog" is a worse
 * answer than handing them the copy they were going to have to make anyway.
 * The view says which it did — `duplicated` is what it reads off.
 */
export function beginThemeEdit({ source, owned, catalog }: ThemeEditInput): ThemeDraft {
  const mine = owned.some((theme) => theme.slug === source.slug);
  const theme = mine ? persistedTheme(source) : duplicateTheme(source, catalog);
  return { theme, source, duplicated: !mine, lastAccent: source.accent };
}

/**
 * A copy of `source` under a name and slug nothing in `catalog` uses.
 *
 * Built through `persistedTheme`, so the copy shares no nested object with the
 * theme it came from — a duplicate that aliased the built-in's `overrides` map
 * would let an edit reach back into the catalog entry it was made to protect.
 */
export function duplicateTheme(
  source: ThemeDefinition,
  catalog: readonly ThemeDefinition[],
): ThemeDefinition {
  const taken = new Set(catalog.map((theme) => theme.slug));
  const base = `${source.name} Copy`;
  // Counts on the SLUG, not the name: the slug is the identity, and two names
  // that differ only in punctuation slugify to the same file.
  let name = base;
  for (let n = 2; taken.has(slugify(name)); n += 1) name = `${base} ${n}`;
  return { ...persistedTheme(source), name, slug: slugify(name) };
}

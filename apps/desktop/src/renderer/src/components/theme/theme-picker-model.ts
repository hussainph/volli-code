/**
 * The theme picker's logic, with no React in it (decision #73 describes ONE
 * picker used from Settings, a project's Configure, and ⌘K — so the part worth
 * getting right is the part all three share).
 *
 * The one design call worth stating: **tags are derived, never authored.** A
 * hand-maintained tag table is a second source of truth that rots the moment
 * someone edits a seed, and it cannot describe a theme the user made. Both
 * chips come off the theme's own values — `appearance` verbatim, and the hue
 * family measured in OKLCH — so a custom theme is tagged as well as a shipped
 * one, for free.
 *
 * Pure: no DOM, no store, no persistence. Ordering and filtering are decided
 * here; applying and remembering are the store's job.
 */

import { hexToOklch } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";

/** How many themes the Recent group shows before it stops being "recent". */
export const MAX_RECENT_THEMES = 5;

/**
 * Below this chroma a seed carries no usable hue — the generator itself takes
 * the achromatic path at the same threshold, so "neutral" here means exactly
 * what neutral means in the rendered theme.
 */
const NEUTRAL_CHROMA = 0.02;

/**
 * Warm hue arcs in OKLCH: reds through oranges and yellows (0°–120°), plus the
 * magentas that wrap back round (330°–360°). Everything between — greens,
 * cyans, blues, violets — reads cool.
 */
function isWarmHue(hue: number): boolean {
  const h = ((hue % 360) + 360) % 360;
  return h < 120 || h >= 330;
}

/** The three families a theme can belong to. */
export type ThemeHueFamily = "warm" | "cool" | "neutral";

/**
 * The family a theme belongs to, measured from the color it actually shows.
 * The accent wins when it has been unlocked (#75), because "cool grey chrome
 * with a warm accent" is a warm theme to everyone who looks at it.
 */
export function themeHueFamily(theme: ThemeDefinition): ThemeHueFamily {
  const { C, h } = hexToOklch(theme.accent ?? theme.seed);
  if (C < NEUTRAL_CHROMA) return "neutral";
  return isWarmHue(h) ? "warm" : "cool";
}

/** A semantic chip shown on a picker row (and searchable — see {@link buildThemePickerGroups}). */
export interface ThemeTag {
  kind: "appearance" | "hue";
  label: string;
}

const HUE_LABELS: Record<ThemeHueFamily, string> = {
  warm: "Warm",
  cool: "Cool",
  neutral: "Neutral",
};

/** Both derived chips for a theme: what it is, and what it feels like. */
export function deriveThemeTags(theme: ThemeDefinition): ThemeTag[] {
  return [
    { kind: "appearance", label: theme.appearance === "light" ? "Light" : "Dark" },
    { kind: "hue", label: HUE_LABELS[themeHueFamily(theme)] },
  ];
}

/** The three sections, in the order #73 pins them. */
export type ThemePickerGroupKey = "favorites" | "recent" | "all";

/** One rendered row. The same theme can appear in two groups, hence `key`. */
export interface ThemePickerRow {
  /** Unique across the whole list — safe as a React key and as a cmdk item value. */
  key: string;
  theme: ThemeDefinition;
  favorite: boolean;
  tags: ThemeTag[];
}

export interface ThemePickerGroup {
  key: ThemePickerGroupKey;
  label: string;
  rows: ThemePickerRow[];
}

export interface ThemePickerInput {
  /** The catalog, in presentation order — All renders it verbatim. */
  themes: readonly ThemeDefinition[];
  /** Favorited slugs; order here is ignored, so Favorites stays as stable as the catalog. */
  favorites: readonly string[];
  /** Recently applied slugs, most recent first. */
  recents: readonly string[];
  query: string;
  /** Overridable for tests; defaults to {@link MAX_RECENT_THEMES}. */
  recentLimit?: number;
}

const GROUP_LABELS: Record<ThemePickerGroupKey, string> = {
  favorites: "Favorites",
  recent: "Recent",
  all: "All themes",
};

/** Everything a query can match: the name, the slug, both derived chips, and the seed. */
function haystack(theme: ThemeDefinition, tags: readonly ThemeTag[]): string {
  return [theme.name, theme.slug, theme.seed, ...tags.map((tag) => tag.label)]
    .join(" ")
    .toLowerCase();
}

/** Every whitespace-separated term must match — typing narrows, never widens. */
function matches(query: string, text: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => text.includes(term));
}

/**
 * Builds the grouped, filtered list.
 *
 * Favorites and Recent are *pins*, not partitions: a pinned theme still appears
 * under All, so the full catalog is always browsable in one predictable order
 * and nothing goes missing because you starred it. Recent excludes favorites
 * for the opposite reason — a theme pinned twice in a row is noise, not
 * emphasis. Empty groups are dropped rather than rendered as bare headings.
 */
export function buildThemePickerGroups({
  themes,
  favorites,
  recents,
  query,
  recentLimit = MAX_RECENT_THEMES,
}: ThemePickerInput): ThemePickerGroup[] {
  const favoriteSlugs = new Set(favorites);
  const bySlug = new Map(themes.map((theme) => [theme.slug, theme]));

  const row = (groupKey: ThemePickerGroupKey, theme: ThemeDefinition): ThemePickerRow => ({
    key: `${groupKey}:${theme.slug}`,
    theme,
    favorite: favoriteSlugs.has(theme.slug),
    tags: deriveThemeTags(theme),
  });

  const favoriteThemes = themes.filter((theme) => favoriteSlugs.has(theme.slug));
  const recentThemes = recents
    .filter((slug) => !favoriteSlugs.has(slug))
    .map((slug) => bySlug.get(slug))
    .filter((theme): theme is ThemeDefinition => theme !== undefined)
    .slice(0, recentLimit);

  const groups: ThemePickerGroup[] = [
    {
      key: "favorites",
      label: GROUP_LABELS.favorites,
      rows: favoriteThemes.map((t) => row("favorites", t)),
    },
    { key: "recent", label: GROUP_LABELS.recent, rows: recentThemes.map((t) => row("recent", t)) },
    { key: "all", label: GROUP_LABELS.all, rows: themes.map((t) => row("all", t)) },
  ];

  return groups
    .map((group) => ({
      key: group.key,
      label: group.label,
      rows: group.rows.filter((entry) => matches(query, haystack(entry.theme, entry.tags))),
    }))
    .filter((group) => group.rows.length > 0);
}

/** The theme a row key names — how a moving selection turns into a live preview. */
export function themeForRowKey(
  groups: readonly ThemePickerGroup[],
  key: string,
): ThemeDefinition | undefined {
  for (const group of groups) {
    const found = group.rows.find((row) => row.key === key);
    if (found !== undefined) return found.theme;
  }
  return undefined;
}

/** Star / unstar, without duplicating an already-favorited slug. */
export function toggleFavoriteTheme(favorites: readonly string[], slug: string): string[] {
  return favorites.includes(slug)
    ? favorites.filter((entry) => entry !== slug)
    : [...favorites, slug];
}

/** Records an applied theme as the most recent one, deduped and capped. */
export function noteRecentTheme(
  recents: readonly string[],
  slug: string,
  limit = MAX_RECENT_THEMES,
): string[] {
  return [slug, ...recents.filter((entry) => entry !== slug)].slice(0, limit);
}

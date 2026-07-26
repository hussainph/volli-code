/**
 * Shipped Monaco/shiki editor theme catalog.
 *
 * Themes are static `@shikijs/themes/<id>` imports so the bundler inlines them
 * (same pattern as `shiki-langs.ts`). Pass every importer into
 * `bootstrapShikiMonaco({ themes })` before the single `shikiToMonaco` call.
 */

import type { DynamicImportThemeRegistration, ThemeInput } from "shiki";

export interface EditorThemeEntry {
  id: string;
  label: string;
  family?: string;
}

/** Static ES-module importer for a catalog theme id. */
export type EditorThemeImporter = DynamicImportThemeRegistration;

interface EditorThemeDefinition extends EditorThemeEntry {
  load: EditorThemeImporter;
}

/**
 * Single source of truth: metadata + static importer per theme.
 * Keep `apps/desktop/scripts/generate-editor-theme-notices.mjs` in sync.
 */
const EDITOR_THEMES: readonly EditorThemeDefinition[] = [
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    family: "Catppuccin",
    load: () => import("@shikijs/themes/catppuccin-mocha"),
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    family: "Catppuccin",
    load: () => import("@shikijs/themes/catppuccin-macchiato"),
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    family: "Catppuccin",
    load: () => import("@shikijs/themes/catppuccin-frappe"),
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    family: "Tokyo Night",
    load: () => import("@shikijs/themes/tokyo-night"),
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    family: "Rosé Pine",
    load: () => import("@shikijs/themes/rose-pine"),
  },
  {
    id: "rose-pine-moon",
    label: "Rosé Pine Moon",
    family: "Rosé Pine",
    load: () => import("@shikijs/themes/rose-pine-moon"),
  },
  {
    id: "nord",
    label: "Nord",
    family: "Nord",
    load: () => import("@shikijs/themes/nord"),
  },
  {
    id: "gruvbox-dark-medium",
    label: "Gruvbox Dark Medium",
    family: "Gruvbox",
    load: () => import("@shikijs/themes/gruvbox-dark-medium"),
  },
  {
    id: "dracula",
    label: "Dracula",
    family: "Dracula",
    load: () => import("@shikijs/themes/dracula"),
  },
  {
    id: "one-dark-pro",
    label: "One Dark Pro",
    family: "One Dark",
    load: () => import("@shikijs/themes/one-dark-pro"),
  },
  {
    id: "ayu-dark",
    label: "Ayu Dark",
    family: "Ayu",
    load: () => import("@shikijs/themes/ayu-dark"),
  },
  {
    id: "ayu-mirage",
    label: "Ayu Mirage",
    family: "Ayu",
    load: () => import("@shikijs/themes/ayu-mirage"),
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    family: "Solarized",
    load: () => import("@shikijs/themes/solarized-dark"),
  },
  {
    id: "night-owl",
    label: "Night Owl",
    family: "Night Owl",
    load: () => import("@shikijs/themes/night-owl"),
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    family: "GitHub",
    load: () => import("@shikijs/themes/github-dark"),
  },
  {
    id: "vitesse-dark",
    label: "Vitesse Dark",
    family: "Vitesse",
    load: () => import("@shikijs/themes/vitesse-dark"),
  },
  {
    id: "everforest-dark",
    label: "Everforest Dark",
    family: "Everforest",
    load: () => import("@shikijs/themes/everforest-dark"),
  },
  {
    id: "kanagawa-wave",
    label: "Kanagawa Wave",
    family: "Kanagawa",
    load: () => import("@shikijs/themes/kanagawa-wave"),
  },
  {
    id: "kanagawa-dragon",
    label: "Kanagawa Dragon",
    family: "Kanagawa",
    load: () => import("@shikijs/themes/kanagawa-dragon"),
  },
  {
    id: "monokai",
    label: "Monokai",
    family: "Monokai",
    load: () => import("@shikijs/themes/monokai"),
  },
  {
    id: "dark-plus",
    label: "Dark+",
    family: "VS Code",
    load: () => import("@shikijs/themes/dark-plus"),
  },
  {
    id: "material-theme-palenight",
    label: "Material Theme Palenight",
    family: "Material",
    load: () => import("@shikijs/themes/material-theme-palenight"),
  },
];

/** Fallback when the app theme slug is unknown or unset. */
export const DEFAULT_EDITOR_THEME_ID = "one-dark-pro";

/**
 * App-surface theme slug → closest popular shiki catalog id.
 * Unknown custom slugs fall through to `DEFAULT_EDITOR_THEME_ID`.
 */
const APP_SLUG_TO_EDITOR_THEME: Readonly<Record<string, string>> = {
  ember: "one-dark-pro",
  midnight: "tokyo-night",
  moss: "everforest-dark",
  iris: "catppuccin-mocha",
  rose: "rose-pine",
  graphite: "github-dark",
};

const CATALOG_IDS = new Set(EDITOR_THEMES.map((theme) => theme.id));

/** Every shipped editor theme for pickers and bootstrap. */
export function listEditorThemes(): EditorThemeEntry[] {
  return EDITOR_THEMES.map(({ id, label, family }) => ({ id, label, family }));
}

/**
 * Every static `@shikijs/themes` importer for the catalog.
 * Pass into `bootstrapShikiMonaco` before `shikiToMonaco` so themeMap populates.
 */
export function allEditorThemeImporters(): ThemeInput[] {
  return EDITOR_THEMES.map((theme) => theme.load);
}

/**
 * Resolve the Monaco/shiki theme id to apply.
 * Explicit `editorThemeId` wins when it is in the catalog; otherwise map from
 * the active app theme slug (unknown → ember default).
 */
export function resolveEditorThemeId(input: {
  editorThemeId: string | null | undefined;
  appThemeSlug: string | null | undefined;
}): string {
  const explicit = input.editorThemeId;
  if (typeof explicit === "string" && explicit.length > 0 && CATALOG_IDS.has(explicit)) {
    return explicit;
  }

  const slug = input.appThemeSlug ?? "";
  return APP_SLUG_TO_EDITOR_THEME[slug] ?? DEFAULT_EDITOR_THEME_ID;
}

/** Map a Volli app theme slug to its default editor theme (null → ember default). */
export function editorThemeIdForAppSlug(appThemeSlug: string | null | undefined): string {
  return resolveEditorThemeId({ editorThemeId: null, appThemeSlug });
}

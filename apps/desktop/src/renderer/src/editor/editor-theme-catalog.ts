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

const EDITOR_THEMES: readonly EditorThemeEntry[] = [
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", family: "Catppuccin" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", family: "Catppuccin" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", family: "Catppuccin" },
  { id: "tokyo-night", label: "Tokyo Night", family: "Tokyo Night" },
  { id: "rose-pine", label: "Rosé Pine", family: "Rosé Pine" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon", family: "Rosé Pine" },
  { id: "nord", label: "Nord", family: "Nord" },
  { id: "gruvbox-dark-medium", label: "Gruvbox Dark Medium", family: "Gruvbox" },
  { id: "dracula", label: "Dracula", family: "Dracula" },
  { id: "one-dark-pro", label: "One Dark Pro", family: "One Dark" },
  { id: "ayu-dark", label: "Ayu Dark", family: "Ayu" },
  { id: "ayu-mirage", label: "Ayu Mirage", family: "Ayu" },
  { id: "solarized-dark", label: "Solarized Dark", family: "Solarized" },
  { id: "night-owl", label: "Night Owl", family: "Night Owl" },
  { id: "github-dark", label: "GitHub Dark", family: "GitHub" },
  { id: "vitesse-dark", label: "Vitesse Dark", family: "Vitesse" },
  { id: "everforest-dark", label: "Everforest Dark", family: "Everforest" },
  { id: "kanagawa-wave", label: "Kanagawa Wave", family: "Kanagawa" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", family: "Kanagawa" },
  { id: "monokai", label: "Monokai", family: "Monokai" },
  { id: "dark-plus", label: "Dark+", family: "VS Code" },
  { id: "material-theme-palenight", label: "Material Theme Palenight", family: "Material" },
];

/**
 * Bundler-resolved importers keyed by catalog id. Keys must stay in lockstep
 * with `EDITOR_THEMES` — tests assert every catalog id has an importer.
 */
const EDITOR_THEME_IMPORTS: Readonly<Record<string, EditorThemeImporter>> = {
  "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
  "catppuccin-macchiato": () => import("@shikijs/themes/catppuccin-macchiato"),
  "catppuccin-frappe": () => import("@shikijs/themes/catppuccin-frappe"),
  "tokyo-night": () => import("@shikijs/themes/tokyo-night"),
  "rose-pine": () => import("@shikijs/themes/rose-pine"),
  "rose-pine-moon": () => import("@shikijs/themes/rose-pine-moon"),
  nord: () => import("@shikijs/themes/nord"),
  "gruvbox-dark-medium": () => import("@shikijs/themes/gruvbox-dark-medium"),
  dracula: () => import("@shikijs/themes/dracula"),
  "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
  "ayu-dark": () => import("@shikijs/themes/ayu-dark"),
  "ayu-mirage": () => import("@shikijs/themes/ayu-mirage"),
  "solarized-dark": () => import("@shikijs/themes/solarized-dark"),
  "night-owl": () => import("@shikijs/themes/night-owl"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
  "vitesse-dark": () => import("@shikijs/themes/vitesse-dark"),
  "everforest-dark": () => import("@shikijs/themes/everforest-dark"),
  "kanagawa-wave": () => import("@shikijs/themes/kanagawa-wave"),
  "kanagawa-dragon": () => import("@shikijs/themes/kanagawa-dragon"),
  monokai: () => import("@shikijs/themes/monokai"),
  "dark-plus": () => import("@shikijs/themes/dark-plus"),
  "material-theme-palenight": () => import("@shikijs/themes/material-theme-palenight"),
};

/** Every shipped editor theme for pickers and bootstrap. */
export function listEditorThemes(): EditorThemeEntry[] {
  return EDITOR_THEMES.map((theme) => ({ ...theme }));
}

/**
 * Every static `@shikijs/themes` importer for the catalog.
 * Pass into `bootstrapShikiMonaco` before `shikiToMonaco` so themeMap populates.
 */
export function allEditorThemeImporters(): ThemeInput[] {
  return EDITOR_THEMES.map((theme) => {
    const load = EDITOR_THEME_IMPORTS[theme.id];
    if (load === undefined) {
      throw new Error(`Missing @shikijs/themes importer for catalog id ${theme.id}`);
    }
    return load;
  });
}

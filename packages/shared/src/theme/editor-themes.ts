/**
 * Shipped Monaco/shiki editor theme catalog ids — the IPC-safe vocabulary for
 * `editorThemeId`. Renderer catalog metadata (labels, static importers) lives
 * in `apps/desktop/.../editor-theme-catalog.ts` and must assert the same set
 * so the guard and the picker cannot drift.
 *
 * Pure: string ids only, no shiki / Electron / DOM imports.
 */

/** Every catalog id Volli ships and will accept over IPC. */
export const SHIPPED_EDITOR_THEME_IDS = [
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "tokyo-night",
  "rose-pine",
  "rose-pine-moon",
  "nord",
  "gruvbox-dark-medium",
  "dracula",
  "one-dark-pro",
  "ayu-dark",
  "ayu-mirage",
  "solarized-dark",
  "night-owl",
  "github-dark",
  "vitesse-dark",
  "everforest-dark",
  "kanagawa-wave",
  "kanagawa-dragon",
  "monokai",
  "dark-plus",
  "material-theme-palenight",
] as const;

export type ShippedEditorThemeId = (typeof SHIPPED_EDITOR_THEME_IDS)[number];

const SHIPPED_EDITOR_THEME_ID_SET: ReadonlySet<string> = new Set(SHIPPED_EDITOR_THEME_IDS);

/** True when `id` is one of {@link SHIPPED_EDITOR_THEME_IDS}. */
export function isShippedEditorThemeId(id: string): id is ShippedEditorThemeId {
  return SHIPPED_EDITOR_THEME_ID_SET.has(id);
}

/**
 * Shipped Monaco/shiki editor theme catalog.
 *
 * Themes are static `@shikijs/themes/<id>` imports so the bundler inlines them
 * (same pattern as `shiki-langs.ts`). Bootstrap loads only
 * {@link DEFAULT_EDITOR_THEME_ID}; other catalog ids load on demand via
 * {@link editorThemeImporterFor} + `registerTheme`.
 */

import {
  isShippedEditorThemeId,
  SHIPPED_EDITOR_THEME_IDS,
  type ShippedEditorThemeId,
} from "@volli/shared";
import type { DynamicImportThemeRegistration } from "shiki";

export interface EditorThemeEntry {
  id: ShippedEditorThemeId;
  label: string;
  family?: string;
}

/** Static ES-module importer for a catalog theme id. */
export type EditorThemeImporter = DynamicImportThemeRegistration;

interface EditorThemeDefinition extends EditorThemeEntry {
  id: ShippedEditorThemeId;
  load: EditorThemeImporter;
}

/**
 * Metadata + static importer per theme. Ids must match
 * {@link SHIPPED_EDITOR_THEME_IDS} exactly (asserted below) so the IPC guard
 * and this picker cannot drift. The notices script reads the same shared list.
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

/**
 * What the editor wears when nothing has been chosen.
 *
 * A flat default, not a derivation. The seed system mapped each of its six
 * theme slugs to a "closest" shiki theme, and both halves of that map are gone:
 * there are no slugs, and the canvas deliberately does not drive the editor
 * (decision 6 — Monaco owns its own pixels, and a syntax theme derived from a
 * gradient is a worse syntax theme). The editor is the one surface that will not
 * match the canvas, and this is the constant that says so.
 */
export const DEFAULT_EDITOR_THEME_ID = "one-dark-pro";

// Shared IPC vocabulary ↔ renderer catalog: same ids, same order. A mismatch
// means someone added a shiki theme here without updating @volli/shared (or
// the reverse) — refuse to ship a catalog the guard would reject.
if (
  EDITOR_THEMES.length !== SHIPPED_EDITOR_THEME_IDS.length ||
  EDITOR_THEMES.some((theme, index) => theme.id !== SHIPPED_EDITOR_THEME_IDS[index])
) {
  throw new Error(
    "editor-theme-catalog EDITOR_THEMES ids must match SHIPPED_EDITOR_THEME_IDS exactly",
  );
}

/** Every shipped editor theme for pickers and bootstrap. */
export function listEditorThemes(): EditorThemeEntry[] {
  return EDITOR_THEMES.map(({ id, label, family }) => ({ id, label, family }));
}

/**
 * Static importer for a catalog theme id, or `null` when the id is not shipped.
 */
export function editorThemeImporterFor(id: string): EditorThemeImporter | null {
  const entry = EDITOR_THEMES.find((theme) => theme.id === id);
  return entry?.load ?? null;
}

/**
 * Resolve the Monaco/shiki theme id to apply: the authored id when it names a
 * shipped theme, and {@link DEFAULT_EDITOR_THEME_ID} otherwise.
 *
 * "Otherwise" covers three cases that must not be told apart — nothing chosen,
 * cleared back to the default, and an id from a build that shipped a theme this
 * one doesn't. All three mean "the editor has no choice of its own", and the
 * honest answer to that is one default rather than a guess.
 */
export function resolveEditorThemeId(input: { editorThemeId: string | null | undefined }): string {
  const explicit = input.editorThemeId;
  if (typeof explicit === "string" && explicit.length > 0 && isShippedEditorThemeId(explicit)) {
    return explicit;
  }
  return DEFAULT_EDITOR_THEME_ID;
}

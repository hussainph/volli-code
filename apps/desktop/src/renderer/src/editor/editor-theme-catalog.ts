/**
 * The two shipped Monaco/shiki editor themes, with their static importers.
 *
 * Themes are static `@shikijs/themes/<id>` imports so the bundler inlines them
 * (same pattern as `shiki-langs.ts`). Both are small enough to ship eagerly:
 * with a catalog of two, "load the other one on demand" would buy nothing and
 * cost a flash of the wrong palette on every light↔dark flip.
 *
 * There is no picker and no default. Which of the two applies is decided by the
 * resolved app appearance through {@link resolveEditorThemeId} — see
 * `@volli/shared`'s `editor-themes.ts` for why the catalog collapsed (VC-123).
 */

import {
  editorThemeForAppearance,
  SHIPPED_EDITOR_THEME_IDS,
  type ResolvedAppearance,
  type ShippedEditorThemeId,
} from "@volli/shared";
import type { DynamicImportThemeRegistration } from "shiki";

/** Static ES-module importer for a shipped theme id. */
export type EditorThemeImporter = DynamicImportThemeRegistration;

interface EditorThemeDefinition {
  id: ShippedEditorThemeId;
  load: EditorThemeImporter;
}

/**
 * Static importer per shipped theme. Ids must match
 * {@link SHIPPED_EDITOR_THEME_IDS} exactly (asserted below) so the IPC guard
 * and the bundle cannot drift. The notices script reads the same shared list.
 */
const EDITOR_THEMES: readonly EditorThemeDefinition[] = [
  {
    id: "vitesse-light",
    load: () => import("@shikijs/themes/vitesse-light"),
  },
  {
    id: "vitesse-dark",
    load: () => import("@shikijs/themes/vitesse-dark"),
  },
];

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

/**
 * Static importer for a shipped theme id, or `null` when the id is not shipped
 * — which now includes every retired catalog id a persisted row might name.
 */
export function editorThemeImporterFor(id: string): EditorThemeImporter | null {
  const entry = EDITOR_THEMES.find((theme) => theme.id === id);
  return entry?.load ?? null;
}

/**
 * The theme id Monaco should wear at this appearance.
 *
 * Takes the RESOLVED appearance — `auto` already answered — because that is
 * what the rest of the app derives from, and re-answering it here would give
 * the editor its own opinion about whether it is night.
 */
export function resolveEditorThemeId(input: {
  resolvedAppearance: ResolvedAppearance;
}): ShippedEditorThemeId {
  return editorThemeForAppearance(input.resolvedAppearance);
}

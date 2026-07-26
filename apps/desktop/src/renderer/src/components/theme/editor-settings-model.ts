/**
 * What Settings → Appearance says about the Monaco/shiki editor theme.
 *
 * Pure: catalog + store inputs in, display rows out. Preview/revert planning
 * lives here too so the cmdk popover can stay thin view glue.
 */

import {
  listEditorThemes,
  resolveEditorThemeId,
  type EditorThemeEntry,
} from "@renderer/editor/editor-theme-catalog";

/** How the effective theme relates to the authored `editorThemeId`. */
export type EditorThemeSource = "automatic" | "explicit";

export interface EditorThemeDisplay {
  /** Catalog id Monaco should wear right now. */
  resolvedId: string;
  /** Human label for the trigger button. */
  label: string;
  source: EditorThemeSource;
  /** Provenance chip beside the picker. */
  sourceLabel: string;
  /**
   * Whether "Reset to match app theme" applies. Only when the user has pinned
   * an explicit catalog id — automatic already follows the app slug.
   */
  resettable: boolean;
}

const SOURCE_LABELS: Record<EditorThemeSource, string> = {
  automatic: "Matches app theme",
  explicit: "Set by Volli",
};

/** Look up a catalog label; fall back to the id when the catalog is incomplete. */
export function editorThemeLabel(themes: readonly EditorThemeEntry[], id: string): string {
  return themes.find((theme) => theme.id === id)?.label ?? id;
}

/**
 * Resolved display for the Editor theme row: effective id/label, and whether
 * that id is derived from the app slug (`null` store value) or pinned.
 */
export function buildEditorThemeDisplay(input: {
  editorThemeId: string | null;
  appThemeSlug: string;
  themes?: readonly EditorThemeEntry[];
}): EditorThemeDisplay {
  const themes = input.themes ?? listEditorThemes();
  const resolvedId = resolveEditorThemeId({
    editorThemeId: input.editorThemeId,
    appThemeSlug: input.appThemeSlug,
  });
  const source: EditorThemeSource =
    input.editorThemeId === null || input.editorThemeId === "" ? "automatic" : "explicit";

  return {
    resolvedId,
    label: editorThemeLabel(themes, resolvedId),
    source,
    sourceLabel: SOURCE_LABELS[source],
    resettable: source === "explicit",
  };
}

/**
 * Preview contract for the Editor theme picker — mirrors TerminalThemeRow:
 * highlight paints without writing; empty/close restores the resolved id.
 */
export type EditorThemePreviewPlan =
  | { kind: "preview"; themeId: string }
  | { kind: "restore"; themeId: string };

/**
 * Plan a live Monaco theme swap for a cmdk highlight. An empty selection
 * (pointer left the list, or cmdk cleared) restores the resolved theme.
 */
export function planEditorThemePreview(input: {
  selection: string;
  resolvedId: string;
}): EditorThemePreviewPlan {
  if (input.selection.length === 0) {
    return { kind: "restore", themeId: input.resolvedId };
  }
  return { kind: "preview", themeId: input.selection };
}

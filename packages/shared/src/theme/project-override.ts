/**
 * A project's per-surface theming override — migration 013's four nullable
 * columns on `projects`.
 *
 * Resolution is always global → project, **per surface, never per token**
 * (#69), so each field is independently nullable and `null` means "inherit the
 * global choice" — which keeps what is overridden always obvious in the UI.
 *
 * Two of the four surfaces are all that remain. The app surface moved to
 * migration 014's `theme_canvas`/`theme_appearance` columns when the canvas
 * replaced the seed-derived theme, so {@link ProjectThemeOverride.appThemeSlug}
 * and `.seed` are written `null` and read by nobody; the terminal and editor
 * surfaces are separate systems (ghostty overlay files, Monaco/shiki ids) and
 * still live on this row. The two dead fields stay in the shape because the
 * columns do — see `db/export.test.ts`, which requires every column on
 * `projects` to have an exported field.
 *
 * Pure: shape guards only, no Node/DOM.
 */

import { isShippedEditorThemeId } from "./editor-themes";

/** A project's theming override; `null` on a field means "inherit the global choice". */
export interface ProjectThemeOverride {
  /** DEAD — the app surface is a `Canvas` on migration 014's columns now. Always null. */
  appThemeSlug: string | null;
  /** Ghostty theme name, as written into the project's terminal overlay. */
  terminalThemeName: string | null;
  /** Monaco/shiki theme id. */
  editorThemeId: string | null;
  /** DEAD — the auto-tint seed the old app surface derived from. Always null. */
  seed: string | null;
}

/** Every surface inheriting — the state every project starts in (#72: per-project theming is off by default). */
export const EMPTY_PROJECT_THEME_OVERRIDE: ProjectThemeOverride = {
  appThemeSlug: null,
  terminalThemeName: null,
  editorThemeId: null,
  seed: null,
};

/** Whether an override sets nothing — the repo layer stores `null` rather than an all-null row's worth of columns. */
export function isProjectThemeOverrideEmpty(override: ProjectThemeOverride): boolean {
  return (
    override.appThemeSlug === null &&
    override.terminalThemeName === null &&
    override.editorThemeId === null &&
    override.seed === null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Null inherits global; a non-null id must be a shipped Monaco/shiki catalog id. */
function isNullableShippedEditorThemeId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isShippedEditorThemeId(value));
}

/**
 * Runtime guard for the IPC boundary: every surface field present and
 * nullable-string, with `editorThemeId` further restricted to the shipped
 * catalog (or null to inherit) — matching `parseGlobalEditorThemeId` and
 * `volli:theme-set-global-editor`.
 */
export function isProjectThemeOverride(value: unknown): value is ProjectThemeOverride {
  return (
    isRecord(value) &&
    isNullableString(value["appThemeSlug"]) &&
    isNullableString(value["terminalThemeName"]) &&
    isNullableShippedEditorThemeId(value["editorThemeId"]) &&
    isNullableString(value["seed"])
  );
}

/**
 * A project's per-surface theming override — what is left of migration 013's
 * four nullable columns on `projects`.
 *
 * Resolution is always global → project, **per surface, never per token**
 * (#69), so each field is independently nullable and `null` means "inherit the
 * global choice" — which keeps what is overridden always obvious in the UI.
 *
 * Three of the original four columns are gone from this shape. The app surface
 * moved to migration 014's `theme_canvas`/`theme_appearance` columns when the
 * canvas replaced the seed-derived theme, so `appThemeSlug` and `seed` were
 * written `null` and read by nobody; the EDITOR surface left in VC-123, when
 * the editor stopped having a preference at all and started following the
 * resolved appearance — which is itself a migration-014 column, so a project
 * that wants a light editor overrides its appearance and gets one.
 *
 * The dead COLUMNS stay in the database (see `db/export.test.ts`, which
 * requires every column on `projects` to have an exported field, and
 * `db/projects-repo.ts`, which still reads/writes them as `null`) — only the TS
 * shape that crosses the renderer/IPC boundary dropped them, since nothing
 * above the repo layer reads them any more.
 *
 * Pure: shape guards only, no Node/DOM.
 */

/** A project's theming override; `null` on a field means "inherit the global choice". */
export interface ProjectThemeOverride {
  /** Ghostty theme name, as written into the project's terminal overlay. */
  terminalThemeName: string | null;
}

/** Every surface inheriting — the state every project starts in (#72: per-project theming is off by default). */
export const EMPTY_PROJECT_THEME_OVERRIDE: ProjectThemeOverride = {
  terminalThemeName: null,
};

/** Whether an override sets nothing — the repo layer stores `null` rather than an all-null row's worth of columns. */
export function isProjectThemeOverrideEmpty(override: ProjectThemeOverride): boolean {
  return override.terminalThemeName === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Runtime guard for the IPC boundary: the surface field present and
 * nullable-string.
 *
 * Extra keys pass. A payload from an older renderer still carries
 * `editorThemeId`, and rejecting the whole override for a field nothing reads
 * would turn a retired picker into a broken terminal theme.
 */
export function isProjectThemeOverride(value: unknown): value is ProjectThemeOverride {
  return isRecord(value) && isNullableString(value["terminalThemeName"]);
}

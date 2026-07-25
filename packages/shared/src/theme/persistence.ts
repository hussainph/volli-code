/**
 * What theming actually STORES — and, more importantly, what it refuses to.
 *
 * Two things are authoritative and nothing else is: the global theme (the
 * authored {@link ThemeDefinition}, in `app_state` under
 * {@link THEME_APP_STATE_KEY}) and each project's per-surface override
 * (nullable columns on `projects`, migration 013). The resolved token set is
 * DERIVED from those at render time and persisted nowhere — VS Code's
 * most-complained-about theming bug (microsoft/vscode#196119) is auto-switching
 * writing the *resolved* theme back over the user's authored intent.
 *
 * {@link serializeGlobalTheme} enforces that by construction rather than by
 * convention: it rebuilds the payload field by field from the authored shape,
 * so a caller who hands it `{ ...theme, tokens }` cannot smuggle a resolved
 * token set into storage. The theme's own sparse `overrides` map survives —
 * that one IS authored intent (#71), which is why the rule is "never persist
 * the RESOLVED set", not "never persist a `--` key".
 *
 * Pure: JSON + shape guards only, no Node/DOM.
 */

import type { ThemeCanvas, ThemeDefinition } from "./definition";
import { isThemeTokenName } from "./tokens";

/** The `app_state` key the authored global theme lives under (#29's kv table). */
export const THEME_APP_STATE_KEY = "theme";

// ── project override (migration 013) ─────────────────────────────────────────

/**
 * A project's theming override. Resolution is always global → project, **per
 * surface, never per token** (#69), so each field is independently nullable
 * and `null` means "inherit the global choice" — which keeps what is
 * overridden always obvious in the UI.
 */
export interface ProjectThemeOverride {
  /** App-surface theme slug (a {@link ThemeDefinition}'s `slug`). */
  appThemeSlug: string | null;
  /** Ghostty theme name, as written into the project's terminal overlay. */
  terminalThemeName: string | null;
  /** Monaco/shiki theme id. */
  editorThemeId: string | null;
  /**
   * Seed hex for the auto-tint case (#72): "Custom" opens with *Auto-tint from
   * this project's color* pre-selected, derived from the project's existing
   * `colorIndex`. Stored so a later palette change never silently re-tints a
   * project the user had already tuned.
   */
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

/** Runtime guard for the IPC boundary: every surface field present and nullable-string. */
export function isProjectThemeOverride(value: unknown): value is ProjectThemeOverride {
  return (
    isRecord(value) &&
    isNullableString(value["appThemeSlug"]) &&
    isNullableString(value["terminalThemeName"]) &&
    isNullableString(value["editorThemeId"]) &&
    isNullableString(value["seed"])
  );
}

// ── global theme (app_state kv) ──────────────────────────────────────────────

function isThemeCanvas(value: unknown): value is ThemeCanvas {
  if (!isRecord(value)) return false;
  if (value["kind"] === "solid") return true;
  if (value["kind"] !== "gradient" && value["kind"] !== "mesh") return false;
  const stops = value["stops"];
  return Array.isArray(stops) && stops.every((stop) => typeof stop === "string");
}

/** Whether every key is a known token name and every value a string — the sparse AUTHORED override map (#71). */
function isTokenOverrideMap(value: unknown): value is ThemeDefinition["overrides"] {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => isThemeTokenName(key) && typeof entry === "string",
    )
  );
}

/** Runtime guard for a whole authored theme — used by the IPC descriptor and by {@link parseGlobalTheme}. */
export function isThemeDefinition(value: unknown): value is ThemeDefinition {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["slug"] === "string" &&
    typeof value["seed"] === "string" &&
    isNullableString(value["accent"]) &&
    typeof value["grain"] === "number" &&
    Number.isFinite(value["grain"]) &&
    isThemeCanvas(value["canvas"]) &&
    isTokenOverrideMap(value["overrides"]) &&
    (value["appearance"] === "dark" || value["appearance"] === "light")
  );
}

/**
 * The JSON stored in `app_state`. Built field by field — NOT `JSON.stringify`
 * of the argument — so nothing beyond the authored shape can reach storage,
 * whatever the caller passes. See this module's header for why that matters.
 */
export function serializeGlobalTheme(theme: ThemeDefinition): string {
  const persisted: ThemeDefinition = {
    name: theme.name,
    slug: theme.slug,
    seed: theme.seed,
    accent: theme.accent,
    grain: theme.grain,
    canvas: theme.canvas,
    overrides: { ...theme.overrides },
    appearance: theme.appearance,
  };
  return JSON.stringify(persisted);
}

/**
 * Reads a stored global theme back. Null for absent, malformed, or
 * wrong-shaped JSON — an unreadable stored theme must degrade to the shipped
 * default, never crash boot or half-apply.
 */
export function parseGlobalTheme(json: string | undefined | null): ThemeDefinition | null {
  if (json === undefined || json === null || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return isThemeDefinition(parsed) ? parsed : null;
}

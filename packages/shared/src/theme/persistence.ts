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

import { CANVAS_MAX_STOPS } from "./canvas";
import { isHexColor } from "./color";
import type { ThemeCanvas, ThemeDefinition } from "./definition";
import { isShippedEditorThemeId, type ShippedEditorThemeId } from "./editor-themes";
import { isThemeTokenName } from "./tokens";

/** The `app_state` key the authored global theme lives under (#29's kv table). */
export const THEME_APP_STATE_KEY = "theme";

/**
 * The `app_state` key for the global Monaco/shiki editor theme id.
 * Absent or null means “derive from the active app theme slug” via
 * `resolveEditorThemeId` — never a resolved token set.
 */
export const THEME_EDITOR_APP_STATE_KEY = "theme_editor";

/**
 * The string stored under {@link THEME_EDITOR_APP_STATE_KEY}. Empty means
 * “derive from app” (same as a missing row); a non-empty value is the
 * authored catalog id.
 */
export function serializeGlobalEditorThemeId(editorThemeId: ShippedEditorThemeId | null): string {
  return editorThemeId !== null && isShippedEditorThemeId(editorThemeId) ? editorThemeId : "";
}

/**
 * Reads the authored global editor theme id back out of `app_state`. Null for
 * absent, empty, “clear back to derive”, or a non-catalog value (corrupt /
 * hand-edited row) — the renderer maps that through `resolveEditorThemeId`
 * against the active app theme slug. Only {@link isShippedEditorThemeId}
 * values survive.
 */
export function parseGlobalEditorThemeId(
  raw: string | undefined | null,
): ShippedEditorThemeId | null {
  if (raw === undefined || raw === null || raw.length === 0) return null;
  return isShippedEditorThemeId(raw) ? raw : null;
}

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

/** Null inherits global; a non-null id must be a shipped Monaco/shiki catalog id. */
function isNullableShippedEditorThemeId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isShippedEditorThemeId(value));
}

/**
 * Runtime guard for the IPC boundary: every surface field present and
 * nullable-string, with `editorThemeId` further restricted to the shipped
 * catalog (or null to inherit) — matching {@link parseGlobalEditorThemeId}
 * and `volli:theme-set-global-editor`.
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

// ── global theme (app_state kv) ──────────────────────────────────────────────

/**
 * The canvas, at the boundary — including the two things a `ThemeCanvas`'s type
 * only *documents*: the three-stop ceiling, and that a stop is a color.
 *
 * Both are enforced here rather than downstream because the failure modes are
 * asymmetric. A fourth stop has no position to sit at, so it would be dropped
 * without anyone being told; an unparseable stop throws inside the color math
 * and takes the render with it. A theme file is hand-editable and shareable, so
 * neither is hypothetical — and a theme that fails this guard degrades to the
 * shipped default, which is the honest answer to a file we cannot paint.
 *
 * What is NOT enforced here is the legibility band. That one is applied on
 * READ, every time the layer paints (`theme/canvas.ts`), so it holds for
 * whatever the file says without storage having to rewrite what it was given.
 */
function isThemeCanvas(value: unknown): value is ThemeCanvas {
  if (!isRecord(value)) return false;
  if (value["kind"] === "solid") return true;
  if (value["kind"] !== "gradient" && value["kind"] !== "mesh") return false;
  const stops = value["stops"];
  if (!Array.isArray(stops)) return false;
  if (stops.length > CANVAS_MAX_STOPS) return false;
  return stops.every((stop) => typeof stop === "string" && isHexColor(stop));
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

function isNullableHexColor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isHexColor(value));
}

/** Runtime guard for a whole authored theme — used by the IPC descriptor and by {@link parseThemeJson}. */
export function isThemeDefinition(value: unknown): value is ThemeDefinition {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["slug"] === "string" &&
    typeof value["seed"] === "string" &&
    isHexColor(value["seed"]) &&
    isNullableHexColor(value["accent"]) &&
    typeof value["grain"] === "number" &&
    Number.isFinite(value["grain"]) &&
    isThemeCanvas(value["canvas"]) &&
    isTokenOverrideMap(value["overrides"]) &&
    (value["appearance"] === "dark" || value["appearance"] === "light")
  );
}

/**
 * Rebuilds the canvas from its OWN authored fields, per variant.
 *
 * Copying `theme.canvas` by reference would have been the one hole in
 * {@link serializeGlobalTheme}'s "nothing but the authored shape reaches
 * storage" claim: `isThemeCanvas` (like every guard here) allows extra
 * properties, so `{ kind: "solid", tokens: { … } }` round-tripped intact —
 * exactly the resolved-token smuggling the field-by-field rebuild exists to
 * prevent, just one level down.
 *
 * `stops` is copied, never edited. The three-stop ceiling is enforced by
 * {@link isThemeCanvas} — a REJECTION, which the caller sees — rather than by
 * truncating here, because storage silently dropping a stop the user authored
 * would be this module's own cardinal sin. Same for the legibility band, which
 * is applied on read: what a theme file says is what storage holds.
 */
function persistedCanvas(canvas: ThemeCanvas): ThemeCanvas {
  return canvas.kind === "solid"
    ? { kind: "solid" }
    : { kind: canvas.kind, stops: [...canvas.stops] };
}

/**
 * A theme rebuilt field by field from the authored shape — NOT a copy of the
 * argument — so nothing beyond that shape can reach storage, whatever the
 * caller passes. The rebuild goes all the way down: nested objects are rebuilt
 * too (see {@link persistedCanvas}), because a guard that tolerates extra
 * properties makes any by-reference copy a smuggling route. See this module's
 * header for why that matters.
 *
 * Shared by BOTH storage surfaces — the `app_state` value below and the custom
 * theme file (`theme/custom-themes.ts`) — so a second place to persist a theme
 * cannot be a second place to lose that guarantee.
 */
export function persistedTheme(theme: ThemeDefinition): ThemeDefinition {
  return {
    name: theme.name,
    slug: theme.slug,
    seed: theme.seed,
    accent: theme.accent,
    grain: theme.grain,
    canvas: persistedCanvas(theme.canvas),
    overrides: { ...theme.overrides },
    appearance: theme.appearance,
  };
}

/** The JSON stored in `app_state`, built through {@link persistedTheme}. */
export function serializeGlobalTheme(theme: ThemeDefinition): string {
  return JSON.stringify(persistedTheme(theme));
}

/**
 * Reads an authored theme back out of stored JSON — the `app_state` value or a
 * custom theme file alike. Null for absent, malformed, or wrong-shaped JSON:
 * every reader of a theme is a reader of something a user can hand-edit, so an
 * unreadable one must degrade (to the shipped default, or to a skipped catalog
 * entry) rather than crash boot or half-apply.
 */
export function parseThemeJson(json: string | undefined | null): ThemeDefinition | null {
  if (json === undefined || json === null || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return isThemeDefinition(parsed) ? parsed : null;
}

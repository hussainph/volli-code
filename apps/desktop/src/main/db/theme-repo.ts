/**
 * The GLOBAL half of theming persistence — three `app_state` rows (#29's kv
 * table). The per-project half lives on `projects` columns; see
 * `updateProjectCanvas`/`updateProjectAppearance` in `projects-repo.ts` and
 * migration 014.
 *
 * | key | payload | authority |
 * | --- | --- | --- |
 * | `theme` | the authored {@link Canvas} | yes |
 * | `appearance` | `"light" \| "dark" \| "auto"` | yes |
 * | `first-paint` | `{appearance, background}` | **no — a hint** |
 *
 * Three rules this module exists to hold:
 *
 *  - **Only authored input is stored, never the resolved token set.** The
 *    canvas is rebuilt field by field on the way in (`parseCanvas`), so a
 *    caller cannot smuggle a generated ladder into the row by spreading it
 *    onto the canvas. `{canvas, appearance}` is the authoritative pair and the
 *    31 tokens are derived from it at render time — persisting the resolved set
 *    is VS Code's most-complained-about theming bug (microsoft/vscode#196119).
 *  - **`first-paint` is a cache of two values, and is not a counter-example to
 *    that.** It holds one enum and one hex — precisely the two things main
 *    cannot derive on its own, synchronously, at window construction, with no
 *    renderer yet in existence. Nothing reads it once the renderer has booted,
 *    so it can never out-vote the authored pair; a token ladder could, which is
 *    what the rule is actually about. A reviewer should read it as "the window
 *    background main already had to keep, plus the mode class that has the same
 *    first-paint problem" — not as a second source of truth.
 *  - **An unreadable stored value degrades to null**, not to a throw. These are
 *    read at boot, before there is any UI to surface a failure in; the caller
 *    falls back to the shipped default rather than failing to paint. That is
 *    also, exactly, how a database written by the seed-based theming system
 *    resets to the default canvas: its `theme` row is a `ThemeDefinition`,
 *    which is not a canvas, so it reads as null. No seed→canvas conversion,
 *    by construction.
 */
import type Database from "better-sqlite3";
import {
  isAppearance,
  parseCanvas,
  parseGlobalEditorThemeId,
  parseThemeJson,
  serializeGlobalEditorThemeId,
  serializeGlobalTheme,
  THEME_APP_STATE_KEY,
  THEME_EDITOR_APP_STATE_KEY,
} from "@volli/shared";
import type {
  Appearance,
  Canvas,
  FirstPaintHint,
  ShippedEditorThemeId,
  ThemeDefinition,
} from "@volli/shared";
import { setAppState } from "./app-state-repo";
import { prepared } from "./prepared";

/**
 * The `app_state` key the global appearance lives under. Absent means the user
 * has never chosen one, which the resolver reads as `auto`.
 *
 * TODO(canvas-engine): move these two beside `THEME_APP_STATE_KEY` in
 * `@volli/shared`'s theme persistence module once the canvas engine lands
 * there — the renderer reads the same rows out of the bootstrap payload, and
 * two hand-typed copies of a key string is one too many.
 */
export const APPEARANCE_APP_STATE_KEY = "appearance";

/** The `app_state` key the first-paint hint lives under. See this module's header. */
export const FIRST_PAINT_APP_STATE_KEY = "first-paint";

/** One `app_state` value, unparsed. Null when the key has never been written. */
function readAppState(db: Database.Database, key: string): string | null {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(key);
  return row?.value ?? null;
}

/**
 * The raw stored JSON, unparsed — the shape assertions in the tests read this
 * so they check what actually landed on disk rather than what the writer
 * intended to send. Null when no theme has been chosen.
 */
export function getRawGlobalTheme(db: Database.Database): string | null {
  return readAppState(db, THEME_APP_STATE_KEY);
}

/**
 * JSON in, a canvas or null out — malformed, absent, and "this row is a legacy
 * `ThemeDefinition` from the system this one replaces" all read the same.
 *
 * `parseCanvas` is `@volli/shared`'s one storage boundary for this shape: it
 * rejects shapes, clamps ranges, normalizes hexes, and — the property this
 * layer depends on — rebuilds the canvas field by field rather than copying the
 * argument, so a resolved token set riding along on a stored payload cannot
 * survive the round trip.
 */
function parseCanvasJson(json: string | null): Canvas | null {
  if (json === null || json.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return parseCanvas(parsed);
}

/** The authored global canvas, or null when unset/unreadable (the caller falls back to the default canvas). */
export function getGlobalCanvas(db: Database.Database): Canvas | null {
  return parseCanvasJson(getRawGlobalTheme(db));
}

/**
 * Upserts the authored global canvas, rebuilt field by field on the way in.
 *
 * THROWS on a canvas that cannot be painted rather than storing it or quietly
 * substituting the default: this is the last layer before the row, the IPC
 * envelope turns the throw into a typed `{ ok: false, error }` the renderer can
 * surface, and a write that silently stored something else would be the worst
 * of the three outcomes.
 */
export function setGlobalCanvas(db: Database.Database, canvas: Canvas, now: number): void {
  const stored = parseCanvas(canvas);
  if (stored === null) throw new Error("Refusing to store a canvas that cannot be painted");
  setAppState(db, THEME_APP_STATE_KEY, JSON.stringify(stored), now);
}

/**
 * The authored global appearance, or null when unset/unreadable. Null is NOT
 * the same as `"auto"` here: this layer reports what is stored, and the
 * resolver decides that nothing stored means follow-the-system.
 */
export function getGlobalAppearance(db: Database.Database): Appearance | null {
  const raw = readAppState(db, APPEARANCE_APP_STATE_KEY);
  return isAppearance(raw) ? raw : null;
}

/** Upserts the global appearance. Stored bare, not as JSON — it is one enum word. */
export function setGlobalAppearance(
  db: Database.Database,
  appearance: Appearance,
  now: number,
): void {
  setAppState(db, APPEARANCE_APP_STATE_KEY, appearance, now);
}

/**
 * The last recorded first-paint hint, or null when the app has never painted
 * (or wrote something unreadable). A caller that gets null derives its own
 * fallback — see `window-theme.ts`; this must never throw, because it is read
 * before the window that would show the error exists.
 */
export function getFirstPaintHint(db: Database.Database): FirstPaintHint | null {
  const raw = readAppState(db, FIRST_PAINT_APP_STATE_KEY);
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { appearance, background } = parsed as Record<string, unknown>;
  // `auto` is not a first paint — the hint records what was RESOLVED.
  if (appearance !== "light" && appearance !== "dark") return null;
  if (typeof background !== "string" || background.length === 0) return null;
  return { appearance, background };
}

/** Upserts the first-paint hint, rebuilt field by field like every other stored payload. */
export function setFirstPaintHint(db: Database.Database, hint: FirstPaintHint, now: number): void {
  setAppState(
    db,
    FIRST_PAINT_APP_STATE_KEY,
    JSON.stringify({ appearance: hint.appearance, background: hint.background }),
    now,
  );
}

// ── the seed-based system, on its way out ────────────────────────────────────
// Still live because the renderer's picker still is: these two write the SAME
// `theme` row the canvas accessors above use, and each other's payload fails
// the other's guard, so whichever system last wrote is the one that reads back
// and the other degrades to its shipped default. That is decision 7 — "reset to
// Ember, no seed→canvas conversion" — falling out of the guards rather than
// needing a migration to do it. Both halves cannot be live at once, and only
// one of them is getting a UI.

/** The authored global theme, or null when unset/unreadable (the caller falls back to `DEFAULT_THEME`). */
export function getGlobalTheme(db: Database.Database): ThemeDefinition | null {
  return parseThemeJson(getRawGlobalTheme(db));
}

/** Upserts the authored global theme. */
export function setGlobalTheme(db: Database.Database, theme: ThemeDefinition, now: number): void {
  setAppState(db, THEME_APP_STATE_KEY, serializeGlobalTheme(theme), now);
}

/** The authored global editor theme id, or null when unset (derive from the app theme slug). */
export function getGlobalEditorThemeId(db: Database.Database): ShippedEditorThemeId | null {
  return parseGlobalEditorThemeId(readAppState(db, THEME_EDITOR_APP_STATE_KEY));
}

/**
 * Upserts the global editor theme id. `null` clears it so Monaco derives from
 * the active app theme slug.
 */
export function setGlobalEditorThemeId(
  db: Database.Database,
  editorThemeId: ShippedEditorThemeId | null,
  now: number,
): void {
  setAppState(db, THEME_EDITOR_APP_STATE_KEY, serializeGlobalEditorThemeId(editorThemeId), now);
}

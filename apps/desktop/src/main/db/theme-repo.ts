/**
 * The GLOBAL half of theming persistence: the authored {@link ThemeDefinition}
 * in `app_state` under the `theme` key (#29's kv table). The per-project half
 * lives on `projects` columns — see `updateProjectThemeOverride` in
 * `projects-repo.ts` and migration 013.
 *
 * Two rules this module exists to hold:
 *
 *  - **Only the authored definition is stored, never the resolved token set.**
 *    Serialization goes through `@volli/shared`'s `serializeGlobalTheme`,
 *    which rebuilds the payload field by field, so a caller cannot smuggle
 *    resolved tokens into the row even by spreading them onto the definition.
 *  - **An unreadable stored theme degrades to null**, not to a throw. A theme
 *    is read at boot, before there is any UI to surface a failure in; the
 *    caller falls back to the shipped default rather than failing to paint.
 */
import type Database from "better-sqlite3";
import { parseThemeJson, serializeGlobalTheme, THEME_APP_STATE_KEY } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";
import { setAppState } from "./app-state-repo";
import { prepared } from "./prepared";

/**
 * The raw stored JSON, unparsed — the shape assertions in the tests read this
 * so they check what actually landed on disk rather than what the writer
 * intended to send. Null when no theme has been chosen.
 */
export function getRawGlobalTheme(db: Database.Database): string | null {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(THEME_APP_STATE_KEY);
  return row?.value ?? null;
}

/** The authored global theme, or null when unset/unreadable (the caller falls back to `DEFAULT_THEME`). */
export function getGlobalTheme(db: Database.Database): ThemeDefinition | null {
  return parseThemeJson(getRawGlobalTheme(db));
}

/** Upserts the authored global theme. */
export function setGlobalTheme(db: Database.Database, theme: ThemeDefinition, now: number): void {
  setAppState(db, THEME_APP_STATE_KEY, serializeGlobalTheme(theme), now);
}

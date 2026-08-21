/**
 * The `app_state` keys theming writes.
 *
 * What is authoritative is `{canvas, appearance}`: the canvas under
 * {@link THEME_APP_STATE_KEY} and the appearance beside it, with each project's
 * columns (migration 014) overriding both per surface. The resolved token set is
 * DERIVED from that pair at render time and persisted nowhere — VS Code's
 * most-complained-about theming bug (microsoft/vscode#196119) is auto-switching
 * writing the *resolved* theme back over the user's authored intent.
 *
 * The keys are stated here rather than in main's repo layer because both sides
 * read them: main writes the rows, and the renderer reads the same rows back out
 * of the bootstrap payload. Three hand-typed copies of a key string is two too
 * many.
 *
 * Pure: string constants only, no Node/DOM.
 */

/** The `app_state` key the authored global canvas lives under (#29's kv table). */
export const THEME_APP_STATE_KEY = "theme";

/**
 * The `app_state` key the global light/dark/auto appearance lives under. Absent
 * means the user has never chosen one, which resolves as `auto`.
 */
export const APPEARANCE_APP_STATE_KEY = "appearance";

/**
 * There is deliberately no editor key here. VC-123 collapsed the editor to one
 * light and one dark theme chosen by {@link APPEARANCE_APP_STATE_KEY}'s
 * resolved value, so the editor has nothing of its own left to store.
 *
 * A database upgraded from an older build may still hold a `theme_editor` row
 * naming a retired catalog id. Nothing reads it, and that IS the tolerant read:
 * an id from a build that had a picker now means exactly what an absent row
 * means — follow the app.
 */

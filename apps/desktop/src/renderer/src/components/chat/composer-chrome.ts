/**
 * The composer's control language, spelled once (VC-335).
 *
 * Every prompt surface — the Session composer, the New-ticket footer, the
 * Automation Instructions box — draws its controls from these three facts, so
 * the chrome around a prompt is one family wherever a prompt is written. The
 * surfaces used to pick rungs by hand and drifted: the New-ticket footer sat a
 * 24px Create beside 20px model and effort pills, and the chat composer's
 * whole control row lived at 20px, the ladder's rung for inline row actions
 * and hover affordances — a rung nothing else on the app's toolbars wears.
 *
 * WHY THESE RUNGS. Measured against the field (T3 Code, OpenCode, claude.ai,
 * ChatGPT, Claude Code Desktop, Cursor 2), a prompt composer's control row sits
 * at 24–32px and its send control one step above that at 28–36px, filled.
 * The app's own pill ladder (`docs/DESIGN.md`) already names both: `sm` is
 * "toolbar buttons, footer actions" and `default`/`icon` is "standalone
 * actions … matches the chip height". So the row is `sm` and the primary is
 * `icon` — the hierarchy the field converges on, said in the ladder's own
 * words, without inventing a size.
 *
 * WHAT DOES NOT LIVE HERE. Ink and hover are the ghost button's own; the
 * footer's padding is `PromptInputFooter`'s; the shell is
 * `COMPOSER_STACK_SHELL` in `@volli/session-presentation`. This module is the
 * rung, and only the rung, so a surface cannot restate it.
 */

/** The rung every control in a composer's footer row wears: 24px. */
export const COMPOSER_CONTROL_SIZE = "sm" as const;

/** The icon-only twin of {@link COMPOSER_CONTROL_SIZE}: a 24px square. */
export const COMPOSER_CONTROL_ICON_SIZE = "icon-sm" as const;

/**
 * The primary — Send, Queue, Stop — one rung above the row, at the chip
 * height: 28px. Fill and a step up are what say "this one acts on the turn";
 * the rest of the row sets facts about it.
 */
export const COMPOSER_PRIMARY_SIZE = "icon" as const;

/**
 * The glyph inside a control at {@link COMPOSER_CONTROL_SIZE}. `bold`, and
 * this is the house rule rather than a taste: at 14px a Phosphor regular draws
 * lighter than the 13px label beside it, and coverage is scale-invariant, so a
 * bigger box could never fix it — only the weight step can.
 */
export const COMPOSER_GLYPH_WEIGHT = "bold" as const;

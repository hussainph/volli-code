/**
 * The settings design kit — the vocabulary both settings surfaces are built
 * from (VC-111). The ticket carries the audit and the two independent reviews
 * that produced these shapes; each module carries the decisions that are
 * load-bearing in its own code.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 *  1. Grouped, searchable rail; group labels carry the relationship.
 *  2. Scope is the SURFACE, not a mode. Settings is app-wide, Configure is
 *     this project. Divergence is said once, by `OverrideControl`.
 *  3. One section header grammar: icon · title · optional `(i)` · one action.
 *  4. A setting is a `PrefRow`. A collection of things is a `DataTable`.
 *  5. One save model, and it can refuse (`CommitField`).
 *  6. Status has three roles and three shapes: `Health`, `Provenance`, and a
 *     table column.
 *  7. Every collection declares loading, error, empty and no-results.
 *  8. Widths come from `CONTROL_W`; nothing else sets one.
 *  9. **Prefer the repo's primitive.** If one exists, this kit wraps it.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Rule 9 has teeth because two passes of this design hand-rolled things the
 * repo already had — a row over `ui/list-row.tsx` (re-making the exact bug
 * that file prevents), a second status-colour map beside `ui/status-dot.tsx`,
 * plus re-derived `section-heading`, `skeleton` and `input-group`. `grep`
 * before writing a primitive. The one object the app genuinely lacked is a
 * table, which is why `DataTable` is the only thing here built from scratch.
 */
export { AsyncSection, Empty, type AsyncState } from "./async-section";
export { CommitField, type CommitResult } from "./commit-field";
export { CONTROL_W, type ControlWidth } from "./control-width";
export { Cell, DataTable, type Column, type TableFilter } from "./data-table";
export { DetailLine, HealthPanel, type Fault } from "./health-panel";
export { InfoHint } from "./info-hint";
export { OverrideControl, OverrideNote } from "./override";
export { ItemRow, PrefRow } from "./pref-row";
export { PrefSection, SectionAction, SectionIconAction } from "./pref-section";
export { PrefShell, type PrefCategory, type PrefGroup } from "./pref-shell";
export { Health, Provenance } from "./status";
export { Unavailable, UnavailableNotice, UnavailablePreview } from "./unavailable";
export { useRovingRows } from "./use-roving-rows";

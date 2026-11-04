/**
 * The surface ladder, spelled once (docs/DESIGN.md, "Surfaces").
 *
 * Every surface in the app is one of six roles — canvas, panel, card, well,
 * float, modal — and each role has exactly one fill, one edge, one shadow rule
 * and one radius. The fills live in `globals.css` (the material section), the
 * radii are role variables in its `@theme` (`--radius-card`, `--radius-popover`
 * …), and the edge and shadow live here — so a surface takes its whole
 * treatment by naming its role, and retuning a role is a one-line change. A
 * surface that needs a different look is a different role, argued in
 * DESIGN.md first.
 *
 * Flat means flat: nothing in the flow casts a shadow or draws an inset rim.
 * `shadow-overlay` is the one shadow, and only {@link FLOAT_SURFACE} and
 * {@link MODAL_SURFACE} wear it.
 *
 * Radii nest concentrically: a surface inside another at an inset `p` takes
 * the outer radius minus `p`, and never more than its parent. The derivations
 * are variables too, so they follow a retune: a menu's rows at its 4px pad are
 * `rounded-menu-item`, and the float, menu and modal roles below each publish
 * `--nested-radius` for the `rounded-row`s and `rounded-well`s inside them
 * (globals.css), so a row or a well is concentric with the float that holds it.
 */

/**
 * A side pane of the panel: the sidebar, the ticket and Home rails, the
 * Settings nav. One fill — the generator's sidebar tier as fixed glass — so
 * the pane outside the content card and the panes inside it are one material.
 * Its edges are the hairline dividers of the layout it sits in.
 */
export const PANE_SURFACE = "surface-pane";

/**
 * A card in the flow: ticket card, settings section, composer, notice,
 * comment, log list. Regular glass on the card tier, one `border` hairline,
 * the card radius, no shadow.
 */
export const CARD_SURFACE = "surface-card rounded-card border border-border";

/**
 * An inset well: code, a log box, an embedded field. The glass ladder's
 * resting tint and its edge — the same pair every field wears — on the well
 * radius: concentric with its container, the control radius standalone.
 */
export const WELL_SURFACE = "rounded-well border border-glass-edge bg-glass-1";

/**
 * A float: popover, peek, toast, and any panel that hovers over the work (the
 * run windows). The float material — its tint and backdrop are the `--float-*`
 * pair in `globals.css` — its stronger edge, the one shadow, and the popover
 * radius. Menus and selects add `rounded-menu` over it (`MENU_SURFACE`), the
 * radius their `-item` rows are cut from. Tooltips are labels on their own
 * tighter radius (`ui/tooltip.tsx`, `--radius-tooltip`).
 */
export const FLOAT_SURFACE =
  "material-floating surface-float rounded-popover border shadow-overlay";

/**
 * A modal: dialog, alert, sheet, the ⌘K and ⌘P palettes. The float material
 * and shadow on the dialog radius — the outermost thing on screen while it is
 * open, so never rounded tighter than the panels it covers.
 */
export const MODAL_SURFACE = "material-floating surface-modal rounded-dialog border shadow-overlay";

/**
 * The two empty states.
 *
 * A surface with nothing in it is one of exactly two things, and the eye reads
 * no third: either the WHOLE surface is empty — a page, a rail page, a pane the
 * tab strip just opened, a dialog body — or ONE LIST is empty inside something
 * that is not. Everything else about an empty state (an icon, a heading, a call
 * to action, how muted the line is) follows from which of those two it is.
 *
 * It was being spelled eleven ways before this file: `px-1`, `px-2 py-1`,
 * `px-2 py-2`, `py-4`, `py-6`, `px-4 py-6`, `px-4 py-4`, `py-8`, `p-8`, `px-6`,
 * `py-16`, and six sites with no padding at all — which is not eleven decisions,
 * it is eleven authors. The tell is that the two rail pages ended up
 * byte-identical by coincidence while the two pages that ARE a matched pair
 * (`main-content`'s first-run canvas and `configure-page`'s "nothing to
 * configure") differed in the padding, the heading rung and the icon's shadow.
 *
 * NEITHER CONSTANT SETS THE BOX. `flex-1`, `min-h-0`, `absolute inset-0` and
 * `size-full` are how a surface fills its parent, and that is the parent's
 * business — these say only how the message sits inside whatever box it lands
 * in. Compose them: `cn("min-h-0 flex-1", EMPTY_PAGE)`.
 *
 * {@link EMPTY_PAGE} also sets no text color, because a page empty is allowed a
 * hierarchy — a heading in the foreground ink over a muted line under it — and a
 * color on the wrapper would quietly mute the heading too. Its children carry
 * their own type. {@link EMPTY_INLINE} is a single line by definition, so it
 * carries all of it.
 */

/**
 * Page scale: the surface itself is empty. Centred on both axes, one gutter in,
 * a row of air top and bottom. `gap-2` is the rhythm for a stacked icon and
 * line; the two sites that end in a call to action open it to `gap-4`, which is
 * an override a reader can see rather than a fourth recipe.
 */
export const EMPTY_PAGE =
  "flex flex-col items-center justify-center gap-2 px-gutter py-8 text-center";

/**
 * Inline scale: one list's worth of nothing, at the size of the rows that
 * aren't there. Muted, because an empty state is a report and never an action.
 *
 * This is also the menus' no-results row — see `MENU_EMPTY`, which is this
 * constant. A dropdown with nothing in it and a sidebar band with nothing in it
 * are the same statement at the same scale, and were the same string by
 * accident in four places already.
 */
export const EMPTY_INLINE = "py-4 text-center text-ui text-muted-foreground";

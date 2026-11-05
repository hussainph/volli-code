/**
 * The one place menu geometry is spelled. A menu row is a control, and this
 * app's control is 28px tall at `text-ui` — `ui/button.tsx`'s `default` size and
 * the shared control scale both say so. The menus were the only control
 * family that never moved onto it, because each of the four primitives carried
 * its own copy of the row string. They compose these constants now, so the
 * family cannot split again; a raw menu size written anywhere else is a bug.
 *
 * What deliberately does NOT live here: anything naming a Radix custom
 * property. Those are namespaced per primitive
 * (`--radix-dropdown-menu-content-*` vs `--radix-context-menu-content-*`), so
 * the transform origin, the available-height clamp, and the overflow policy
 * that depends on it stay with each surface.
 */

import { cn } from "@renderer/lib/utils";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { SECTION_HEADING, SECTION_HEADING_CMDK } from "@renderer/components/ui/section-heading";

/**
 * The popover box, shared by root menus, sub-menus and the select surface —
 * one elevation for all three, so a sub-menu does not read as floating above
 * the menu that opened it.
 */
export const MENU_SURFACE =
  "z-50 min-w-[8rem] max-w-[calc(100vw-2rem)] rounded-menu border border-border bg-popover text-ui text-foreground shadow-overlay";

/**
 * The 4px the rows sit inside. Separate from {@link MENU_SURFACE} because the
 * select surface puts it on the scroll viewport instead — its scroll buttons
 * are siblings of the rows, not part of the padded column.
 */
export const MENU_SURFACE_PAD = "p-1";

/**
 * The half of the open/close every menu surface can always run: the keyframe
 * pair, the fade, the curve, and the reduced-motion gate.
 *
 * `animate-none!` carries the `!` because without it the gate is decoration.
 * `data-[state=open]:animate-in` compiles to
 * `.data-\[state\=open\]\:animate-in[data-state=open]` — a class AND an
 * attribute, (0,2,0) — while a `motion-reduce:` utility is one class inside a
 * media query, (0,1,0), and a media query contributes no specificity of its
 * own. The gate lost on every overlay in the app, regardless of source order.
 * Stacking the state variant onto the gate to match the attribute back only
 * draws the fight to a tie that Tailwind's variant ordering then settles for
 * us; `!important` is the one mechanism that cannot lose, which is why the gate
 * is spelled as an override rather than as a preference.
 */
export const MENU_SURFACE_FADE =
  "ease-out motion-reduce:animate-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0";

/**
 * The half that needs a real anchor: a small scale from the trigger's
 * published transform origin, never a translated reading target.
 * A surface positioned any other way must NOT
 * take this. With no origin the zoom falls back to `50% 50%` and the surface
 * grows from its own middle while attached to something else. `ui/select.tsx`
 * is the one surface in this family that can be positioned another way, and so
 * composes the two halves itself instead of taking {@link MENU_SURFACE_MOTION}.
 */
export const MENU_SURFACE_ANCHORED = "data-[state=open]:zoom-in-95";

/** Open and close, shared by every trigger-anchored menu surface. */
export const MENU_SURFACE_MOTION = `${MENU_SURFACE_FADE} ${MENU_SURFACE_ANCHORED}`;

/**
 * The 28px row: a 20px `text-ui` line box plus `py-1`, 8px of side padding, a
 * 14px glyph 8px off the label. A leading glyph is muted unless it carries its
 * own `text-*` — which is also the door a selection mark uses to opt back into
 * the row's ink, see {@link MENU_INDICATOR_MARK}.
 *
 * `rounded-menu-item` is the native 5px highlight, never a pill at the
 * dense 28px row height.
 */
const MENU_ROW_LAYOUT =
  "relative flex cursor-default items-center gap-2 min-w-0 rounded-menu-item pr-2 pl-6 py-1 text-ui font-medium wrap-anywhere outline-hidden select-none [&>span:not([data-slot])]:min-w-0";

export const MENU_ROW = `${MENU_ROW_LAYOUT} [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground`;

/** Radix row states: `focus` is the roving highlight, `data-disabled` a bare attribute. */
export const MENU_ROW_STATE =
  "focus:bg-(--accent-selected) focus:text-primary-text data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/** cmdk row states: a controlled `data-selected`, and `data-disabled="true"`. */
export const MENU_ROW_STATE_CMDK =
  "data-[selected=true]:bg-(--accent-selected) data-[selected=true]:text-primary-text data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50";

/**
 * Destination search rows (⌘K / ⌘P) share the concentric menu highlight.
 * Consumers own density: the palette stacks context with py-2;
 * Quick Open keeps a single 28px line. No copied cursor/selection/type recipe.
 */
// Result rows own their glyphs (including nested provenance marks): inheriting
// MENU_ROW's descendant ink rule would mute a bolt colored by its parent span.
export const COMMAND_RESULT_ROW = cn(MENU_ROW_LAYOUT, MENU_ROW_STATE_CMDK, "pl-2 outline-none");

/** A sub-menu trigger stays lit for as long as the surface it opened is up. */
export const MENU_ROW_OPEN =
  "data-[state=open]:bg-(--accent-selected) data-[state=open]:text-primary-text";

/** The destructive row, and its glyph, which the muted-icon rule must not claim. */
export const MENU_ROW_DESTRUCTIVE =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/30 data-[variant=destructive]:*:[svg]:text-destructive!";

/** Native checked-state gutter precedes the icon/title axis. */
export const MENU_ROW_INDICATED = "pl-6";

/** The box the selection mark is centred in, in the leading checked-state gutter. */
export const MENU_INDICATOR =
  "pointer-events-none absolute left-1.5 flex size-3.5 items-center justify-center";

/**
 * The mark itself. `text-current` is not decoration — it is how the glyph opts
 * out of {@link MENU_ROW}'s muted-icon rule, which reads "unless it carries its
 * own `text-*`". A selection mark is the row's subject, so it takes the label's
 * ink, including the accent ink a focused row switches to.
 */
export const MENU_INDICATOR_MARK = "text-current";

/**
 * Sentence-case group header on the section-heading rung.
 * The shared heading recipe owns type; menus add their row inset.
 */
export const MENU_LABEL = cn("pr-2 pl-6 py-1", SECTION_HEADING, "font-semibold");

/**
 * {@link MENU_LABEL} again, as the variant cmdk needs — it renders the group
 * heading itself, so the classes can only reach it through a selector.
 */
export const MENU_LABEL_CMDK = cn(
  SECTION_HEADING_CMDK,
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-semibold",
);

/**
 * The shortcut column. No `tracking-widest` (stock shadcn's): letter spacing is
 * applied AFTER the last glyph as well as between them, so every chord sits a
 * pixel short of the right edge and the column reads inset from the menu's own
 * padding — visible precisely because `ml-auto` promised it would be flush, and
 * worse with rows of different width stacked. Latin chords absorb it; the ⌥⌘
 * glyph runs this app actually ships (⌘D, ⇧⌘D, ⌘T, ⌥⌘T) do not.
 */
export const MENU_SHORTCUT =
  "ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center px-1 text-ui font-normal font-sans whitespace-nowrap text-muted-foreground";

/** Shared separated search field and hint strip for cmdk and its two dialogs. */
export const COMMAND_SEARCH_FIELD =
  "search-capsule m-2 flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-full border border-border-strong bg-transparent px-3";
export const COMMAND_OVERLAY_FRAME =
  "fixed top-[18%] left-1/2 z-50 flex max-h-[calc(82svh-2rem)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-menu border border-border bg-popover text-ui text-foreground shadow-overlay outline-none";
export const COMMAND_FOOTER =
  "flex min-h-9 shrink-0 flex-wrap items-center justify-end gap-4 bg-muted/30 px-2 py-2 relative before:absolute before:top-0 before:left-1/2 before:h-px before:w-4/5 before:-translate-x-1/2 before:bg-border text-ui font-normal text-muted-foreground";

/** Centered inset hairline, leaving the frame edges uninterrupted. */
export const MENU_SEPARATOR = "mx-2 my-1 h-px bg-border";

/**
 * No-results copy: one row's worth of air above and below, at the row's size.
 *
 * Which is the app's inline empty state exactly, so it IS that constant rather
 * than a menu-shaped copy of it — a dropdown with nothing in it says the same
 * thing at the same scale as a sidebar band with nothing in it.
 */
export const MENU_EMPTY = EMPTY_INLINE;

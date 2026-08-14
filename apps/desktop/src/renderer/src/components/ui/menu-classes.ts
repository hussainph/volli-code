/**
 * The one place menu geometry is spelled. A menu row is a control, and this
 * app's control is 28px tall at `text-ui` — `ui/button.tsx`'s `default` size and
 * docs/DESIGN.md's pill scale both say so. The menus were the only control
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

/**
 * The popover box, shared by root menus, sub-menus and the select surface —
 * one elevation for all three, so a sub-menu does not read as floating above
 * the menu that opened it.
 */
export const MENU_SURFACE =
  "z-50 min-w-[8rem] rounded-md border bg-popover text-popover-foreground shadow-md";

/**
 * The 4px the rows sit inside. Separate from {@link MENU_SURFACE} because the
 * select surface puts it on the scroll viewport instead — its scroll buttons
 * are siblings of the rows, not part of the padded column.
 */
export const MENU_SURFACE_PAD = "p-1";

/** Open and close, shared by every menu surface. */
export const MENU_SURFACE_MOTION =
  "motion-reduce:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

/**
 * The 28px row: a 20px `text-ui` line box plus `py-1`, 8px of side padding, a
 * 14px glyph 8px off the label. A leading glyph is muted unless it carries its
 * own `text-*` — which is also the door a selection mark uses to opt back into
 * the row's ink, see {@link MENU_INDICATOR_MARK}.
 */
export const MENU_ROW =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1 text-ui outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground";

/** Radix row states: `focus` is the roving highlight, `data-disabled` a bare attribute. */
export const MENU_ROW_STATE =
  "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/** cmdk row states: a controlled `data-selected`, and `data-disabled="true"`. */
export const MENU_ROW_STATE_CMDK =
  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50";

/** A sub-menu trigger stays lit for as long as the surface it opened is up. */
export const MENU_ROW_OPEN = "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

/** The destructive row, and its glyph, which the muted-icon rule must not claim. */
export const MENU_ROW_DESTRUCTIVE =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive!";

/**
 * Rows that can carry a selection mark reserve the column on the RIGHT rather
 * than stock shadcn's leading `pl-8`: these menus put their own icons up front,
 * and an empty check column ahead of them read as dead space. 28px clears the
 * 14px mark at its 8px inset with room to spare.
 */
export const MENU_ROW_INDICATED = "pr-7";

/** The box the selection mark is centred in, at the row's trailing edge. */
export const MENU_INDICATOR =
  "pointer-events-none absolute right-2 flex size-3.5 items-center justify-center";

/**
 * The mark itself. `text-current` is not decoration — it is how the glyph opts
 * out of {@link MENU_ROW}'s muted-icon rule, which reads "unless it carries its
 * own `text-*`". A selection mark is the row's subject, so it takes the label's
 * ink, including the accent ink a focused row switches to.
 */
export const MENU_INDICATOR_MARK = "text-current";

/** Section label: 11px caps at 24px, a step below the rows it introduces. */
export const MENU_LABEL = "px-2 py-1 text-label uppercase text-muted-foreground";

/**
 * {@link MENU_LABEL} again, as the variant cmdk needs — it renders the group
 * heading itself, so the classes can only reach it through a selector. Written
 * out rather than derived: Tailwind resolves utilities by scanning source text,
 * so a prefix computed at runtime would emit no CSS at all.
 */
export const MENU_LABEL_CMDK =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground";

/**
 * The shortcut column. No `tracking-widest` (stock shadcn's): letter spacing is
 * applied AFTER the last glyph as well as between them, so every chord sits a
 * pixel short of the right edge and the column reads inset from the menu's own
 * padding — visible precisely because `ml-auto` promised it would be flush, and
 * worse with rows of different width stacked. Latin chords absorb it; the ⌥⌘
 * glyph runs this app actually ships (⌘D, ⇧⌘D, ⌘T, ⌥⌘T) do not.
 */
export const MENU_SHORTCUT = "ml-auto text-xs text-muted-foreground";

/** Hairline, bled back out through the surface's 4px padding to both walls. */
export const MENU_SEPARATOR = "-mx-1 my-1 h-px bg-border";

/** No-results copy: one row's worth of air above and below, at the row's size. */
export const MENU_EMPTY = "py-4 text-center text-ui";

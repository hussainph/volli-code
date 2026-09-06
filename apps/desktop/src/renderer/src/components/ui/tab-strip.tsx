/**
 * The app's one tab strip.
 *
 * Three surfaces drew this object before: Project Files
 * (`files/file-tab-strip.tsx`, retired with the Files page — VC-122), the
 * ticket detail (`ticket/ticket-tabs.tsx`) and Home's own strip
 * (`home/home-tab-strip.tsx`, which absorbed Project Files' tab vocabulary
 * when that page retired). Large stretches of the three were byte-identical —
 * the same transition string, the same
 * hover-revealed close, the same unsaved dot, the same strip container, the
 * same roving-tabindex helper written out three times — and the comments in all
 * three admitted it ("same technique as…", "mirroring the ticket tab strip…").
 * What differed was never a decision: two strips sat at `h-8 text-sm`, which
 * `docs/DESIGN.md` reserves for the rare hero control, and the third at
 * `h-7 text-ui`, which is what a tab actually is. This file is the third one's
 * size, drawn twice.
 *
 * TWO DRAWINGS, one object:
 *
 *  - **folder** — the Chrome-browser tab. Rounded top corners, and the active
 *    tab bleeds 1px past the strip's bottom border (`-mb-px`) so its fill
 *    covers that seam and the tab reads as physically joined to the plane
 *    below. For a strip that IS the top edge of the thing it switches.
 *  - **pill** — the inline tab. A rounded rectangle floating in a centred band,
 *    active by fill rather than by fusing with anything. For a strip that sits
 *    above a surface it does not own.
 *
 * WHAT STAYS WITH THE CALLER: which tabs exist, their order, what a selection
 * means, what a close guards, and every context menu. This file owns the
 * drawing and the focus mechanics — nothing else. `Tab` forwards its rest props
 * to the `role="tab"` element, which is both how a caller attaches its own
 * `data-*` hooks and how Radix's `ContextMenuTrigger asChild` merges its
 * listeners and ref in; a shell that dropped them would be a tab whose
 * right-click opens nothing.
 *
 * ARRANGEMENT (VC-189) is opt-in and stays the caller's too: hand {@link
 * TabStrip} a `reorder` and give each movable tab a `dragId`, and the strip
 * grows a horizontal dnd-kit sortable over its `role="tab"` elements. A strip
 * that passes neither mounts no `DndContext` at all and is byte-for-byte the
 * fixed strip it was. What order a drop MEANS is `tab-reorder.ts`; where that
 * order is kept is the workspace store's `tabOrder` overlay.
 *
 * SINCE VC-202 a strip may also arrange inside a SURFACE that owns several of
 * them ({@link TabStripSurface}): a split plane draws one strip per pane, and a
 * tab has to be able to travel from one to another and onto the plane's drop
 * zones — which is one gesture, so it must be one `DndContext`. A strip inside
 * such a surface registers its sortable into that context and mounts none of
 * its own; a strip with no surface above it is exactly the strip it was.
 */
import * as React from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TabOrder } from "@volli/shared";

// Imported rather than accepted as a slot so the two strips that rename cannot
// drift the field's size apart again — which is exactly what they had done
// (`h-5 w-40 text-ui` against `h-5 w-32 text-sm`). The field owns that size now,
// so a strip states only its width.
import { InlineRename } from "@renderer/components/ui/inline-rename";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { TitleReveal } from "@renderer/components/ui/title-reveal";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

import { movedTabIndex, successorTabIndex, tabFocusMove, type TabFocusMove } from "./tab-focus";
import { tabDropOrder } from "./tab-reorder";
import { scrollTabsWithWheel } from "./tab-scroll";

export type TabVariant = "folder" | "pill";

/**
 * The variant travels by context rather than by prop because a strip's tabs are
 * wrapped — every renamable tab sits inside a `ContextMenu`, so the strip
 * cannot reach its `Tab` children to clone the value in, and a caller repeating
 * `variant` on every tab is one `map` callback away from a strip with two
 * drawings in it.
 */
const TabVariantContext = React.createContext<TabVariant>("folder");

/**
 * Whether this strip arranges. Travels by context for the same reason the
 * variant does — a tab is wrapped in its own context menu, so the strip cannot
 * reach its `Tab` children — and it exists at all because `useSortable` is a
 * hook: a tab may not decide per render whether to call one. The flag chooses
 * between two components instead, and the tabs of a fixed strip register
 * nothing with dnd-kit rather than registering a disabled sortable.
 */
const TabReorderContext = React.createContext(false);

/**
 * Whether an ancestor owns this strip's drag (VC-202).
 *
 * A surface that draws several strips — a split plane, one strip per pane —
 * mounts ONE `DndContext` around all of them and the plane they sit over, so a
 * tab can be carried from one strip to another or onto a drop zone. Inside
 * one, a strip contributes only its `SortableContext`: no second context, no
 * sensors of its own, and no modifiers (the surface draws the travel with a
 * `DragOverlay` ghost instead, because a strip that scrolls would clip a tab
 * dragged out of it).
 *
 * Default `false` — every strip that is nobody's pane (Settings, the lab, a
 * fixture) keeps its own context and its own axis modifiers, unchanged.
 */
const TabStripSurfaceContext = React.createContext(false);

/**
 * Marks the subtree whose strips register into the caller's own `DndContext`.
 * Rendered by `split/split-dnd.tsx`, which is also what supplies that context.
 */
export function TabStripSurface({ children }: { children: React.ReactNode }) {
  return <TabStripSurfaceContext.Provider value>{children}</TabStripSurfaceContext.Provider>;
}

/** Whether a strip drawn here belongs to a surface-level drag context. */
export function useTabStripSurface(): boolean {
  return React.useContext(TabStripSurfaceContext);
}

// ---------------------------------------------------------------------------
// Focus, in the DOM

/**
 * A tab's siblings and its own place among them, read live out of the enclosing
 * `role="tablist"`. No ref registry: the tab list is a DOM fact, and a registry
 * would be a second copy of it to keep in sync.
 */
function stripTabs(from: HTMLElement): { tabs: HTMLElement[]; index: number } | null {
  const tablist = from.closest('[role="tablist"]');
  if (tablist === null) return null;
  const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
  const index = tabs.indexOf(from);
  return index === -1 ? null : { tabs, index };
}

/** Arrow/Home/End roving focus, from the tab the key landed on. */
function moveTabFocus(from: HTMLElement, move: TabFocusMove): void {
  const found = stripTabs(from);
  if (found === null) return;
  const next = movedTabIndex(found.tabs.length, found.index, move);
  if (next !== null) found.tabs[next]?.focus();
}

/**
 * Hand focus to the tab that will survive this close.
 *
 * Called from inside the × that is about to unmount, BEFORE the close lands, so
 * the successor is picked from the strip as it stands and the next Arrow keeps
 * moving from where the closed tab was.
 *
 * The accepted trade: a close the caller then CANCELS (a dirty-file guard) has
 * already moved focus to the successor. Acceptable — the alternative is
 * deferring focus until every async guard has resolved, by which point the
 * closed tab is gone and there is nothing left to move from.
 */
function focusSuccessorTab(from: HTMLElement): void {
  const tab = from.closest<HTMLElement>('[role="tab"]');
  if (tab === null) return;
  const found = stripTabs(tab);
  if (found === null) return;
  const successor = successorTabIndex(found.tabs.length, found.index);
  if (successor !== null) found.tabs[successor]?.focus();
}

// ---------------------------------------------------------------------------
// The strip

/**
 * Drag-to-reorder, as the caller's half of the bargain (VC-189).
 *
 * `ids` is the strip's MOVABLE tabs in drawn order: the permanent first tab is
 * left out, so it is neither draggable nor a place anything can be dropped.
 * Build it however is convenient — the strip holds its identity steady for
 * dnd-kit itself ({@link useSteadyIds}).
 */
export interface TabStripReorder {
  ids: TabOrder;
  /** A drop that moved something: what moved, and the movable ids after it. */
  onReorder(movedId: string, ids: TabOrder): void;
}

export interface TabStripProps extends React.ComponentProps<"div"> {
  variant?: TabVariant;
  /**
   * The tablist's accessible name. Not optional: a ticket screen draws a second
   * tablist (the details rail's page switcher) on the same frame, so an
   * unnamed strip leaves both AT and every `getByRole("tablist")` query with no
   * way to say which one it means.
   */
  label: string;
  /**
   * The trailing cluster, past a divider — session-start controls, a rail
   * toggle. Tabs are places; everything here acts on them, and the rule plus
   * the vertical alignment is what keeps a ghost button from reading as one
   * more tab.
   */
  actions?: React.ReactNode;
  /**
   * Opt into drag-to-reorder. Absent — and the strip mounts no `DndContext`,
   * no sensors and no sortable: a strip nobody arranges pays nothing.
   */
  reorder?: TabStripReorder;
}

export function TabStrip({
  variant = "folder",
  label,
  actions,
  reorder,
  className,
  children,
  ...props
}: TabStripProps) {
  const folder = variant === "folder";
  // A surface above us already owns the gesture — see TabStripSurfaceContext.
  const inSurface = React.useContext(TabStripSurfaceContext);
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;

    // Trackpads already produce a horizontal delta. A mouse needs Shift+wheel
    // to reach clipped tabs; React's wheel listener is passive, so this must
    // be a native listener for preventDefault to keep the gesture on the strip.
    const onWheel = (event: WheelEvent) => {
      scrollTabsWithWheel(scroller, event);
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  const strip = (
    <div
      data-slot="tab-strip"
      data-variant={variant}
      className={cn(
        "flex shrink-0 border-b border-border bg-rail",
        // A folder strip is only as tall as its tabs plus the 4px above them,
        // because the tabs ARE its bottom edge. A pill strip centres its tabs
        // in a band of its own.
        folder ? "items-end pt-1" : "h-9 items-center gap-1 px-2",
        className,
      )}
      {...props}
    >
      <div
        ref={scrollerRef}
        data-slot="tab-scroll"
        className={cn(
          "flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          folder ? "items-end px-2" : "items-center",
        )}
      >
        <div
          role="tablist"
          aria-label={label}
          aria-orientation="horizontal"
          className={cn("flex gap-1", folder ? "items-end" : "items-center")}
        >
          <TabVariantContext.Provider value={variant}>
            {reorder === undefined ? (
              children
            ) : (
              // Inside the tablist, where the tabs are; the sensors and the
              // DndContext sit outside it (below) so dnd-kit's two hidden
              // announcement nodes are not children of a `role="tablist"`.
              <SortableTabs ids={reorder.ids}>{children}</SortableTabs>
            )}
          </TabVariantContext.Provider>
        </div>
      </div>
      {actions !== undefined ? (
        // The divider is half the separation; vertical alignment is the rest.
        // Tabs sit on the strip's bottom edge because they fuse with the plane
        // below, so a control spanning the band's full height cannot be
        // mistaken for one however it is styled. `-mt-1` cancels the strip's
        // own top pad so the column reaches the true top edge.
        <div
          className={cn(
            "flex shrink-0 border-l border-border/70",
            folder ? "-mt-1 items-stretch self-stretch pr-1 pl-2" : "items-center pl-2",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );

  if (reorder === undefined || inSurface) return strip;
  return <TabStripDnd reorder={reorder}>{strip}</TabStripDnd>;
}

/** The sortable list itself, and the flag that tells a tab it may register. */
function SortableTabs({ ids, children }: { ids: TabOrder; children: React.ReactNode }) {
  return (
    // `items` is typed mutable though dnd-kit never writes to it; these ids are
    // the same readonly list the order model uses everywhere else.
    <SortableContext items={useSteadyIds(ids) as string[]} strategy={horizontalListSortingStrategy}>
      <TabReorderContext.Provider value>{children}</TabReorderContext.Provider>
    </SortableContext>
  );
}

/**
 * The same ids, at the same array identity until one of them actually changes.
 *
 * `SortableContext` keys its context value on this array, so a fresh one per
 * render re-renders every sortable tab and re-measures the strip. Both strips
 * compose their descriptors from scratch on every render — and re-render on
 * every streamed chat token — so "a fresh one per render" is the default, not
 * the exception. Held here rather than asked of each caller: there is one right
 * answer, and it is not one every strip should have to remember.
 */
function useSteadyIds(ids: TabOrder): TabOrder {
  const steady = React.useRef(ids);
  const same =
    steady.current.length === ids.length && steady.current.every((id, i) => id === ids[i]);
  // A cache write during render: same value in, same value out, so it is
  // idempotent and safe under a re-render React throws away.
  if (!same) steady.current = ids;
  return steady.current;
}

/**
 * The strip's drag machinery: sensors, collision, modifiers, and the one
 * handler that turns a drop into an arrangement.
 *
 * Its own component so a strip that does not arrange mounts none of it — and
 * so the hooks below are unconditional.
 *
 * `distance: 4` on the pointer keeps a plain click (select), a double-click
 * (rename / Keep Open) and the hover-revealed × working; the drag engages only
 * after real travel, the same constraint the board and the project rail use.
 * The keyboard sensor is what makes arranging reachable without a pointer: it
 * claims Space on a tab, and `Tab` below hands it exactly that key (see the
 * keydown there for the Enter/Space split it forces).
 *
 * Horizontal-axis and parent-element modifiers because a tab strip is one row
 * that owns its own width: a tab must not be liftable out of its strip, and
 * vertical travel would only ever be noise from a hand moving sideways.
 */
function TabStripDnd({
  reorder,
  children,
}: {
  reorder: TabStripReorder;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd({ active, over }: DragEndEvent) {
    const drop = tabDropOrder(
      reorder.ids,
      String(active.id),
      over === null ? null : String(over.id),
    );
    if (drop !== null) reorder.onReorder(drop.movedId, drop.ids);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      {children}
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// The tab

/** An inline rename in progress, in place of the label. */
export interface TabRenaming {
  value: string;
  onCommit(next: string): void;
  onCancel(): void;
}

export interface TabProps extends React.ComponentPropsWithRef<"div"> {
  /**
   * The tab's name — its label AND its accessible name, spelled explicitly.
   * Without the explicit name AT computes one from the whole subtree, absorbs
   * the close button's "Close <label>", and reads the tab doubled.
   */
  label: string;
  /**
   * A quieter line after the label, IN the tab — the Project Files strip's
   * parent-directory disambiguator for two tabs that share a basename. Not a
   * tooltip: `title` (a plain div prop) is the tooltip.
   */
  hint?: string;
  active: boolean;
  /**
   * This tab holds the strip's single entry point in the document's tab order.
   * Computed by the caller with {@link tabStopIndex}, which is where the "and
   * the first tab when nothing is active" rule lives.
   */
  tabStop: boolean;
  /** A Session's liveness, leading. The one status map (`ui/status-dot.tsx`). */
  status?: StatusDotState;
  /** Anything else leading: a kind glyph, a park badge. */
  leading?: React.ReactNode;
  /** A quiet mark between the leading slot and the label (Files' worktree dot). */
  badge?: React.ReactNode;
  /** Whether this tab shows a close affordance at all. */
  closable?: boolean;
  /**
   * Unsaved work. The close control becomes the dot — always visible, because
   * a draft has to be findable from across the strip — and turns back into an ×
   * on hover so the tab still closes in one click.
   */
  dirty?: boolean;
  /** Treatments on the label itself: italic for a preview, struck for an exit. */
  labelClassName?: string;
  /**
   * Reveal the label word by word when it CHANGES (VC-81's landing-title
   * motion). Opt-in: only chat Session tabs carry it — a file tab's label
   * swaps on every save and a reveal there would read as the strip stuttering.
   * Never animates on first mount, and never under reduced motion.
   */
  revealLabel?: boolean;
  /** Non-null while this tab is being renamed in place. */
  renaming?: TabRenaming | null;
  /**
   * This tab's identity for a strip that ARRANGES (VC-189) — the same id the
   * caller put in {@link TabStripReorder.ids}. Omit it and the tab does not
   * drag and cannot be dropped on, which is exactly what the permanent first
   * tab (Board / Body) passes. Ignored by a strip with no `reorder`.
   */
  dragId?: string;
  /** Not `onSelect`, which a div already owns as a DOM event. */
  onActivate(): void;
  onClose?(): void;
}

/**
 * dnd-kit's live state for one tab, or `null` for a tab that does not drag.
 * Internal: {@link Tab} decides which of the two it is.
 */
interface TabDrag {
  listeners: DraggableSyntheticListeners;
  dragging: boolean;
}

/**
 * Sibling shift while a drag reorders the strip. The board's value
 * (`ticket-card.tsx`'s `SORT_TRANSITION`) by deliberate copy of the NUMBER,
 * not by import: one is a card crossing a column, the other is a tab crossing a
 * strip, and the day one of them wants a different curve it should be able to
 * have it without moving the other. dnd-kit's own 250ms default reads floaty
 * for both.
 */
const TAB_SORT_TRANSITION = { duration: 180, easing: "var(--ease-out)" };

export function Tab({ dragId, ...props }: TabProps) {
  const arranges = React.useContext(TabReorderContext);
  // Two components rather than a conditional hook — see TabReorderContext. A
  // fixed strip's tabs, and the permanent tab of an arranging one, render the
  // shell directly and touch no dnd-kit machinery at all.
  if (!arranges || dragId === undefined) return <TabShell {...props} />;
  return <SortableTab {...props} dragId={dragId} />;
}

/**
 * One draggable tab: dnd-kit's sortable, wrapped around the same shell every
 * other tab draws.
 *
 * A tab being RENAMED does not drag. The inline field lives inside the tab, and
 * the pointer sensor would read a drag across the text you are trying to select
 * as a drag of the tab under it — dnd-kit even clears the document selection
 * once a drag activates. Commit or cancel first; the tab is still there.
 */
function SortableTab({ dragId, ...props }: TabProps & { dragId: string }) {
  const reducedMotion = useReducedMotion();
  const inSurface = React.useContext(TabStripSurfaceContext);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dragId,
    // `null` is dnd-kit's own "do not animate": under reduced motion the
    // siblings jump to their new places instead of sliding (same gate the board
    // card takes).
    transition: reducedMotion ? null : TAB_SORT_TRANSITION,
    // What the surface's `DragOverlay` ghost draws (VC-202). The label rather
    // than the descriptor: the ghost is the tab's own drawing, and the tab's
    // own drawing is what this component already is.
    data: { tabLabel: props.label },
  });
  const renamingNow = props.renaming !== null && props.renaming !== undefined;
  const ref = useComposedTabRef(setNodeRef, props.ref);
  // Inside a surface the TRAVEL is the ghost's (a strip scrolls, so a tab
  // dragged out of one would be clipped by it). The tab stays in its slot and
  // recedes, which is also what says where it came from.
  const ghosted = inSurface && isDragging;

  return (
    <TabShell
      {...props}
      ref={ref}
      // dnd-kit's `attributes` are NOT spread: they carry `role="button"`, a
      // `tabIndex` of their own and `aria-roledescription="draggable"`, each of
      // which would overwrite something a tab must keep saying — its role, the
      // strip's roving tabindex, and its own name. The described-by is the one
      // that adds: it points at dnd-kit's hidden instructions, which is how a
      // screen reader learns Space picks the tab up.
      aria-describedby={attributes["aria-describedby"]}
      style={{
        ...props.style,
        transform: ghosted ? undefined : CSS.Transform.toString(transform),
        transition: transition ?? undefined,
      }}
      // Above its neighbours while it travels, so the tab being dragged is not
      // drawn under the ones it is passing.
      className={cn(isDragging && "z-10", ghosted && "opacity-40", props.className)}
      drag={renamingNow ? null : { listeners, dragging: isDragging }}
    />
  );
}

/**
 * dnd-kit's node ref joined with whatever ref the caller already put on the tab
 * — Radix's `ContextMenuTrigger asChild` puts one on every tab that has a menu.
 *
 * The identity of the returned callback never changes, and that is the point:
 * Radix memoizes ITS composed ref on the child's, so a fresh closure per render
 * would make React detach and re-attach the node on every render — and a node
 * that goes null mid-drag is a drag dnd-kit can no longer measure.
 */
function useComposedTabRef(
  setNodeRef: (node: HTMLElement | null) => void,
  outer: React.Ref<HTMLDivElement> | undefined,
): (node: HTMLDivElement | null) => void {
  const latest = React.useRef(outer);
  latest.current = outer;
  return React.useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      const ref = latest.current;
      if (typeof ref === "function") ref(node);
      else if (ref !== null && ref !== undefined) ref.current = node;
    },
    [setNodeRef],
  );
}

function TabShell({
  label,
  hint,
  active,
  tabStop,
  status,
  leading,
  badge,
  closable = true,
  dirty = false,
  labelClassName,
  revealLabel = false,
  renaming = null,
  drag = null,
  onActivate,
  onClose,
  className,
  ...props
}: TabProps & { drag?: TabDrag | null }) {
  const variant = React.useContext(TabVariantContext);
  const folder = variant === "folder";
  const renamingNow = renaming !== null && renaming !== undefined;
  // The close is hidden mid-rename on purpose: the only two exits from an
  // inline edit are commit and cancel, and an × that blurs (committing) and
  // then closes is a destructive answer to a control reached for to dismiss.
  const showClose = closable && onClose !== undefined && !renamingNow;

  return (
    <div
      {...props}
      data-slot="tab"
      role="tab"
      aria-label={label}
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      onClick={onActivate}
      // dnd-kit's pointer activator, composed over whatever the caller already
      // listens for here (Radix's context menu uses this event for its
      // long-press). A drag that actually engages stops the click that would
      // follow it, so arranging a tab never also selects it.
      onPointerDown={(event) => {
        props.onPointerDown?.(event);
        drag?.listeners?.onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        // A keyboard drag in flight belongs entirely to dnd-kit's own document
        // listener: arrows move the tab, Space drops it, Escape cancels. The
        // strip's roving focus has to stand down for the duration, or an arrow
        // would walk focus off the very tab being carried.
        if (drag?.dragging === true) return;
        const move = tabFocusMove(event.key);
        if (move !== null) {
          event.preventDefault();
          moveTabFocus(event.currentTarget, move);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          // Activation only when the tab ITSELF has the key: the close × is a
          // real button inside this div, and swallowing its Enter here would
          // select the tab the user was trying to close. Arrows stay unguarded
          // above — roving out of the × is exactly what they are for.
          if (event.target !== event.currentTarget) return;
          // ON A STRIP THAT ARRANGES, SPACE PICKS THE TAB UP and Enter stays
          // the activation. dnd-kit's keyboard sensor claims both keys, a tab
          // needs one of them to select with, and this is the same split the
          // board card makes for the same reason (`ticket-card.tsx`). It is
          // what keeps reorder off the pointer-only list; the sensor's own
          // hidden instructions say "press space", and they are what this tab
          // points its `aria-describedby` at.
          if (event.key === " " && drag?.listeners?.onKeyDown !== undefined) {
            drag.listeners.onKeyDown(event);
            return;
          }
          event.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        // `scale` is in the transition list and `scale-100!` is the
        // reduced-motion cancel — see the press note in `ui/button.tsx`.
        //
        // `transform` LEAVES that list under reduced motion, and it has to be
        // said here rather than left to dnd-kit (VC-189): a sortable tab asks
        // for no transition at all under the flag, but "no transition" means no
        // INLINE one, and this class would then be what animates the sibling
        // shift instead — the very motion the flag turned off. The board card
        // needs no such line because its own transition list is `border-color`
        // alone (`board/ticket-card.tsx`).
        "group relative flex h-7 shrink-0 items-center gap-1 text-ui font-medium outline-none transition-[color,background-color,box-shadow,transform,scale] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-[color,background-color,box-shadow] motion-reduce:scale-100! focus-visible:ring-2 focus-visible:ring-ring/45",
        folder ? "rounded-t-lg" : "rounded-md",
        // A closable tab pays its right inset in the × instead of in padding.
        folder ? (closable ? "pr-1 pl-3" : "px-3") : closable ? "pr-1 pl-2" : "px-2.5",
        active
          ? folder
            ? // -mb-px pulls the active tab 1px past the strip's bottom border
              // so its content-coloured fill covers that seam. `shadow-raised`
              // is the halo that says "active" — carried here rather than by
              // the `[role="tab"][aria-selected="true"]` rule globals.css used
              // to hold, because a shadow you cannot see in the component is a
              // shadow nobody can tell is live.
              "-mb-px bg-background text-foreground shadow-raised"
            : "bg-accent text-foreground shadow-raised"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        className,
      )}
    >
      {/* 8px, not the 6px default: `ui/status-dot.tsx` sizes the dot by where it
          sits, and a tab is the larger of its two homes. */}
      {status !== undefined ? <StatusDot state={status} size="md" /> : null}
      {leading}
      {badge}
      {renamingNow ? (
        <InlineRename
          value={renaming.value}
          ariaLabel={`Rename ${label}`}
          className="w-40"
          onCommit={renaming.onCommit}
          onCancel={renaming.onCancel}
        />
      ) : (
        // A plain span, not a button: the tab div above is the `role="tab"`
        // that click, Enter and Space activate, so there is no nested
        // interactive control inside it.
        <span className={cn("max-w-40 truncate", labelClassName)}>
          {revealLabel ? <TitleReveal text={label} /> : label}
        </span>
      )}
      {hint !== undefined && !renamingNow ? (
        // Dimmer than the tab's own muted ink so it stays subordinate on an
        // ACTIVE tab too, where the label is at full strength. It used to be a
        // step smaller instead; at one type size for the whole tab, weight of
        // colour is what is left to say it with.
        <span
          data-testid="tab-hint"
          className="max-w-28 shrink-0 truncate text-muted-foreground/70"
        >
          {hint}
        </span>
      ) : null}
      {showClose ? <TabClose label={label} dirty={dirty} onClose={onClose} /> : null}
    </div>
  );
}

/**
 * THE TAB IN FLIGHT (VC-202) — what a surface's `DragOverlay` draws while a tab
 * is being carried between panes.
 *
 * The tab's own drawing, so nothing about the object changes on the way: same
 * shell, same folder silhouette, drawn ACTIVE because the tab in your hand is
 * by definition the one you are looking at. Two things are added and they are
 * the whole treatment — `scale-[1.02]`, just enough to say "picked up" without
 * the ghost measuring differently from the slot it will land in, and
 * `shadow-overlay`, the token every lifted surface in this app takes.
 *
 * No transition on either: the ghost is created at its final size, and
 * animating a thing whose whole job is to follow the pointer would put it
 * behind the pointer. It draws no close, takes no focus and is inert.
 */
export function TabDragGhost({ label }: { label: string }) {
  return (
    // Folder, spelled rather than parameterized: both split surfaces draw
    // folder strips, so a variant prop would be a knob nothing turns. The strip
    // that first joins a split surface wearing the pill drawing gets to add it.
    <TabVariantContext.Provider value="folder">
      <TabShell
        // Hidden from AT: the strip the tab came from still lists it, and
        // dnd-kit narrates the drag itself through its own live region — a
        // second `role="tab"` outside any tablist would be a third voice.
        aria-hidden
        data-testid="tab-drag-ghost"
        label={label}
        active
        tabStop={false}
        closable={false}
        className="scale-[1.02] cursor-grabbing shadow-overlay"
        onActivate={noop}
      />
    </TabVariantContext.Provider>
  );
}

function noop(): void {}

/**
 * The hover-revealed close, and the unsaved dot it becomes.
 *
 * Not exported: every one of the three strips put it in the same place, at the
 * same size, with the same stop-propagation and the same successor-focus walk,
 * so there was never a call site that wanted to position it itself. `onClose`
 * on {@link Tab} is the whole surface area.
 */
function TabClose({ label, dirty, onClose }: { label: string; dirty: boolean; onClose(): void }) {
  return (
    <button
      type="button"
      data-slot="tab-close"
      data-testid="tab-close"
      aria-label={`Close ${label}`}
      // Stop the click from reaching the tab's own select handler, and pass the
      // keyboard on to a tab that will still be here afterwards.
      onClick={(event) => {
        event.stopPropagation();
        focusSuccessorTab(event.currentTarget);
        onClose();
      }}
      className={cn(
        // The house hover-reveal contract in full (`ticket/rail-panel-parts.tsx`
        // is the reference): the duration and the reduced-motion escape are
        // part of it, and every tab copy had dropped both.
        "group/close flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-opacity duration-100 hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/45 motion-reduce:transition-none",
        dirty ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      {dirty ? (
        <span
          data-testid="tab-dirty"
          title="Unsaved changes"
          aria-label="Unsaved changes"
          className="size-2 rounded-full bg-primary group-hover/close:hidden"
        />
      ) : null}
      {/* `bold` is the ≤12px tier (CLAUDE.md): at 12px regular draws lighter
          than the label beside it, and coverage is scale-invariant. */}
      <XIcon weight="bold" className={cn("size-3", dirty && "hidden group-hover/close:block")} />
    </button>
  );
}

export { tabStopIndex } from "./tab-focus";

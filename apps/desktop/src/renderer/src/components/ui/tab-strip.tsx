import { TabCascadeContext, useTabCascade } from "./tab-cascade";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "./dropdown-menu";
import { ListRow } from "./list-row";
import { TabActionDropdown, TabActionsContext } from "./tab-actions";
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
 * Both legacy variant names now use Rex-style capsule anatomy. The variant
 * remains a compatible caller contract; it owns no tab or group semantics.
 * Selection, hover and keyboard navigation are immediate. Explicit pointer
 * opens/closes cascade real widths; pointer dragging keeps its sorting clock.
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
 * order is kept is the project UI store's `tabOrder` overlay.
 *
 * SINCE VC-202 a strip may also arrange inside a SURFACE that owns several of
 * them ({@link TabStripSurface}): a split plane draws one strip per pane, and a
 * tab has to be able to travel from one to another and onto the plane's drop
 * zones — which is one gesture, so it must be one `DndContext`. A strip inside
 * such a surface registers its sortable into that context and mounts none of
 * its own; a strip with no surface above it is exactly the strip it was.
 */
import * as React from "react";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";
import "./tab-strip.css";
import {
  ChevronDownIcon,
  CircleIcon,
  SpinnerIcon,
  HelpIcon,
  WarningIcon,
  CloseIcon,
  MinusIcon,
} from "@renderer/components/ui/icon";

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
import { Button } from "@renderer/components/ui/button";
import { InlineRename } from "@renderer/components/ui/inline-rename";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { TitleReveal } from "@renderer/components/ui/title-reveal";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { useClippedReveal } from "@renderer/components/ui/value-reveal";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

import { movedTabIndex, successorTabIndex, tabFocusMove, type TabFocusMove } from "./tab-focus";
import { tabDropOrder } from "./tab-reorder";
import { scrollTabsWithWheel, tabOverflow, tabScrollLeftFor, type TabOverflow } from "./tab-scroll";

interface TabInventoryEntry {
  id: string;
  label: string;
  leading: React.ReactNode;
  detail?: string;
  status?: StatusDotState | null;
  activate(): void;
}
const TabInventoryContext = React.createContext<Map<HTMLElement, TabInventoryEntry> | null>(null);

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
// Retain the last activation through drop/cancel so settling never adds a
// keyboard timeline after dnd-kit clears its active event.
const TabKeyboardDragContext = React.createContext(false);

/**
 * Marks the subtree whose strips register into the caller's own `DndContext`.
 * Rendered by `split/split-dnd.tsx`, which is also what supplies that context.
 */
export function TabStripSurface({
  children,
  keyboardDrag = false,
}: {
  children: React.ReactNode;
  keyboardDrag?: boolean;
}) {
  return (
    <TabStripSurfaceContext.Provider value>
      <TabKeyboardDragContext.Provider value={keyboardDrag}>
        {children}
      </TabKeyboardDragContext.Provider>
    </TabStripSurfaceContext.Provider>
  );
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
 * Scroll `tab` into view inside its own strip (VC-288).
 *
 * `scrollIntoView` is what this would normally be, and it is not usable here:
 * it walks EVERY scrollable ancestor, so revealing a tab in a pane's strip also
 * scrolls the transcript, the rail and the window behind it — a tab selected
 * from a chord would take the whole plane with it. The travel is computed
 * against this one scroller instead (`tab-scroll.ts`) and written to it alone.
 *
 * The tab's offset is read from the two rectangles rather than from
 * `offsetLeft`, which answers relative to the nearest positioned ancestor and
 * would be measured from a different origin the day a strip grows one.
 */
function revealTab(tab: HTMLElement, smooth: boolean): void {
  const scroller = tab.closest<HTMLElement>('[data-slot="tab-scroll"]');
  if (scroller === null) return;
  const box = tab.getBoundingClientRect();
  const port = scroller.getBoundingClientRect();
  const at = tabScrollLeftFor(scroller, {
    left: box.left - port.left + scroller.scrollLeft,
    width: box.width,
  });
  if (at === null) return;
  scrollTabsTo(scroller, at, smooth);
}

/**
 * Reveal the tab this strip is currently ABOUT — after something moved that is
 * neither a selection nor a focus (VC-288 review).
 *
 * The keyboard's tab wins over the selected one: if focus is inside this strip
 * then that is the tab a person is working with, and the two differ for the
 * whole of a walk along the strip with the arrow keys.
 *
 * Never smooth. This is called from a resize — the chevrons mounting, a divider
 * drag, a rail opening — where the layout has already jumped, and a 300ms glide
 * chasing a drag that is still moving reads as the strip lagging the pointer.
 */
function revealCurrentTab(scroller: HTMLElement): void {
  const focused = document.activeElement;
  const focusedTab =
    focused instanceof HTMLElement && scroller.contains(focused)
      ? focused.closest<HTMLElement>('[role="tab"]')
      : null;
  // A nested close/menu/minimise control may have received pointer focus
  // between down and up. Revealing its whole (partly clipped) capsule would
  // move that control away from the pending release. The browser has already
  // revealed the focused control itself; keep its position until focus leaves.
  if (focusedTab !== null && focused !== focusedTab) return;
  const tab =
    focusedTab ?? scroller.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (tab !== null) revealTab(tab, false);
}

/**
 * Write a scroll position, gliding where the platform can and the reader has
 * not asked it not to.
 *
 * `scrollTo` is guarded because jsdom has none: a test environment that
 * measures nothing still has to be able to observe the position this lands on,
 * and `scrollLeft` is the assignment every browser also honours.
 */
function scrollTabsTo(scroller: HTMLElement, at: number, smooth: boolean): void {
  if (smooth && typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ left: at, behavior: "smooth" });
    return;
  }
  scroller.scrollLeft = at;
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
  const inventory = React.useRef(new Map<HTMLElement, TabInventoryEntry>());
  const [inventoryRows, setInventoryRows] = React.useState<TabInventoryEntry[]>([]);
  // A surface above us already owns the gesture — see TabStripSurfaceContext.
  const inSurface = React.useContext(TabStripSurfaceContext);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  // The box the tabs have to fit, chevrons or no chevrons. Measured instead of
  // the scroller because the scroller's width is something the chevrons change
  // — see {@link TabOverflowMeasure}.
  const areaRef = React.useRef<HTMLDivElement>(null);
  const cascade = useTabCascade(areaRef, scrollerRef, inventory.current);

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

  // WHAT IS OUT OF VIEW, AND WHICH WAY (VC-288). Three things move this and
  // only one of them is a scroll: the strip itself resizing (a split, a rail
  // opening, the window), its CONTENT resizing (a tab opened or closed), and
  // the person travelling. The observer watches all three boxes for that
  // reason — a strip that only measured itself would keep offering a chevron to
  // a tab that had since been closed — and it is also why the subscription does
  // not follow `children`: the tablist's own box IS that fact, and a strip whose
  // tabs are composed from scratch on every render (both of them are, and both
  // re-render on every streamed chat token — see {@link useSteadyIds}) would
  // otherwise tear the observer and the listener down and build them again
  // once per token, to observe the element it was already observing.
  const [overflow, setOverflow] = React.useState<TabOverflow>(NO_TAB_OVERFLOW);
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    const area = areaRef.current;
    if (scroller === null || area === null) return;
    // Same measurement in, same object out. This runs on every scroll event of
    // a travel — animation-frame rate for the whole of a Shift+wheel — and a
    // fresh object each time is a fresh state value, so every tab in the strip
    // would re-render to say that nothing about the ends had changed.
    // `sidebar/sidebar-scroll.tsx` bails on its own edge state for exactly this.
    const measure = (): void =>
      setOverflow((current) => {
        const next = tabOverflow({
          areaWidth: area.clientWidth,
          clientWidth: scroller.clientWidth,
          scrollWidth: scroller.scrollWidth,
          scrollLeft: scroller.scrollLeft,
        });
        return current.overflowing === next.overflowing &&
          current.atStart === next.atStart &&
          current.atEnd === next.atEnd
          ? current
          : next;
      });
    // A VIEWPORT RESIZE IS ALSO A REVEAL (VC-288 review). The tab that matters
    // was put in view against the width the strip had at the time; the chevrons
    // mounting, a divider drag, a rail opening and a window resize all hand it a
    // different one, and none of them is a selection or a focus, so nothing else
    // in this file would look again.
    const remeasure = (): void => {
      measure();
      revealCurrentTab(scroller);
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    // Guarded because jsdom ships no `ResizeObserver`, and half the surfaces in
    // this app draw a strip: a component that threw on mount without one would
    // make all of them untestable to buy nothing. Measured once either way, so
    // a strip in that environment still knows whether it overflows at mount.
    //
    // The tablist belongs here too. Content can move the focused/selected tab
    // without changing either viewport box — a preceding title grows, a tab
    // opens or closes — and the promise is about keeping that tab visible, not
    // merely about keeping the chevrons accurate.
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(remeasure) : null;
    resize?.observe(area);
    resize?.observe(scroller);
    const tablist = scroller.firstElementChild;
    if (tablist !== null) resize?.observe(tablist);
    return () => {
      resize?.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, []);

  // AND THE AFFORDANCES THEMSELVES ARE A RESIZE (VC-288 review). Mounting two
  // 24px controls at the ends of the strip takes that width out of the
  // scroller, which can put the tab that was just revealed back under one of
  // them. A browser reports that as a second `ResizeObserver` callback and the
  // effect above would catch it — but only a frame later and only where an
  // observer exists at all, so the strip says it here, in the commit that
  // changed the layout, rather than waiting to be told about its own edit.
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null) revealCurrentTab(scroller);
  }, [overflow.overflowing]);

  const strip = (
    // A PROVIDER OF ITS OWN, so a tab's label reveal works wherever a strip is
    // drawn (VC-288 review). `SidebarProvider` mounts one around the whole app,
    // but a strip is also rendered on its own by a good deal of the test suite
    // and by the fixture gallery, and a Radix tooltip with no provider above it
    // throws. Nesting is allowed and costs one context; what it changes is that
    // a sweep along THIS strip is its own skip-delay group, which is what a row
    // of tabs is anyway.
    <TooltipProvider>
      <div
        data-slot="tab-strip"
        data-variant={variant}
        className={cn(
          // `@container/tab-strip`: what a tab may stop drawing is decided by the
          // width of THIS strip, never the window's. A split puts two of these in
          // one window, and a media query cannot tell them apart.
          "@container/tab-strip flex min-h-11 shrink-0 items-center gap-2 bg-background",
          // A folder strip is only as tall as its tabs plus the 8px above them,
          // because the tabs ARE its bottom edge. A pill strip centres its tabs
          // in a band of its own.
          "py-1",
          className,
        )}
        {...props}
        onPointerLeave={(event) => {
          props.onPointerLeave?.(event);
          cascade.release();
        }}
        onPointerMove={(event) => {
          props.onPointerMove?.(event);
          cascade.activity();
        }}
      >
        {/* THE ROOM THE TABS HAVE, and the one box in here whose width does not
          answer to what is drawn inside it. `flex-1 min-w-0` against the actions
          cluster beside it means this is the strip's width minus that cluster,
          full stop — a chevron mounting cannot change it, which is what lets the
          chevrons be decided from it without deciding themselves (VC-288
          review, `tabOverflow`). */}
        <div
          ref={areaRef}
          data-slot="tab-scroll-area"
          className="tab-track relative flex h-8 min-w-0 flex-1 items-center self-center overflow-hidden rounded-full p-0.5"
        >
          {/* The clip contains wheel/keyboard travel and its edge fades. One
            trailing inventory chevron exposes every tab; there are no scroll
            arrows or extra icon previews competing with the captions. */}
          <div
            ref={scrollerRef}
            data-slot="tab-scroll"
            data-overflow-left={(overflow.overflowing && !overflow.atStart) || undefined}
            data-overflow-right={(overflow.overflowing && !overflow.atEnd) || undefined}
            className={cn(
              "flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              "items-center",
            )}
          >
            <div
              role="tablist"
              aria-label={label}
              aria-orientation="horizontal"
              className="tab-items flex min-w-full items-center gap-0.5"
            >
              <TabCascadeContext.Provider value={cascade.api}>
                <TabInventoryContext.Provider value={inventory.current}>
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
                </TabInventoryContext.Provider>
              </TabCascadeContext.Provider>
            </div>
          </div>
          {overflow.overflowing ? (
            <DropdownMenu
              onOpenChange={(open) => {
                if (open)
                  setInventoryRows(
                    Array.from(
                      scrollerRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
                    ).flatMap((node) => {
                      const row = inventory.current.get(node);
                      return row ? [row] : [];
                    }),
                  );
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="All tabs"
                  className="shrink-0 rounded-full"
                >
                  <ChevronDownIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80" aria-label="All tabs">
                {inventoryRows.map((row) => (
                  <ListRow
                    key={row.id}
                    density="two-line"
                    leading={row.leading}
                    primary={row.label}
                    secondary={row.detail === row.label ? undefined : row.detail}
                    trailing={
                      row.status ? (
                        <span className="text-label text-muted-foreground">{row.status}</span>
                      ) : undefined
                    }
                    onActivate={row.activate}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {actions !== undefined ? (
            <div
              // Named because it is the one part of a strip that does NOT belong
              // to the strip's own pane: these controls act on the surface, so a
              // split main bar has to be able to exclude them when it decides
              // whether a press landed "in" a pane (`split-view-tab-bar.tsx`).
              data-slot="tab-actions"
              className="flex shrink-0 items-center pl-1"
            >
              <TabCascadeContext.Provider value={cascade.api}>{actions}</TabCascadeContext.Provider>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );

  if (reorder === undefined || inSurface) return strip;
  return <TabStripDnd reorder={reorder}>{strip}</TabStripDnd>;
}

/** A strip that has not been measured yet reaches for nothing. */
const NO_TAB_OVERFLOW: TabOverflow = { overflowing: false, atStart: true, atEnd: true };

/**
 * One end of an overflowing strip, as a control.
 *
 * `aria-label` says the DIRECTION IN TABS — "Earlier tabs", "Later tabs" —
 * rather than in pixels or in glyphs. "Scroll left" names the mechanism; what a
 * person is reaching for is the tab that is not on screen, and on a strip that
 * can also be dragged into a new order "left" is a word about the current
 * arrangement rather than about the list.
 *
 * Outside the `role="tablist"`, deliberately: inside it these would join the
 * roving tabindex and be counted by every arrow key as two more tabs.
 */
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
  const [keyboardDrag, setKeyboardDrag] = React.useState(false);
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
      onDragStart={(event) => setKeyboardDrag(event.activatorEvent.type === "keydown")}
      onDragEnd={handleDragEnd}
    >
      <TabKeyboardDragContext.Provider value={keyboardDrag}>
        {children}
      </TabKeyboardDragContext.Provider>
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
   * Details for the clipped-title reveal — the Project Files strip's
   * parent-directory disambiguator for two tabs that share a basename. Never shown in the tab name; its caption stays the pane name alone.
   */
  hint?: string;
  active: boolean;
  /**
   * This tab holds the strip's single entry point in the document's tab order.
   * Computed by the caller with {@link tabStopIndex}, which is where the "and
   * the first tab when nothing is active" rule lives.
   */
  tabStop: boolean;
  /** A Session's liveness, drawn as a state glyph beside or over its kind. */
  status?: StatusDotState;
  /** Anything else leading: a kind glyph, a park badge. */
  leading?: React.ReactNode;
  /** A quiet mark between the leading slot and the label (Files' worktree dot). */
  badge?: React.ReactNode;
  /** Whether this tab shows a close affordance at all. */
  closable?: boolean;
  /** A permanent minimal tab keeps its accessible name but shows its icon only. */
  iconOnly?: boolean;
  /**
   * Unsaved work. The close control becomes the dot — always visible, because
   * a draft has to be findable from across the strip — and turns back into an ×
   * on hover so the tab still closes in one click.
   */
  dirty?: boolean;
  /** Treatments on the label itself: italic for a preview, struck for an exit. */
  labelClassName?: string;
  /**
   * Keep a landing-title label mounted across changes. Only chat Session tabs
   * use it; automaticLabelChange separately grants animation for an explicitly
   * automatic replacement. First mount, rename and unknown changes stay static.
   */
  revealLabel?: boolean;
  /** Only an explicitly automatic title replacement may reveal. */
  automaticLabelChange?: boolean;
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
  /** Rich member rows for a group tab; ordinary tabs use their action list. */
  actionsContent?: React.ReactNode;
  /** A group's hover inspection steps aside while its command menu is open. */
  onActionsOpenChange?(open: boolean): void;
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
const TAB_SORT_TRANSITION = { duration: GLASS_MOTION.menuIn, easing: "var(--ease-out)" };

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
  const keyboardDrag = React.useContext(TabKeyboardDragContext);
  const instant = reducedMotion || keyboardDrag;
  const inSurface = React.useContext(TabStripSurfaceContext);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dragId,
    // `null` is dnd-kit's own "do not animate": under reduced motion the
    // siblings jump to their new places instead of sliding (same gate the board
    // card takes).
    transition: instant ? null : TAB_SORT_TRANSITION,
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
        // Surface strips use fixed tab-edge pairing targets. Moving siblings
        // during a drag would separate the visible edge from its hit box.
        transform: inSurface ? undefined : CSS.Transform.toString(transform),
        transition: instant ? "none" : (transition ?? undefined),
      }}
      // Above its neighbours while it travels, so the tab being dragged is not
      // drawn under the ones it is passing, and the hand closes on it while it
      // carries the tab.
      className={cn(isDragging && "z-10 cursor-grabbing", ghosted && "opacity-40", props.className)}
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
  iconOnly = false,
  dirty = false,
  labelClassName,
  revealLabel = false,
  automaticLabelChange = false,
  renaming = null,
  drag = null,
  onActivate,
  onClose,
  actionsContent,
  onActionsOpenChange,
  className,
  ...props
}: TabProps & { drag?: TabDrag | null }) {
  const extraActions = React.useContext(TabActionsContext);
  const cascade = React.useContext(TabCascadeContext);
  const variant = React.useContext(TabVariantContext);
  const folder = variant === "folder";
  const renamingNow = renaming !== null && renaming !== undefined;
  // Composed rather than assigned: `props.ref` is already dnd-kit's node ref
  // joined with Radix's context-menu one, and a second `ref` on the element
  // would silently replace both.
  const shellRef = React.useRef<HTMLDivElement>(null);
  const setShell = useComposedTabRef(
    React.useCallback((node: HTMLElement | null) => {
      shellRef.current = node as HTMLDivElement | null;
    }, []),
    props.ref,
  );
  // A SELECTED TAB IS BROUGHT INTO VIEW (VC-288). A strip narrower than its
  // tabs could hold the selection off-screen indefinitely — open a file from
  // the palette in a split pane and the tab that opened was simply not there.
  // A layout effect, so the travel is part of the frame the selection lands on
  // rather than a jump after it; keyed on `active` alone, because a tab that is
  // already selected must not re-centre itself on every streamed re-render
  // under a person who has scrolled the strip somewhere else.
  React.useLayoutEffect(() => {
    if (!active) return;
    const shell = shellRef.current;
    if (shell === null) return;
    const focused = document.activeElement;
    if (focused !== shell && focused !== null && shell.contains(focused)) return;
    revealTab(shell, false);
  }, [active]);
  // The close is hidden mid-rename on purpose: the only two exits from an
  // inline edit are commit and cancel, and an × that blurs (committing) and
  // then closes is a destructive answer to a control reached for to dismiss.
  const showClose = closable && onClose !== undefined && !renamingNow;
  const menuActions = [
    ...extraActions,
    ...(showClose
      ? [
          {
            label: "Close",
            icon: CloseIcon,
            run: (pointer?: boolean) => {
              cascade?.close(shellRef.current, pointer === true);
              onClose!();
            },
            destructive: true,
          },
        ]
      : []),
  ];
  const hide = extraActions.find((action) => action.label === "Hide to Island");
  // THE WHOLE LABEL, ON HOVER AND ON FOCUS (VC-288 review). The name below is
  // capped at `max-w-40` and truncates, and until now the rest of it lived in
  // `aria-label` alone — an answer for a screen reader and for nothing else,
  // on tabs that do not all carry a `title` either. The reveal rides the tab
  // itself rather than bringing a stop of its own, because a tab IS focusable
  // and a control nested in one is a second press between a person and the
  // place they were going. Short names stay quiet unless they have a location
  // qualifier: basename twins need that detail even when neither name clips.
  const labelRef = React.useRef<HTMLSpanElement>(null);
  const hasDetail = Boolean(hint);
  const reveal = useClippedReveal(labelRef, { hasDetail });
  const detail = hasDetail ? `${label} · ${hint}` : label;
  const inventory = React.useContext(TabInventoryContext);
  const inventoryId = React.useId();
  React.useLayoutEffect(() => {
    const node = shellRef.current;
    if (!inventory || !node) return;
    inventory.set(node, {
      id: inventoryId,
      label,
      leading,
      detail: hint || undefined,
      status,
      activate: () => {
        onActivate();
        revealTab(node, false);
      },
    });
    return () => {
      inventory.delete(node);
    };
  }, [inventory, inventoryId, label, leading, hint, status, onActivate]);

  return (
    // Group tabs already reveal a full-title member card. A second clipped-label
    // tooltip would open over that card (and its action dropdown).
    <Tooltip {...reveal} open={actionsContent ? false : reveal.open}>
      <TooltipTrigger asChild>
        <div
          {...props}
          ref={setShell}
          data-slot="tab"
          data-icon-only={iconOnly || undefined}
          role="tab"
          // Equal file basenames remain distinct to assistive technology and
          // to sighted readers through the same hover/keyboard reveal.
          aria-label={detail}
          aria-selected={active}
          tabIndex={tabStop ? 0 : -1}
          onClick={onActivate}
          // Focus follows the arrows through the roving tabindex, and the strip
          // follows focus. On the element rather than in `moveTabFocus` so it also
          // covers the ways focus arrives that no arrow key touched: Tab into the
          // strip, a successor inheriting focus from a close, a caller's own
          // `.focus()`.
          onFocus={(event) => {
            props.onFocus?.(event);
            // A close button receives pointer focus between down and up. Do
            // not reveal its whole (partly clipped) tab then: moving the close
            // out from under the pointer turns that click into tab activation.
            if (event.target === event.currentTarget) revealTab(event.currentTarget, false);
          }}
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
            // `transform` LEAVES that list under reduced motion, and it has to be
            // said here rather than left to dnd-kit (VC-189): a sortable tab asks
            // for no transition at all under the flag, but "no transition" means no
            // INLINE one, and this class would then be what animates the sibling
            // shift instead — the very motion the flag turned off. The board card
            // needs no such line because its own transition list is `border-color`
            // alone (`board/ticket-card.tsx`).
            // `cursor-default select-none` because a tab is a control, not a
            // line of text: a plain div holding a label gets the browser's
            // text caret, and a press-drag across it paints a text selection
            // instead of answering the click. Every other clickable row has
            // said this since `menu-classes.ts` (VC-381); this was the one
            // row that never did.
            "workspace-capsule-tab group relative flex h-7 min-w-0 shrink-0 cursor-default select-none items-center gap-1 text-ui font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            folder && "workspace-folder-tab",
            closable ? "pr-1 pl-3" : "px-3",
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            className,
          )}
        >
          {leading && status !== undefined ? (
            <span
              data-slot="tab-kind-state"
              className="relative mr-1 flex size-5 shrink-0 items-center justify-center"
            >
              {leading}
              <TabStateIcon state={status} badge />
            </span>
          ) : (
            <>
              {status !== undefined ? <TabStateIcon state={status} /> : null}
              {leading}
            </>
          )}
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
            // interactive control inside it. It is also the element the reveal
            // measures, which is why it is named.
            <span
              ref={labelRef}
              data-slot="tab-label"
              className={cn("min-w-0 flex-1 truncate", iconOnly && "sr-only", labelClassName)}
            >
              {revealLabel ? <TitleReveal text={label} automatic={automaticLabelChange} /> : label}
            </span>
          )}
          {!renamingNow && (menuActions.length > 0 || actionsContent) ? (
            <TabActionDropdown
              label={detail}
              actions={menuActions}
              onOpenChange={onActionsOpenChange}
            >
              {actionsContent}
            </TabActionDropdown>
          ) : null}
          {!renamingNow && hide ? (
            <button
              type="button"
              data-slot="tab-minimise"
              aria-label="Hide to Island"
              title="Hide to Island"
              onPointerDown={(event) => {
                event.stopPropagation();
                // Focusing a partly clipped capsule can scroll its strip
                // between down/up. Keep this press on the actual control,
                // without starting the capsule's drag sensor.
                if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onClick={(event) => {
                event.stopPropagation();
                focusSuccessorTab(event.currentTarget);
                hide.run();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 hover:bg-border hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            >
              <MinusIcon className="size-3" strokeWidth={2.25} />
            </button>
          ) : null}
          {showClose ? (
            <TabClose
              label={detail}
              dirty={dirty}
              onClose={(pointer) => {
                cascade?.close(shellRef.current, pointer);
                onClose();
              }}
            />
          ) : null}
        </div>
      </TooltipTrigger>
      {/* File-location qualifiers are readable on hover/focus even when a
          short basename fits; the caption itself keeps the compact tab shape. */}
      <TooltipContent side="bottom">{detail}</TooltipContent>
    </Tooltip>
  );
}

/** Same four state glyphs as SessionGlyph, over the strip's existing state contract. */
function TabStateIcon({ state, badge = false }: { state: StatusDotState; badge?: boolean }) {
  const busy = state === "working" || state === "setup" || state === "starting";
  const failed = state === "error" || state === "interrupted";
  const Icon = busy
    ? SpinnerIcon
    : state === "waiting"
      ? HelpIcon
      : failed
        ? WarningIcon
        : CircleIcon;
  return (
    <span
      aria-hidden
      data-slot="tab-state"
      data-state={state}
      className={cn(
        "flex shrink-0 items-center justify-center",
        // Tucked inside the 28px tab: hanging a full step below the 20px slot
        // put the badge's lower edge on the scroller's clip line (VC-614).
        badge && "absolute -right-0.5 -bottom-0.5 rounded-full bg-background p-px",
        failed
          ? "text-destructive"
          : state === "waiting"
            ? "text-attention"
            : busy || state === "ready"
              ? "text-positive"
              : "text-muted-foreground",
      )}
    >
      <Icon
        strokeWidth={2.25}
        className={cn(badge ? "size-2.5" : "size-3", busy && "motion-safe:animate-spin")}
      />
    </span>
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
      {/* The ghost draws a tab, and a tab carries a tooltip — so it needs the
          same provider a strip mounts. It will never open one: nothing hovers
          or focuses a thing that is following the pointer. */}
      <TooltipProvider>
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
      </TooltipProvider>
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
function TabClose({
  label,
  dirty,
  onClose,
}: {
  label: string;
  dirty: boolean;
  onClose(pointer: boolean): void;
}) {
  return (
    <button
      type="button"
      data-slot="tab-close"
      data-testid="tab-close"
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={`Close ${label}`}
      // Stop the click from reaching the tab's own select handler, and pass the
      // keyboard on to a tab that will still be here afterwards.
      onClick={(event) => {
        event.stopPropagation();
        focusSuccessorTab(event.currentTarget);
        onClose(event.detail > 0);
      }}
      className={cn(
        // The house hover-reveal contract in full (`ticket/rail-panel-parts.tsx`
        // is the reference): the duration and the reduced-motion escape are
        // part of it, and every tab copy had dropped both.
        "group/close flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-border hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        dirty
          ? "opacity-100"
          : "opacity-0 group-aria-selected:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
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
      {/* The heavier stroke is the ≤12px tier, not a larger drawing. */}
      <CloseIcon
        strokeWidth={2.25}
        className={cn("size-3", dirty && "hidden group-hover/close:block")}
      />
    </button>
  );
}

export { tabStopIndex } from "./tab-focus";

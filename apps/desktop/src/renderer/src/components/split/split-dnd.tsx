/**
 * ONE DRAG CONTEXT PER SURFACE (VC-202 §4).
 *
 * A split plane draws one tab strip per pane and a set of drop zones over the
 * panes themselves, and a tab has to be carried between all of them. That is
 * one gesture, so it is one `DndContext` — mounted here, around the surface's
 * strips AND its grid, with every strip inside it contributing only its
 * `SortableContext` ({@link TabStripSurface}). A surface that never splits
 * still gets exactly the strip it had: the reorder path below is the same
 * `tabDropOrder` arithmetic (VC-189), routed through the pane that drew it.
 *
 * THREE THINGS THIS OWNS, and nothing else:
 *
 *  1. **The context**, so `split-drop-zones.tsx` knows whether a drag is live
 *     and of what — a tab, a Session row, a file row — without every zone
 *     subscribing to the window.
 *  2. **Collision**, which is where the two vocabularies meet. A pointer inside
 *     a zone means the plane; a pointer in a strip's band means the strip, and
 *     there it is `closestCenter` over that strip's tabs, exactly as before.
 *     A pointer in neither (the rail, the sidebar, off-window) means nothing —
 *     the drag is a cancelled gesture rather than a reorder at the last place
 *     the pointer happened to be. (Before VC-202 the axis modifiers made that
 *     impossible by clamping the tab into its strip; the ghost travels instead
 *     now, so the rule has to be stated.)
 *  3. **The ghost**, because a strip is a scroller and would clip a tab dragged
 *     out of it.
 *
 * The native (HTML5) half is not dnd-kit's and cannot be: the sidebars' rows
 * are `draggable` elements outside any of this. They announce themselves
 * through `split-drop.ts`'s slot, this component subscribes, and the zones read
 * one flag either way.
 */
import * as React from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

import {
  isSplitZoneId,
  splitDropAccepts,
  splitTabDropOperation,
  subscribeSplitDrag,
  splitDragSnapshot,
  type SplitDragOrigin,
  type SplitDragPayload,
  type SplitDropOperation,
  type SplitDropZone,
  type SplitPaneTabs,
} from "@renderer/components/split/split-drop";
import { TabDragGhost, TabStripSurface } from "@renderer/components/ui/tab-strip";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";

/** What the zones need to know, and the one handler they raise. */
export interface SplitDndState {
  /** The tab being carried by dnd-kit, or null. */
  activeTabId: string | null;
  /** The native payload in flight AND accepted by this surface, or null. */
  nativePayload: SplitDragPayload | null;
  /** A native drop landed on a zone: the payload, the pane, the zone. */
  onNativeDrop(payload: SplitDragPayload, paneId: string, zone: SplitDropZone): void;
}

const SplitDndStateContext = React.createContext<SplitDndState | null>(null);

/**
 * The surface's drag state, or `null` outside one — which is what a strip in
 * Settings or the lab sees, and what makes the zones render nothing there.
 */
export function useSplitDnd(): SplitDndState | null {
  return React.useContext(SplitDndStateContext);
}

export interface SplitDndProps {
  /** Whose surface this is — what a native payload is checked against. */
  origin: SplitDragOrigin;
  /** Every pane's movable tab ids, in the order that pane draws them. */
  panes: readonly SplitPaneTabs[];
  /** A tab drop that asks for a store write. */
  onTabDrop(operation: SplitDropOperation): void;
  /** A Session or file row dropped on a zone. */
  onNativeDrop(payload: SplitDragPayload, paneId: string, zone: SplitDropZone): void;
  children: React.ReactNode;
}

/**
 * `distance: 4` and the keyboard sensor are the strip's own constraints, moved
 * up one scope unchanged (`ui/tab-strip.tsx` documents why each is what it is):
 * a plain click still selects, a double-click still renames, and Space still
 * picks a tab up for the keyboard.
 */
function useSurfaceSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/**
 * Zones first, then the strip the pointer is in, then nothing.
 *
 * A KEYBOARD drag has no pointer, and zones are pointer-only in v1 (`⌘\` is the
 * keyboard's route to a split) — so with no coordinates this is the plain
 * `closestCenter` over tabs the strip has always used.
 */
const splitCollision: CollisionDetection = (args) => {
  const tabs = args.droppableContainers.filter((container) => !isSplitZoneId(String(container.id)));
  const pointer = args.pointerCoordinates;
  if (pointer === null) return closestCenter({ ...args, droppableContainers: tabs });

  const zones = args.droppableContainers.filter((container) => isSplitZoneId(String(container.id)));
  const inZone = pointerWithin({ ...args, droppableContainers: zones });
  if (inZone.length > 0) return inZone;

  // A strip is one horizontal row: the pointer is "in" it while it is level
  // with its tabs. The slack is the strip's own gap, so the seam between two
  // tabs is not a hole the drag falls through.
  const inBand = tabs.filter((container) => {
    const rect = container.rect.current;
    return rect !== null && pointer.y >= rect.top - 6 && pointer.y <= rect.bottom + 6;
  });
  return inBand.length === 0 ? [] : closestCenter({ ...args, droppableContainers: inBand });
};

export function SplitDnd({ origin, panes, onTabDrop, onNativeDrop, children }: SplitDndProps) {
  const sensors = useSurfaceSensors();
  const reducedMotion = useReducedMotion();
  const [activeTabId, setActiveTabId] = React.useState<string | null>(null);
  const [ghostLabel, setGhostLabel] = React.useState<string | null>(null);
  const nativePayload = useAcceptedNativeDrag(origin);

  // Read at drop time rather than closed over: a drag can outlive several
  // renders (a chat streams a title, a pane resizes), and the panes as they
  // stand when the pointer is released are the ones the drop is about.
  const panesRef = React.useRef(panes);
  panesRef.current = panes;

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveTabId(String(event.active.id));
    const label = event.active.data.current?.tabLabel;
    setGhostLabel(typeof label === "string" ? label : null);
  }, []);

  const handleDragEnd = React.useCallback(
    ({ active, over }: DragEndEvent) => {
      setActiveTabId(null);
      setGhostLabel(null);
      const operation = splitTabDropOperation({
        activeId: String(active.id),
        overId: over === null ? null : String(over.id),
        panes: panesRef.current,
      });
      if (operation !== null) onTabDrop(operation);
    },
    [onTabDrop],
  );

  const handleDragCancel = React.useCallback(() => {
    setActiveTabId(null);
    setGhostLabel(null);
  }, []);

  const state = React.useMemo<SplitDndState>(
    () => ({ activeTabId, nativePayload, onNativeDrop }),
    [activeTabId, nativePayload, onNativeDrop],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={splitCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SplitDndStateContext.Provider value={state}>
        <TabStripSurface>{children}</TabStripSurface>
      </SplitDndStateContext.Provider>
      <DragOverlay
        // The tab returns to its slot in the time a dropdown opens. `null`
        // under reduced motion: a drop that lands is a state change, and the
        // flight back is the decoration the flag turns off.
        dropAnimation={
          reducedMotion ? null : { duration: 150, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
        }
      >
        {ghostLabel === null ? null : <TabDragGhost label={ghostLabel} />}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * The native drag in flight, if this surface may take it.
 *
 * Two facts are ANDed, and each answers a different question. The slot says
 * WHAT is being dragged — it has to, because `dataTransfer.getData()` is
 * unreadable during `dragover` (see `split-drop.ts`). The enter/leave counter
 * says whether the pointer is still over this window at all, so dragging a
 * Session out to another app does not leave a plane lit up behind it.
 */
function useAcceptedNativeDrag(origin: SplitDragOrigin): SplitDragPayload | null {
  const payload = React.useSyncExternalStore(subscribeSplitDrag, splitDragSnapshot);
  const [left, setLeft] = React.useState(false);

  React.useEffect(() => {
    if (payload === null) return;
    // The drag STARTED in this window, so it begins inside and the listeners
    // only have to notice it leaving. `relatedTarget === null` is what a
    // `dragleave` at the window's own edge looks like — crossing between two
    // elements always names the one being entered, so this cannot fire for a
    // drag merely passing over a tab.
    setLeft(false);
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setLeft(true);
    };
    const enter = () => setLeft(false);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragenter", enter);
    return () => {
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragenter", enter);
    };
  }, [payload]);

  if (payload === null || left) return null;
  return splitDropAccepts(payload, origin) ? payload : null;
}

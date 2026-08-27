/**
 * What a drop on a tab strip MEANS — no DOM, no dnd-kit (VC-189, plan §4.3).
 *
 * A `.ts` beside the component for the reason `tab-focus.ts` and
 * `tab-scroll.ts` are: `ui/**.tsx` sits outside the coverage gate as view glue,
 * and "which tab landed where" is exactly the off-by-one nobody notices from a
 * screenshot. `ui/tab-strip.tsx` owns the sensors, the sortable registration
 * and the transforms; this owns the one decision they produce.
 */
import { movedTabOrder, type TabOrder } from "@volli/shared";

/** A drop that changed the strip: what moved, and the strip's new order. */
export interface TabDrop {
  movedId: string;
  ids: TabOrder;
}

/**
 * The arrangement a drop asks for, or `null` for a drop that asks for nothing.
 *
 * `ids` is the strip's MOVABLE half in drawn order — the permanent first tab
 * (Board / Body) is not among them, which is the whole of "index 0 is not a
 * droppable target": a drop over it names an id this list does not hold, and
 * a drop over nothing at all (`overId` null, the pointer left the strip) is a
 * cancelled gesture. Both answer `null` rather than guessing at an edge.
 */
export function tabDropOrder(
  ids: TabOrder,
  activeId: string,
  overId: string | null,
): TabDrop | null {
  if (overId === null || overId === activeId) return null;
  const toIndex = ids.indexOf(overId);
  if (toIndex === -1) return null;
  const next = movedTabOrder(ids, activeId, toIndex);
  // Identity means the move was a no-op — a tab dropped on its own slot, or one
  // this strip does not draw.
  return next === ids ? null : { movedId: activeId, ids: next };
}

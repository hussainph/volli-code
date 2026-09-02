/**
 * A SIDEBAR ROW THAT CAN BE DRAGGED ONTO THE PLANE (VC-202 §4).
 *
 * The rows that open Sessions and files live in the sidebar and in the two
 * rails — outside every dnd-kit context in the app, and rightly so: they are
 * not sortable, they belong to no strip, and a second dnd-kit context around
 * the whole window to serve them would be machinery for a gesture the platform
 * already has. So they drag NATIVELY (HTML5 `draggable` + `dataTransfer`), and
 * this is the half of that bargain every row makes identically.
 *
 * Two channels leave here, and they answer different questions. The
 * `dataTransfer` is the AUTHORITY — it is what the drop reads, and it survives
 * anything. The module slot (`beginSplitDrag`) is the PREVIEW — it is what the
 * zones read while deciding whether to light up, because a browser will not let
 * anyone read `dataTransfer` during `dragover`. Writing both from one place is
 * what keeps them from disagreeing.
 *
 * `payload === null` is a row that is not a door: a terminal Session with no
 * open tab has nothing a pane could hold, so it does not drag at all rather
 * than dragging to a refusal.
 */
import type * as React from "react";

import {
  beginSplitDrag,
  endSplitDrag,
  splitDragPayloadJson,
  splitDragType,
  type SplitDragPayload,
} from "@renderer/components/split/split-drop";

/** What a draggable row spreads onto its own element. */
export interface SplitDragSourceProps {
  draggable?: boolean;
  onDragStart?(event: React.DragEvent<HTMLElement>): void;
  onDragEnd?(): void;
}

export function splitDragSourceProps(payload: SplitDragPayload | null): SplitDragSourceProps {
  if (payload === null) return {};
  return {
    draggable: true,
    onDragStart(event) {
      // "move", not "copy": the Session or file is going somewhere, not being
      // duplicated — and it is the effect the zones then echo back.
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(splitDragType(payload), splitDragPayloadJson(payload));
      beginSplitDrag(payload);
    },
    onDragEnd() {
      endSplitDrag();
    },
  };
}

/**
 * THE DEMARCATED DROP ZONES (VC-202 §4) — one set per pane, drawn only while a
 * drag it could take is live.
 *
 * WHAT IS DRAWN IS THE RESULT, NOT THE TARGET. The three hit regions (centre,
 * an outer band down the right edge, an outer band across the bottom) are
 * invisible; what lights up is the rectangle the drop would leave behind — the
 * whole pane for a centre drop, the right half for a right split, the bottom
 * half for a down split. That is VS Code's `editorDropTarget` reading, and it
 * is the one that answers the question a person actually has mid-drag ("where
 * will this end up?") rather than the one the implementation has ("which
 * region am I over?").
 *
 * ONE preview element, not three, and it is MOUNTED FOR THE WHOLE DRAG: the
 * highlight fades in where the pointer entered and morphs from the centre to a
 * half as it crosses into a band, because it is the same rectangle changing its
 * mind rather than two rectangles swapping — and because nothing in the real
 * world appears from nothing.
 *
 * MOTION, per the decision framework (`docs/plans/split-view.md` §6):
 *  • Opacity and the four box properties, named exactly, 150ms `ease-out`. The
 *    plan asked for 120ms on the fade and 150ms on the morph; one element can
 *    only have one duration without an inline `transition` (which `motion-reduce`
 *    could not then cancel, being a class), and 150ms is the morph's — both
 *    numbers sit under the ceiling for something this frequent, and one element
 *    that never blinks is worth more than 30ms.
 *  • `motion-reduce` cancels all of it: the highlight is the message, the
 *    motion is polish.
 *  • A KEYBOARD split (`⌘\`) never mounts this at all — it is not a drag, and
 *    an action repeated tens of times a day gets no animation.
 *
 * The overlay sits INSIDE the pane's content box (`split-view-grid.tsx` renders
 * it there), which keeps it clear of the pane's own strip: a pointer on a strip
 * is a reorder, and a zone reaching under the strip would swallow that gesture.
 * It paints at `z-20` because a live terminal's viewport box is `z-10` over the
 * same pane, and a zone a terminal covers is a zone nobody can drop on.
 */
import * as React from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";

import {
  parseSplitDragPayload,
  parseSplitZoneId,
  splitDropPreview,
  splitDropZoneAt,
  splitDropZoneLabel,
  splitZoneId,
  SPLIT_DROP_EDGE_BAND_CSS,
  SPLIT_FILE_DRAG_TYPE,
  SPLIT_SESSION_DRAG_TYPE,
  type SplitDropZone,
} from "@renderer/components/split/split-drop";
import { useSplitDnd } from "@renderer/components/split/split-dnd";
import { cn } from "@renderer/lib/utils";

const ZONES: readonly SplitDropZone[] = ["center", "right", "bottom"];

/**
 * The zones of ONE pane. Renders nothing while nothing droppable is in flight
 * — including for a foreign payload, which is how a ticket-A Session dragged
 * over Home says "not here": by there being nowhere to put it.
 */
export function SplitDropZones({ paneId }: { paneId: string }) {
  const dnd = useSplitDnd();
  if (dnd === null) return null;
  if (dnd.activeTabId === null && dnd.nativePayload === null) return null;
  return <ActiveDropZones paneId={paneId} native={dnd.nativePayload !== null} />;
}

/**
 * Split from the component above for the hooks: `useDroppable` may not be
 * called conditionally, and a pane with no drag over the surface must register
 * nothing with dnd-kit at all.
 */
function ActiveDropZones({ paneId, native }: { paneId: string; native: boolean }) {
  const dnd = useSplitDnd();
  const { over } = useDndContext();
  const [nativeZone, setNativeZone] = React.useState<SplitDropZone | null>(null);

  // A tab drag's zone is dnd-kit's own answer (`over`); a native drag is
  // hit-tested here, against the overlay's box. Two mechanisms, one rectangle.
  const dropped = over === null ? null : parseSplitZoneId(String(over.id));
  const zone = native ? nativeZone : dropped?.paneId === paneId ? dropped.zone : null;

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!native) return;
    // Claim the drop before the window can: without `preventDefault` the
    // browser's own handling wins and no `drop` event fires here at all.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    setNativeZone(
      splitDropZoneAt(
        { width: box.width, height: box.height },
        { x: event.clientX - box.left, y: event.clientY - box.top },
      ),
    );
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!native || dnd === null) return;
    event.preventDefault();
    const landed = nativeZone ?? "center";
    setNativeZone(null);
    // The slot said what to DRAW; the transfer is what the drop is decided on
    // (see `split-drop.ts` for why those are two different sources).
    for (const type of [SPLIT_SESSION_DRAG_TYPE, SPLIT_FILE_DRAG_TYPE]) {
      const payload = parseSplitDragPayload(type, event.dataTransfer.getData(type));
      if (payload !== null) {
        dnd.onNativeDrop(payload, paneId, landed);
        return;
      }
    }
  };

  // The rect the preview holds while it fades OUT is the last one it showed, so
  // the highlight leaves from where it was rather than jumping to a default on
  // its way to transparent. A cache write during render: same value in, same
  // value out (the strip's `useSteadyIds` does the same, for the same reason).
  const lastZone = React.useRef<SplitDropZone>("center");
  if (zone !== null) lastZone.current = zone;
  const preview = splitDropPreview(zone ?? lastZone.current);

  return (
    <div
      data-slot="split-drop-zones"
      data-pane-id={paneId}
      // A native Browser view composites above every renderer pixel, so a zone
      // over a browser pane would be invisible and its preview unreadable.
      // This attribute is the browser plane's own duck-out hook
      // (`browser-pane.tsx`): while any drag has these zones mounted, native
      // views hide and the drag reads the same over every kind of pane.
      data-native-plane-overlay=""
      className={cn(
        "absolute inset-0 z-20",
        // A dnd-kit drag is MEASURED, never hit-tested, so the overlay must not
        // stand between the pointer and the tab it is carrying. A native drag
        // is the opposite: the browser routes it by hit-testing, so the overlay
        // is exactly what has to be under the pointer.
        native ? "pointer-events-auto" : "pointer-events-none",
      )}
      onDragOver={handleDragOver}
      // Only when the pointer leaves the OVERLAY, not when it crosses between
      // the regions inside it — `dragleave` bubbles, and clearing on a child's
      // would make the highlight blink every time the pointer changed bands.
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setNativeZone(null);
      }}
      onDrop={handleDrop}
    >
      {ZONES.map((name) => (
        <DropZoneRegion key={name} paneId={paneId} zone={name} active={zone === name} />
      ))}
      <div
        data-slot="split-drop-preview"
        data-zone={zone ?? undefined}
        aria-hidden
        style={preview}
        className={cn(
          "pointer-events-none absolute rounded-md bg-primary/10 ring-1 ring-primary/40 ring-inset",
          "transition-[opacity,left,top,width,height] duration-150 ease-out motion-reduce:transition-none",
          zone === null ? "opacity-0" : "opacity-100",
        )}
      />
    </div>
  );
}

/**
 * One hit region. Invisible by design — the preview above is what a person
 * reads — but named, so the gesture is not silent to AT, and marked with
 * `data-active` so an end-to-end probe can assert which one the pointer is in
 * without measuring pixels.
 */
function DropZoneRegion({
  paneId,
  zone,
  active,
}: {
  paneId: string;
  zone: SplitDropZone;
  active: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: splitZoneId(paneId, zone) });
  return (
    <div
      ref={setNodeRef}
      data-slot="split-drop-zone"
      data-zone={zone}
      data-active={active ? "true" : undefined}
      // The ACT, not the region: an AT user hears "Split right", which is what
      // dropping here does.
      aria-label={splitDropZoneLabel(zone)}
      className="absolute"
      style={ZONE_REGION[zone]}
    />
  );
}

/**
 * Where each hit region sits — the DOM twin of `splitDropZoneAt`, off the same
 * constant (`SPLIT_DROP_EDGE_BAND_CSS`). The three TILE the pane with no
 * overlap, which is what makes dnd-kit's box hit-test and the native path's
 * arithmetic give one answer: a right-hand column, a bottom strip beside it,
 * and the centre that is left.
 */
const BAND = SPLIT_DROP_EDGE_BAND_CSS;
const ZONE_REGION: Record<SplitDropZone, React.CSSProperties> = {
  center: { top: 0, left: 0, right: BAND, bottom: BAND },
  right: { top: 0, right: 0, bottom: 0, width: BAND },
  bottom: { left: 0, right: BAND, bottom: 0, height: BAND },
};

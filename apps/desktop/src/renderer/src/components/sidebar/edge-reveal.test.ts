/**
 * The pointer-intent GEOMETRY, which is the half of the edge reveal that runs
 * without a DOM. The suite pins the precedence order in {@link edgeRegion} —
 * above all the VC-57 carve-out: the chrome-band trigger summons where the
 * band around it suppresses. The timers, phases, and listeners stay in the
 * hook and are exercised by agent-driven UI runs, like the rest of the app's
 * view glue (this suite runs on `environment: "node"`, no DOM).
 */
import { describe, expect, it } from "vite-plus/test";

import { edgeRegion, type EdgeRects, type Point } from "./edge-reveal";

/** A rect the classifier can hit-test, from the numbers a layout would give. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** The shipped shell's shape: a 36px band, a trigger inside it, the 8px strip. */
const RECTS: EdgeRects = {
  band: rect(0, 0, 1200, 36),
  trigger: rect(110, 4, 28, 28),
  zone: rect(60, 60, 8, 740),
  panel: null,
};

const at = (x: number, y: number): Point => ({ x, y });

describe("which rule owns a pointer sample", () => {
  it("gives the trigger its own answer INSIDE the band — the VC-57 carve-out", () => {
    // The trigger's rect is fully inside the band's, so a band-first order
    // would classify this sample as suppression — the arrangement that made
    // hovering the sidebar's own control close the sidebar.
    expect(edgeRegion(at(120, 18), RECTS)).toBe("trigger");
  });

  it("keeps the band's suppression everywhere the trigger is not", () => {
    // One sample either side of the trigger, both still in the band: the
    // traffic-light travel path and the trip toward ⌘K stay dead.
    expect(edgeRegion(at(80, 18), RECTS)).toBe("band");
    expect(edgeRegion(at(160, 18), RECTS)).toBe("band");
  });

  it("reads the strip as the strip, and the rest of the window as outside", () => {
    expect(edgeRegion(at(64, 400), RECTS)).toBe("zone");
    expect(edgeRegion(at(600, 400), RECTS)).toBe("outside");
  });

  it("extends an open panel's grace corridor over the strip", () => {
    // The floating panel starts 8px inside the strip's left edge, so with the
    // panel open a strip sample is inside the padded corridor — and "safe"
    // (stay open) has to win over "zone" (start arming) or the two rules
    // would fight over one pointer.
    const open: EdgeRects = { ...RECTS, panel: rect(68, 60, 258, 700) };
    expect(edgeRegion(at(64, 400), open)).toBe("safe");
    // The corridor pads the panel's rect (32px x, 16px y), so overshooting a
    // nav row to the right is still "safe"…
    expect(edgeRegion(at(350, 400), open)).toBe("safe");
    // …and the same sample with the panel withdrawn is nothing at all.
    expect(edgeRegion(at(350, 400), RECTS)).toBe("outside");
  });

  it("treats unmeasured rects as absent rather than as everywhere", () => {
    const bare: EdgeRects = { band: null, trigger: null, zone: null, panel: null };
    expect(edgeRegion(at(120, 18), bare)).toBe("outside");
  });
});

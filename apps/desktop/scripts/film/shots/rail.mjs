/**
 * Montage · the Now rail (VC-406).
 * Component: src/flute/shots/rail.tsx. Layout: a 340×420 TicketRail column
 * centred on the origin, flat at z=0.
 */
import { ease, mix, progress } from "../lib.mjs";

const RAIL = { width: 340, height: 420 };
const magnify = (m) => 1400 * (1 - 1 / m);

function railRig(format) {
  const wide = format === "wide";
  return (t) => {
    // Already travelling on frame 1 and still travelling on the last: a
    // gentle ease-out on the pan, starting a fifth of the way in.
    const p = progress(t, 0, 1200, ease.linear);
    const pan = mix(0.08, 1, p) * (1.15 - 0.15 * mix(0.08, 1, p));
    return {
      rotation: wide
        ? { rotateX: mix(14, 6, pan), rotateY: mix(-30, -22, pan), rotateZ: mix(2.5, 1, pan) }
        : { rotateX: mix(18, 8, pan), rotateY: mix(-20, -14, pan), rotateZ: mix(2.5, 1, pan) },
      // Top of the rail to its bottom.
      target: [wide ? -20 : -10, mix(-RAIL.height / 2 + 120, RAIL.height / 2 - 140, pan), 0],
      near: magnify(wide ? mix(2.6, 2.75, pan) : mix(2.6, 2.45, pan)),
      // Rail right of centre in 16:9 (super lower-left on void); low in 9:16
      // (super upper on void).
      offset: wide ? [mix(300, 280, pan), 0] : [0, mix(220, 380, pan)],
      focus: 0,
      fStop: 3.2,
      focalLength: 60,
      maxBlur: 7,
    };
  };
}

export const shot = {
  key: "rail",
  title: "The Now rail",
  description: "VC-406 — the ticket's Now rail, surveyed top to bottom.",
  durationMs: 1200,
  perspective: 1400,
  nodes: [{ id: "rail" }],
  rig: railRig,
  guard: [
    [-RAIL.width / 2, -RAIL.height / 2, 0],
    [RAIL.width / 2, -RAIL.height / 2, 0],
    [-RAIL.width / 2, RAIL.height / 2, 0],
    [RAIL.width / 2, RAIL.height / 2, 0],
  ],
};

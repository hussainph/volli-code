/**
 * Montage · ⌘K, then @sessions (VC-205).
 * Component: src/flute/shots/palette.tsx. Layout: a 1600×960 AppShell window
 * centred on the origin; the palette layer floats 90px above it.
 */
import { ease, mix, progress } from "../lib.mjs";

/** The palette box: 640 wide, centred, its top 18% down the window. */
const PALETTE = { left: -320, top: -480 + 0.18 * 960, width: 640, z: 90 };
const magnify = (m) => 1400 * (1 - 1 / m);

function paletteRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 1200, ease.linear);
    // One eased push, already under way on frame 1: a slow-in would read as
    // a start, and the cut lands on motion.
    // The second half is near-linear, so the camera is still travelling at
    // the cut instead of parking after ~700ms.
    const q = mix(0.12, 1, p);
    const push = mix(ease.outCubic(q), q, 0.6);
    return {
      rotation: wide
        ? { rotateX: mix(20, 12, push), rotateY: mix(-26, -16, push), rotateZ: mix(3, 1.5, push) }
        : { rotateX: mix(22, 14, push), rotateY: mix(-14, -8, push), rotateZ: mix(3, 1, push) },
      // From the palette's middle to its input and first rows.
      target: wide
        ? [mix(-60, -110, push), mix(-190, -250, push), PALETTE.z]
        : [mix(-40, -80, push), mix(-120, -180, push), PALETTE.z],
      // 9:16 is close: the palette's rows must read at 1080 wide.
      near: magnify(wide ? mix(1.5, 2.0, push) : mix(2.1, 2.4, push)),
      // 16:9: the palette rides low-right so the upper-left super is on void.
      offset: wide ? [mix(360, 400, push), mix(200, 175, push)] : [mix(-20, 0, push), 360],
      focus: 0,
      fStop: 2.8,
      focalLength: 60,
      maxBlur: 8,
    };
  };
}

export const shot = {
  key: "palette",
  title: "⌘K, then @sessions",
  description: "VC-205 — the command palette opens, @sessions narrows it to the Sessions section.",
  durationMs: 1200,
  perspective: 1400,
  nodes: [{ id: "window" }, { id: "palette", parentId: "window", transform: { z: 90 } }],
  rig: paletteRig,
  guard: [
    [-800, -480, 0],
    [800, -480, 0],
    [-800, 480, 0],
    [800, 480, 0],
    [-800, -480, 90],
    [800, 480, 90],
    [-800, 480, 90],
    [800, -480, 90],
  ],
};

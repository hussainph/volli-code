/**
 * Montage · split view in the main tab bar (VC-202, VC-333).
 * Component: src/flute/shots/split.tsx. Layout: a 1600×960 AppShell window
 * centred on the origin; the content card runs x ∈ [-482, 792] and the main
 * tab bar sits at y ≈ -417 (measured from a flat still).
 *
 * The camera rides the seam: a close oblique on the point where the divider
 * meets the tab bar, travelling left → right with it (a beat behind, so the
 * resize reads as the divider moving, not the world), pushing in a little.
 */
import { ease, mix, progress, track } from "../lib.mjs";

const CARD = { left: -482, width: 1274 };
const TAB_BAR_Y = -417;
/** Mirrors RATIO in split.tsx. */
const RATIO = [
  [150, 0.5],
  [260, 0.5],
  [760, 0.64],
  [1150, 0.57],
];
const dividerX = (t) => CARD.left + CARD.width * track(t, RATIO, ease.inOutCubic);

function splitRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 1200, ease.linear);
    // The camera's idea of the seam: 120ms behind the divider.
    const seam = dividerX(Math.max(0, t - 90));
    return {
      rotation: wide
        ? { rotateX: mix(8, 5, p), rotateY: mix(24, 18, p), rotateZ: mix(-6, -4, p) }
        : { rotateX: mix(18, 14, p), rotateY: mix(7, 3, p), rotateZ: mix(-5, -3, p) },
      target: [seam + mix(-90, 30, p), TAB_BAR_Y + 30, 0],
      near: wide ? mix(780, 860, p) : mix(800, 880, p),
      offset: wide ? [-40, -150] : [-30, -250],
      focus: 0,
      fStop: 3.2,
      focalLength: 60,
      maxBlur: 6,
    };
  };
}

export const shot = {
  key: "split",
  title: "Split view",
  description: "VC-202/333 — Home splits right, the main tab bar splits with it, the divider resizes.",
  durationMs: 1200,
  perspective: 1400,
  nodes: [{ id: "window" }],
  rig: splitRig,
  guard: [
    [-800, -480, 0],
    [800, -480, 0],
    [-800, 480, 0],
    [800, 480, 0],
  ],
};

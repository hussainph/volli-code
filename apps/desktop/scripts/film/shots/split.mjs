/**
 * Montage · multitasking: split view in the main tab bar.
 * Component: src/flute/shots/split.tsx. Layout: a 1600×960 AppShell window
 * centred on the origin; the content card runs x ∈ [-482, 792] and the main
 * tab bar sits at y ≈ -417 (measured from a flat still).
 *
 * Opens on the floating window in the rose world, pushes in on the seam as
 * the browser joins (riding that divider a beat behind as it slides right),
 * then swings to the second seam when a chat joins as the third pane, and
 * eases back out at the end so the world returns around the window.
 */
import { ease, mix, progress, track } from "../lib.mjs";

const CARD = { left: -482, width: 1274 };
const TAB_BAR_Y = -417;
/** Mirrors OUTER / INNER in split.tsx. */
const OUTER = [
  [250, 0.5],
  [330, 0.5],
  [950, 0.7],
  [1650, 0.7],
  [2300, 0.78],
];
const INNER = [
  [1650, 0.5],
  [1730, 0.5],
  [2400, 0.42],
  [3000, 0.47],
];
const outerX = (t) => CARD.left + CARD.width * track(t, OUTER, ease.inOutCubic);
const innerX = (t) =>
  CARD.left + CARD.width * track(t, OUTER, ease.inOutCubic) * track(t, INNER, ease.inOutCubic);

function splitRig(format) {
  const wide = format === "wide";
  return (t) => {
    const lag = Math.max(0, t - 90);
    // Which seam the camera cares about: the outer one, then the inner one.
    const swing = progress(t, 1600, 2300, ease.inOutCubic);
    const seam = mix(outerX(lag), innerX(lag), swing);
    const push = progress(t, 0, 1300, ease.outCubic);
    const pull = progress(t, 2700, 3500, ease.inOutCubic);
    const p = progress(t, 0, 3500, ease.linear);
    const near = wide ? mix(mix(80, 800, push), 420, pull) : mix(mix(-500, 760, push), 250, pull);
    const ty = mix(0, TAB_BAR_Y + 180, push) * (1 - pull * 0.6);
    const tx = mix(0, seam - 60, push) * (1 - pull * 0.5);
    return {
      rotation: wide
        ? { rotateX: mix(10, 5, p), rotateY: mix(26, 16, p), rotateZ: mix(-6, -3, p) }
        : { rotateX: mix(16, 10, p), rotateY: mix(10, 4, p), rotateZ: mix(-5, -2, p) },
      target: [tx, ty, 0],
      near,
      offset: wide ? [-40, -60] : [0, -120],
      focus: 0,
      fStop: 3.2,
      focalLength: 60,
      maxBlur: 6,
    };
  };
}

export const shot = {
  key: "split",
  title: "Multitasking",
  description:
    "Split view: a chat and a browser side by side, then a second chat joins as a third pane; the dividers slide.",
  durationMs: 3500,
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

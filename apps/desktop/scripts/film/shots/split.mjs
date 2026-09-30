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
    if (wide) {
      // The window rides the LEFT of frame, its right edge held short of the
      // lower-right super, so the rose world stays open where the words land.
      // The camera still leans after the seam, at a third of its travel.
      const near = mix(mix(-160, 380, push), 280, pull);
      const tx = mix(80, 230 + 0.35 * (seam - 200), push);
      const ty = mix(0, -170, push);
      return {
        rotation: { rotateX: mix(12, 6, p), rotateY: mix(28, 18, p), rotateZ: mix(-6, -3, p) },
        target: [tx, ty, 0],
        near,
        offset: [mix(-220, -620, push), mix(-40, -150, push)],
        focus: 0,
        fStop: 3.2,
        focalLength: 60,
        maxBlur: 6,
      };
    }
    // 9:16: the window lives in the upper half; the super owns the lower.
    const near = mix(mix(-260, 150, push), 60, pull);
    const tx = mix(0, seam - 40, push) * (1 - pull * 0.5);
    const ty = mix(0, -80, push);
    return {
      rotation: { rotateX: mix(16, 10, p), rotateY: mix(10, 4, p), rotateZ: mix(-5, -2, p) },
      target: [tx, ty, 0],
      near,
      offset: [0, mix(-300, -470, push)],
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

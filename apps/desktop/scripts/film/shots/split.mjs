/** The current two-pane group, with the complete chat and terminal readable.
 * Mirrors the landscape 1100×720 / portrait 1000×860 shell in split.tsx.
 * An axis-aligned dolly keeps sentence edges and the terminal prompt in frame,
 * and preserves the native terminal viewport/IntersectionObserver geometry.
 */
import { ease, mix, progress } from "../lib.mjs";

function splitRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 3500, ease.inOutCubic);
    return {
      rotation: { rotateX: 0, rotateY: 0, rotateZ: 0 },
      target: [0, 0, 0],
      near: wide ? mix(-120, -40, p) : mix(-150, -130, p),
      offset: wide ? [-100, -70] : [0, 40],
      focus: 0,
      fStop: 5,
      focalLength: 60,
      maxBlur: 3,
    };
  };
}

export const shot = {
  key: "split",
  title: "Multitasking",
  description:
    "The real chat and terminal share a two-pane tab group; the divider slides into place.",
  durationMs: 3500,
  perspective: 1400,
  nodes: [{ id: "window" }],
  rig: splitRig,
};

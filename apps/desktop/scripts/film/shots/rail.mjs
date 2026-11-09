/** Current document metadata beside the Now roster and branch. The camera
 * retains the whole brief, rather than cropping into an empty editor plane.
 * Mirrors landscape 1400×900 / portrait 1100×1000 in shots/rail.tsx.
 */
import { ease, mix, progress } from "../lib.mjs";

function railRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 1200, ease.inOutCubic);
    return {
      rotation: wide
        ? { rotateX: mix(7, 4, p), rotateY: mix(-10, -6, p), rotateZ: mix(1.5, 0.5, p) }
        : { rotateX: mix(6, 3, p), rotateY: mix(-4, -2, p), rotateZ: mix(1, 0, p) },
      target: [0, 0, 0],
      near: wide ? mix(-90, -40, p) : -150,
      offset: wide ? [-100, -70] : [0, 80],
      focus: 0,
      fStop: 5,
      focalLength: 60,
      maxBlur: 3,
    };
  };
}

export const shot = {
  key: "rail",
  title: "The Now rail",
  description: "Current ticket brief and metadata beside its Now chat roster and branch.",
  durationMs: 1200,
  perspective: 1400,
  nodes: [{ id: "rail" }],
  rig: railRig,
};

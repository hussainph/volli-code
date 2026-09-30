/**
 * Chapter · context switching: hover peek → conversation overlay (paper).
 * Component: src/flute/shots/peek.tsx. Layout: a 1600×960 AppShell window
 * centred on the origin; the sidebar's session rows sit near x ≈ -680,
 * the peek card opens just right of them; the overlay layer floats 80px up.
 *
 * Camera: a close oblique on the sidebar and card, which opens up (pulls back,
 * flattens) as the overlay lands, so the paper world shows around the window,
 * then eases back toward the sidebar as the overlay closes.
 */
import { ease, mix, progress } from "../lib.mjs";

const magnify = (m) => 1400 * (1 - 1 / m);

function peekRig(format) {
  const wide = format === "wide";
  return (t) => {
    const open = progress(t, 1900, 2700, ease.inOutCubic);
    const back = progress(t, 4200, 5000, ease.inOutCubic);
    const drift = progress(t, 0, 5000, ease.linear);
    const o = open * (1 - 0.55 * back);
    return {
      rotation: wide
        ? {
            rotateX: mix(mix(14, 11, drift), 8, o),
            rotateY: mix(mix(26, 20, drift), 10, o),
            rotateZ: mix(-4, -1.5, o),
          }
        : {
            rotateX: mix(mix(16, 13, drift), 8, o),
            rotateY: mix(mix(16, 12, drift), 5, o),
            rotateZ: mix(-3, -1, o),
          },
      target: wide
        ? [mix(mix(-470, -440, drift), -40, o), mix(-190, 0, o), mix(0, 80, o)]
        : [mix(mix(-500, -470, drift), -40, o), mix(-170, 0, o), mix(0, 80, o)],
      near: wide
        ? magnify(mix(mix(1.9, 2.1, drift), 1.3, o))
        : magnify(mix(mix(2.3, 2.5, drift), 1.0, o)),
      offset: wide ? [mix(-300, -300, o), mix(-40, -20, o)] : [0, mix(260, 200, o)],
      focus: 0,
      fStop: 3.2,
      focalLength: 60,
      maxBlur: 6,
    };
  };
}

export const shot = {
  key: "peek",
  title: "Hover peek & conversation overlay",
  description: "Hover a sidebar session to peek, open it into the overlay, reply, close.",
  durationMs: 5000,
  perspective: 1400,
  nodes: [{ id: "window" }, { id: "overlay", parentId: "window", transform: { z: 80 } }],
  rig: peekRig,
  guard: [
    [-800, -480, 0],
    [800, -480, 0],
    [-800, 480, 0],
    [800, 480, 0],
    [-400, -300, 80],
    [400, 300, 80],
  ],
};

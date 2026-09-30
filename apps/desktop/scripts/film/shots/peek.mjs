/**
 * Chapter · context switching: hover peek → conversation overlay (paper).
 * Component: src/flute/shots/peek.tsx. Layout: a 1280×800 AppShell window
 * centred on the origin; the sidebar's session rows sit near x ≈ -560,
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
    // Wide: the window's left edge sits right of centre during the peek (the
    // world is open on the left, under the lower-left super); the overlay
    // then swings to the left of frame, the world open on the right.
    return {
      rotation: wide
        ? {
            rotateX: mix(mix(12, 10, drift), 6, o),
            rotateY: mix(mix(24, 19, drift), 14, o),
            rotateZ: mix(-3, -1, o),
          }
        : {
            rotateX: mix(mix(16, 13, drift), 8, o),
            rotateY: mix(mix(16, 12, drift), 5, o),
            rotateZ: mix(-3, -1, o),
          },
      target: wide
        ? [mix(mix(-420, -400, drift), 0, o), mix(-60, 0, o), mix(0, 80, o)]
        : [mix(mix(-400, -380, drift), 0, o), mix(-90, 0, o), mix(0, 80, o)],
      near: wide
        ? magnify(mix(mix(1.55, 1.7, drift), 1.12, o))
        : magnify(mix(mix(2.0, 2.2, drift), 1.5, o)),
      offset: wide ? [mix(300, -290, o), mix(-20, -30, o)] : [0, mix(280, 290, o)],
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
    [-640, -400, 0],
    [640, -400, 0],
    [-640, 400, 0],
    [640, 400, 0],
    [-490, -320, 80],
    [490, 320, 80],
  ],
};

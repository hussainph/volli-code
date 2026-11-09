/**
 * Armed (src/flute/shots/automations.tsx, ArmedShot). Keep Doing, the three
 * arrivals and every Cancel control in frame together, including the website
 * still at 1500ms. As the windows close, drift toward the cards' Session rings.
 */
import { ease, mix, progress } from "../lib.mjs";

const TOP = -300;
const HEADER = 38;
const WINDOWS_BOTTOM = TOP + HEADER + 3 * 116 + 20 + 190 - 24;
const ARRIVALS = [0, (TOP + WINDOWS_BOTTOM) / 2, 70];
const CARDS = [0, TOP + HEADER + 170, 0];
const ARMED = { close: 1850, duration: 2800 };

const POSES = {
  wide: {
    a: { rotation: { rotateX: 12, rotateY: 14, rotateZ: -2 }, near: 400, offset: [320, 0] },
    b: { rotation: { rotateX: 16, rotateY: 8, rotateZ: -1 }, near: 360, offset: [340, 0] },
  },
  tall: {
    a: { rotation: { rotateX: 12, rotateY: 12, rotateZ: -2 }, near: 400, offset: [0, 20] },
    b: { rotation: { rotateX: 16, rotateY: 6, rotateZ: -1 }, near: 360, offset: [0, 20] },
  },
};

function armedRig(format) {
  const { a, b } = POSES[format];
  return (t) => {
    const move = progress(t, ARMED.close - 650, ARMED.duration, ease.inOutCubic);
    const drift = progress(t, 0, ARMED.duration, ease.linear);
    const target = [0, 1, 2].map((i) => mix(ARRIVALS[i], CARDS[i], move));
    return {
      rotation: Object.fromEntries(
        ["rotateX", "rotateY", "rotateZ"].map((axis) => [
          axis,
          mix(a.rotation[axis], b.rotation[axis], move) + (axis === "rotateY" ? -3 * drift : 0),
        ]),
      ),
      target,
      near: mix(a.near, b.near, move) + 20 * drift,
      offset: [mix(a.offset[0], b.offset[0], move), mix(a.offset[1], b.offset[1], move)],
      focus: 0,
      fStop: mix(5.6, 6.3, move),
      focalLength: 55,
      // Every Cancel control is part of this shot's subject, not background.
      maxBlur: 0,
    };
  };
}

export const shot = {
  key: "armed",
  title: "Save how work starts (armed column)",
  description:
    "Three tickets have landed in Doing. Implement counts down with Cancel; then the Session rings start.",
  durationMs: ARMED.duration,
  perspective: 1400,
  nodes: [
    { id: "auto-col-0" },
    { id: "auto-col-1" },
    { id: "auto-col-2" },
    { id: "auto-armed", transform: { z: 140 } },
  ],
  rig: armedRig,
};

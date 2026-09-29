/**
 * Armed (src/flute/shots/automations.tsx, ArmedShot). Frame 1 is close on the
 * three countdown windows floating in front of Doing, already drifting; as
 * they close the focus racks back to the column and the camera follows it to
 * the three cards whose rings have just started.
 */
import { ease, mix, progress } from "../lib.mjs";

const TOP = -300;
const HEADER = 44;
const WINDOWS = [0, TOP + HEADER + 3 * 118 + 20 + 120, 140];
const CARDS = [0, TOP + HEADER + 170, 0];
const ARMED = { close: 1850, duration: 2800 };

const POSES = {
  wide: {
    a: { rotation: { rotateX: 14, rotateY: 22, rotateZ: -3 }, near: 960, offset: [330, 60] },
    b: { rotation: { rotateX: 18, rotateY: 12, rotateZ: -2 }, near: 780, offset: [340, 20] },
  },
  tall: {
    a: { rotation: { rotateX: 16, rotateY: 16, rotateZ: -3 }, near: 900, offset: [0, 320] },
    b: { rotation: { rotateX: 20, rotateY: 8, rotateZ: -2 }, near: 700, offset: [0, 300] },
  },
};

function armedRig(format) {
  const { a, b } = POSES[format];
  return (t) => {
    const move = progress(t, ARMED.close - 650, ARMED.duration, ease.inOutCubic);
    const drift = progress(t, 0, ARMED.duration, ease.linear);
    const target = [0, 1, 2].map((i) => mix(WINDOWS[i], CARDS[i], move));
    return {
      rotation: Object.fromEntries(
        ["rotateX", "rotateY", "rotateZ"].map((axis) => [axis, mix(a.rotation[axis], b.rotation[axis], move) + (axis === "rotateY" ? -3 * drift : 0)]),
      ),
      target,
      near: mix(a.near, b.near, move) + 60 * drift,
      offset: [mix(a.offset[0], b.offset[0], move), mix(a.offset[1], b.offset[1], move)],
      focus: 0,
      fStop: mix(2.8, 4, move),
      focalLength: 55,
      maxBlur: 8,
    };
  };
}

export const shot = {
  key: "armed",
  title: "Save how work starts (armed column)",
  description: "Three countdown windows with Cancel drain; the rings go working, one goes waiting.",
  durationMs: ARMED.duration,
  perspective: 1400,
  nodes: [{ id: "auto-col-0" }, { id: "auto-col-1" }, { id: "auto-col-2" }, { id: "auto-armed", transform: { z: 140 } }],
  rig: armedRig,
};

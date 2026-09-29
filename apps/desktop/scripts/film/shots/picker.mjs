/**
 * The ⌥ picker (src/flute/shots/automations.tsx, PickerShot). Frame 1 is on
 * the lifted stack already travelling from Todo; the camera leans in after
 * it, arrives over Doing as the Offered list grows, and eases back a touch as
 * the stack lands.
 */
import { ease, mix, progress } from "../lib.mjs";

const COLUMN = 288;
const GAP = 20;
const WIDTH = 3 * COLUMN + 2 * GAP;
const TOP = -300;
const HEADER = 44;
const left = (i) => i * (COLUMN + GAP) - WIDTH / 2;
const PICKER = { over: 820, option: 980, drop: 1760, duration: 2600 };

// Stack centre along its path (mirrors PickerShot's from → over → rest).
const from = [left(0) + 14 + 144, TOP + HEADER + 118 - 30 + 55];
const over = [left(1) + 40 + 144, TOP + HEADER + 150 + 55];
const panel = [0, TOP + HEADER + 110];
// After the drop: the landed cards and the countdown windows under them.
const landed = [0, TOP + HEADER + 3 * 118 - 40, 60];

const POSES = {
  wide: {
    a: { rotation: { rotateX: 24, rotateY: -30, rotateZ: 5 }, near: 860, offset: [340, 40] },
    b: { rotation: { rotateX: 20, rotateY: -20, rotateZ: 3 }, near: 860, offset: [340, 60] },
    c: { rotation: { rotateX: 16, rotateY: -14, rotateZ: 2 }, near: 640, offset: [360, 20] },
  },
  tall: {
    a: { rotation: { rotateX: 26, rotateY: -22, rotateZ: 4 }, near: 780, offset: [0, 280] },
    b: { rotation: { rotateX: 22, rotateY: -14, rotateZ: 3 }, near: 780, offset: [0, 280] },
    c: { rotation: { rotateX: 18, rotateY: -10, rotateZ: 2 }, near: 560, offset: [0, 300] },
  },
};

function pickerRig(format) {
  const { a, b, c } = POSES[format];
  return (t) => {
    const follow = progress(t, 0, PICKER.over + 200, (x) => ease.outCubic(x) * 0.8 + x * 0.2);
    const toPanel = progress(t, 500, PICKER.drop, ease.inOutCubic);
    const after = progress(t, PICKER.drop - 200, PICKER.duration, ease.inOutCubic);
    const stack = [mix(from[0], over[0], follow), mix(from[1], over[1], follow), 110];
    const onPanel = [mix(stack[0], panel[0], toPanel), mix(stack[1], panel[1], toPanel), mix(110, 30, toPanel)];
    const target = [0, 1, 2].map((i) => mix(onPanel[i], landed[i], after));
    const pose = (key) => mix(mix(a[key], b[key], toPanel), c[key], after);
    return {
      rotation: Object.fromEntries(
        ["rotateX", "rotateY", "rotateZ"].map((axis) => [axis, mix(mix(a.rotation[axis], b.rotation[axis], toPanel), c.rotation[axis], after)]),
      ),
      target,
      near: pose("near"),
      offset: [mix(mix(a.offset[0], b.offset[0], toPanel), c.offset[0], after), mix(mix(a.offset[1], b.offset[1], toPanel), c.offset[1], after)],
      focus: 0,
      fStop: 3.2,
      focalLength: 55,
      maxBlur: 7,
    };
  };
}

export const shot = {
  key: "picker",
  title: "Pick what runs (⌥ picker)",
  description: "Three selected cards dragged over Doing; ⌥ grows the Offered list; the stack lands.",
  durationMs: PICKER.duration,
  perspective: 1400,
  nodes: [
    { id: "auto-col-0" },
    { id: "auto-col-1" },
    { id: "auto-col-2" },
    { id: "auto-offered", transform: { z: 30 } },
    { id: "auto-stack", transform: { z: 110 } },
    { id: "auto-armed", transform: { z: 140 } },
  ],
  rig: pickerRig,
};

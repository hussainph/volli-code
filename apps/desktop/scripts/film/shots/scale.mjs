/**
 * Fast at scale (src/flute/shots/scale.tsx). Frame 1 is close along the
 * row of column headers — Backlog 3418 · Todo 1206 · Doing 42 · Needs Review
 * 61 · Done 5273 — already moving. The camera tips forward until it is looking down the board as a
 * cliff: five columns of cards falling away into the dark, the far rows
 * unmounted slots. The descent keeps going under the super.
 */
import { ease, mix, progress } from "../lib.mjs";

const COLUMN = 288;
const GAP = 20;
const WIDTH = 5 * COLUMN + 4 * GAP;
const TOP = -240;
const columnCentre = (index) => index * (COLUMN + GAP) - WIDTH / 2 + COLUMN / 2;

const POSES = {
  wide: {
    start: {
      rotation: { rotateX: -10, rotateY: 30, rotateZ: 5 },
      target: [columnCentre(1), TOP + 60, 0],
      offset: [-240, -140],
      near: 820,
    },
    end: {
      rotation: { rotateX: -58, rotateY: 12, rotateZ: 14 },
      target: [columnCentre(3), TOP + 1500, 0],
      offset: [300, -40],
      near: -240,
    },
  },
  tall: {
    start: {
      rotation: { rotateX: -10, rotateY: 30, rotateZ: 4 },
      target: [columnCentre(1), TOP + 60, 0],
      offset: [-120, -420],
      near: 760,
    },
    end: {
      rotation: { rotateX: -60, rotateY: 6, rotateZ: 8 },
      target: [columnCentre(2), TOP + 1500, 0],
      offset: [0, -380],
      near: -360,
    },
  },
};

function scaleRig(format) {
  const { start, end } = POSES[format];
  return (t) => {
    // Already moving at frame 1: an ease-out (not in-out) on the travel, plus
    // a steady descent that never stops.
    const p = progress(t, 0, 3800, (x) => ease.outCubic(x) * 0.8 + x * 0.2);
    const tip = progress(t, 0, 3000, ease.inOutCubic);
    const rotation = Object.fromEntries(
      ["rotateX", "rotateY", "rotateZ"].map((axis) => [
        axis,
        mix(start.rotation[axis], end.rotation[axis], axis === "rotateX" ? tip : p),
      ]),
    );
    return {
      rotation,
      target: [0, 1, 2].map((i) => mix(start.target[i], end.target[i], p)),
      near: mix(start.near, end.near, p),
      offset: [mix(start.offset[0], end.offset[0], p), mix(start.offset[1], end.offset[1], p)],
      // Focus holds the header, then runs down the column with the camera.
      focus: mix(0, 260, progress(t, 400, 2400, ease.inOutCubic)),
      fStop: mix(2.8, 5.6, progress(t, 300, 2600, ease.inOutCubic)),
      focalLength: 55,
      maxBlur: 8,
    };
  };
}

export const shot = {
  key: "scale",
  title: "Fast at scale",
  description:
    "A 10,000-ticket board as a cliff: real columns, real count badges, the unmounted rows falling away.",
  durationMs: 3800,
  perspective: 1400,
  nodes: [0, 1, 2, 3, 4].flatMap((i) => [{ id: `scale-${i}` }, { id: `scale-ghost-${i}` }]),
  rig: scaleRig,
};

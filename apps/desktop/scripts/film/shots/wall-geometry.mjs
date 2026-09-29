/**
 * Geometry of the wall (src/flute/kit/wall.tsx), shared by the hook and end
 * rigs — the two shots meet at the loop point, so they must agree exactly on
 * where the hero card is and how the camera is moving through it.
 *
 * Measured in the lab, not assumed (hero card: offsetTop 530, 272×110, in
 * column 6); re-measure if the wall's layout or its tickets change.
 */
import { rotate } from "../lib.mjs";

export const RELIEF = [10, -24, 18, -6, 30, -14, 0, 22, -30, 8, -18, 26, -8, 14];
export const WALL_NODES = RELIEF.map((z, column) => ({ id: `wall-${column}`, transform: { z } }));

const COLUMN = 288;
const GAP = 20;
const WIDTH = 14 * COLUMN + 13 * GAP;
const TOP = -660;
const columnLeft = (column) => column * (COLUMN + GAP) - WIDTH / 2;

/** World centre of VC-239's card. */
export const HERO = [columnLeft(6) + 8 + 136, TOP + 530 + 55, RELIEF[6]];
/** Roughly the middle of the wall (columns run ~1230–1440 tall). */
export const WALL_CENTRE = [0, TOP + 700, 0];

/** The wall's corners and edge midpoints, for the near-plane guard. */
export const WALL_GUARD = [
  [-WIDTH / 2, TOP, 30],
  [WIDTH / 2, TOP, 30],
  [-WIDTH / 2, TOP + 1440, 30],
  [WIDTH / 2, TOP + 1440, 30],
  [0, TOP, 30],
  [0, TOP + 1440, 30],
  [-WIDTH / 2, TOP + 720, 30],
  [WIDTH / 2, TOP + 720, 30],
];

/**
 * The loop point: frame 1 of the hook, and the last frame of the end card.
 * The camera is travelling INTO the card at `MACRO.nearRate` (units/ms) — the
 * end card arrives at that speed and the hook leaves at it, decelerating over
 * `MACRO.settleMs`, so the join has no jolt in position or velocity.
 */
export const MACRO = {
  wide: {
    rotation: { rotateX: 7, rotateY: -5, rotateZ: -5 },
    target: [HERO[0] - 40, HERO[1] - 16, HERO[2]],
    offset: [-40, 250],
    near: 880,
  },
  tall: {
    rotation: { rotateX: 7, rotateY: -4, rotateZ: -4 },
    target: [HERO[0] - 30, HERO[1] - 14, HERO[2]],
    offset: [0, 330],
    near: 820,
  },
  nearRate: 0.42,
  settleMs: 420,
};

/** The hook's opening dolly: leaves MACRO at nearRate and settles. */
export function macroNear(format, t) {
  const { near } = MACRO[format];
  const a = Math.min(t, MACRO.settleMs);
  return near + MACRO.nearRate * a - (MACRO.nearRate / (2 * MACRO.settleMs)) * a * a;
}

export function viewDepth(point, rotation, cameraZ, perspective) {
  return perspective - (rotate(point, rotation)[2] - cameraZ);
}

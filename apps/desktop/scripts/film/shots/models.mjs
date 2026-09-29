/**
 * · A model for every job (VC-259). Component: src/flute/shots/models.tsx.
 *
 * Layout: the Default models card, 600×406 pane px laid out at 2× (1200×812
 * world px), centred on the origin. The camera rakes down the tree from Board
 * to Visual on one continuous eased rail, and the focus lands on each tier
 * row in turn — Board, Ticket Sessions, then Fast, Deep and Visual under it —
 * holding briefly on each, so the rack does the counting while the camera
 * never stops.
 */
import { ease, mix, progress, rotate, track } from "../lib.mjs";

const ZOOM = 2;
const PANE = { width: 560, height: 406 };
/** Row centres in pane px, measured in the lab (offsetTop + half the control). */
const ROW = { board: 71, utility: 131.5, ticket: 192.5, fast: 253.5, deep: 314.5, visual: 375.5 };
/** Pane px → world px. */
const world = (x, y) => [
  x * ZOOM - (PANE.width * ZOOM) / 2,
  y * ZOOM - (PANE.height * ZOOM) / 2,
  0,
];

/** Where the focus sits, in pane px: a hold on each tier, eased between. */
function focusRow(t) {
  return track(
    t,
    [
      [0, ROW.board],
      [240, ROW.board],
      [520, ROW.ticket],
      [760, ROW.ticket],
      [980, ROW.fast],
      [1120, ROW.fast],
      [1320, ROW.deep],
      [1440, ROW.deep],
      [1640, ROW.visual],
    ],
    ease.inOutCubic,
  );
}

/**
 * The roll that keeps every tier row at one depth: with the pane tilted back
 * (rotateX) and turned (rotateY), a row stays level with the focus plane only
 * when tan(rotateZ) = sin(rotateY)·cos(rotateX) / sin(rotateX). The rack then
 * lands on a whole row — label and model together — rather than a diagonal.
 */
const r = (d) => (d * Math.PI) / 180;

function level(rotateX, rotateY, bias = 0) {
  const rotateZ =
    (Math.atan((Math.sin(r(rotateY)) * Math.cos(r(rotateX))) / Math.sin(r(rotateX))) * 180) /
    Math.PI;
  return { rotateX, rotateY, rotateZ: rotateZ + bias };
}

const FORMAT = {
  wide: {
    rotation: (p) => level(mix(36, 32, p), mix(5, 3.5, p)),
    // The whole card stays in frame, labels and model names alike: the target
    // is the card's horizontal middle and the camera holds far enough back that
    // the model column never leaves the right edge. The tree hangs right of
    // centre so the super owns the void at lower left.
    x: PANE.width / 2,
    from: ROW.utility,
    to: ROW.deep,
    near: (p) => mix(-240, -165, p),
    offset: (p) => [360, mix(-20, 20, p)],
  },
  tall: {
    rotation: (p) => ({ rotateX: mix(36, 31, p), rotateY: mix(8, 5, p), rotateZ: mix(-5, -3, p) }),
    // Its own composition: the card fills the width of the 9:16 frame below
    // the upper super, pushing in gently as the rail runs down the tree.
    x: PANE.width / 2,
    from: ROW.utility,
    to: ROW.fast,
    near: (p) => mix(-330, -235, p),
    offset: (p) => [0, mix(110, 190, p)],
  },
};

function modelsRig(format) {
  const f = FORMAT[format];
  return (t) => {
    // Already travelling on frame 1: a linear share keeps the rail moving at
    // both ends, the eased share gives it its swell in the middle.
    const s = progress(t, 0, 1800);
    const p = 0.3 * s + 0.7 * ease.inOutSine(s);
    const rotation = f.rotation(p);
    const target = world(f.x, mix(f.from, f.to, p));
    // Focus: the depth of the focused row relative to the target, along the view axis.
    // The row's middle, between its label and its model's name, so both
    // halves of a row land sharp together.
    const focused = world(190, focusRow(t));
    const [, , tz] = rotate(target, rotation);
    const [, , fz] = rotate(focused, rotation);
    return {
      rotation,
      target,
      near: f.near(p),
      offset: f.offset(p),
      focus: tz - fz,
      // Deep enough that every tier name reads in every frame; the rack still
      // walks down the tree, falling off gently at the far rows.
      fStop: 5.6,
      focalLength: 120,
      maxBlur: 5,
    };
  };
}

export const shot = {
  key: "models",
  title: "A model for every job",
  description:
    "VC-259 — a close, raking survey down the real tier tree: Board, Utility, Ticket, then Fast / Deep / Visual.",
  durationMs: 1800,
  perspective: 1400,
  nodes: [{ id: "model-tree" }],
  rig: modelsRig,
};

/**
 * · Newest models, one click; a model for every subagent. Component: src/flute/shots/models.tsx.
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

/** Where the focus sits, in pane px: the header (Refresh), then down to Fast. */
function focusRow(t) {
  return track(
    t,
    [
      [0, 30],
      [1250, 30],
      [1700, ROW.fast],
      [2600, ROW.fast],
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

/** Camera beat: 0 → 1 across the move from the header to the Fast row. */
const beat = (t) => ease.inOutCubic(progress(t, 1150, 1850));

const FORMAT = {
  wide: {
    rotation: (p) => level(mix(24, 20, p), mix(-10, 2, p)),
    // The card owns the right ~55% of the frame; the supers own the lime
    // world on the left. Beat 1: close on the header, Refresh and the Ticket
    // row. Beat 2: the tree fills the frame height, the reasoning column
    // cropped off the right edge.
    x: (b) => mix(300, 250, b),
    y: (s, b) => mix(mix(120, 150, s), 215, b),
    near: (s, b) => mix(mix(260, 360, s), 520, b),
    offset: (s, b) => [mix(420, 460, b), mix(-120, 10, b)],
  },
  tall: {
    rotation: (p) => ({ rotateX: mix(30, 26, p), rotateY: mix(-8, 5, p), rotateZ: mix(3, -3, p) }),
    x: (b) => mix(PANE.width / 2, 300, b),
    y: (s, b) => mix(mix(150, 175, s), ROW.fast, b),
    near: (s, b) => mix(mix(60, 160, s), 320, b),
    offset: (s, b) => [mix(0, 60, b), mix(260, 300, b)],
  },
};

function modelsRig(format) {
  const f = FORMAT[format];
  return (t) => {
    const s = progress(t, 0, 1250);
    const b = beat(t);
    const p = progress(t, 0, 2600);
    const rotation = f.rotation(0.4 * p + 0.6 * b);
    const target = world(f.x(b), f.y(s, b));
    const focused = world(260, focusRow(t));
    const [, , tz] = rotate(target, rotation);
    const [, , fz] = rotate(focused, rotation);
    return {
      rotation,
      target,
      near: f.near(s, b) - 25 * (p - b),
      offset: f.offset(s, b),
      focus: tz - fz,
      fStop: 5.6,
      focalLength: 120,
      maxBlur: 5,
    };
  };
}

export const shot = {
  key: "models",
  title: "Newest models, a model for every subagent",
  description:
    "Refresh models brings in the newest models; then the camera lands on the Fast tier as its model changes.",
  durationMs: 2600,
  perspective: 1400,
  nodes: [{ id: "model-tree" }],
  rig: modelsRig,
};

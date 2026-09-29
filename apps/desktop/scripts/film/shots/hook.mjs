/**
 * 01 · The hook (src/flute/shots/hook.tsx). Frame 1: a macro on VC-239's
 * card, already dollying in (the end card arrives at the same speed — the
 * loop point). The dolly settles by 420ms, then the camera pulls back and
 * tilts to reveal the whole wall of 175, racking focus from the one card to
 * the many, and keeps drifting along the wall under the count.
 */
import { ease, mix, progress } from "../lib.mjs";
import { HERO, MACRO, WALL_GUARD, WALL_NODES, macroNear } from "./wall-geometry.mjs";

const WIDE = {
  rotation: { rotateX: 34, rotateY: -32, rotateZ: 7 },
  // A point near the wall's lower edge, held low-left of centre: the wall
  // runs up and away to the right and off the frame, the void is lower-left.
  target: [-300, 560, 0],
  offset: [-160, 200],
  near: -900,
  drift: { x: 520, near: 160, rotateY: 5 },
};
const TALL = {
  // The wall's near edge sits just above the count; the wall runs up the
  // frame and away into the dark.
  rotation: { rotateX: 34, rotateY: -16, rotateZ: 6 },
  target: [-150, 760, 0],
  offset: [60, 110],
  near: 60,
  drift: { x: 420, near: 90, rotateY: 4 },
};

function hookRig(format) {
  const macro = MACRO[format];
  const end = format === "wide" ? WIDE : TALL;
  return (t) => {
    const pull = progress(t, MACRO.settleMs, 2750, ease.inOutCubic);
    const drift = progress(t, 1900, 4200, ease.inOutSine);
    const rotation = {
      rotateX: mix(macro.rotation.rotateX, end.rotation.rotateX, pull),
      rotateY: mix(macro.rotation.rotateY, end.rotation.rotateY, pull) + end.drift.rotateY * drift,
      rotateZ: mix(macro.rotation.rotateZ, end.rotation.rotateZ, pull),
    };
    const target = [0, 1, 2].map((i) => mix(macro.target[i], end.target[i], pull));
    target[0] += end.drift.x * drift;
    const near =
      t <= MACRO.settleMs
        ? macroNear(format, t)
        : mix(macroNear(format, MACRO.settleMs), end.near, pull) + end.drift.near * drift;
    return {
      rotation,
      target,
      near,
      offset: [mix(macro.offset[0], end.offset[0], pull), mix(macro.offset[1], end.offset[1], pull)],
      // Focus stays on the hero card as the wall opens up, then racks out to
      // the wall's middle as the aperture closes down.
      focus: mix(0, 0, pull),
      fStop: mix(2.4, 7, progress(t, 900, 2900, ease.inOutCubic)),
      focalLength: 60,
      maxBlur: 9,
    };
  };
}

export const shot = {
  key: "hook",
  title: "Volli 0.2 — the hook",
  description: "Macro on one real 0.2 ticket (VC-239), pull back to the wall of all 175.",
  durationMs: 4200,
  perspective: 1400,
  nodes: WALL_NODES,
  guard: WALL_GUARD,
  rig: hookRig,
  hero: HERO,
};

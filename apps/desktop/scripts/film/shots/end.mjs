/**
 * 13 · The end card (src/flute/shots/end.tsx). The camera holds far back from
 * the wall, tilted, drifting in, while the lockup builds in front of it; the
 * wall is a soft field of cards behind (focus is on the lockup's plane).
 * From 2600ms it dives: through the lockup and into VC-239, arriving at the
 * hook's first pose (MACRO) at 3800ms travelling at MACRO.nearRate — the hook
 * then carries on at that speed and settles. Rotation, offset and focus all
 * arrive at rest, which is how the hook starts them.
 */
import { ease, hermite, mix, progress } from "../lib.mjs";
import { HERO, MACRO, WALL_GUARD, WALL_NODES } from "./wall-geometry.mjs";

const DURATION = 3800;
const DIVE = 2600;

const HOLD = {
  wide: {
    rotation: { rotateX: 20, rotateY: -16, rotateZ: -4 },
    offset: [0, 40],
    from: -2500,
    to: -2250,
  },
  tall: {
    rotation: { rotateX: 20, rotateY: -12, rotateZ: -4 },
    offset: [0, 60],
    from: -2300,
    to: -2050,
  },
};

function endRig(format) {
  const macro = MACRO[format];
  const hold = HOLD[format];
  const holdRate = (hold.to - hold.from) / DIVE;
  return (t) => {
    // One ease across the whole shot for rotation/offset: slow drift while
    // holding, the bulk of the turn inside the dive, zero velocity at the end.
    const turn = progress(t, 0, DURATION, (x) => ease.inOutCubic(Math.max(0, (x - 0.35) / 0.65)));
    const rotation = Object.fromEntries(
      ["rotateX", "rotateY", "rotateZ"].map((axis) => [
        axis,
        mix(hold.rotation[axis], macro.rotation[axis], turn),
      ]),
    );
    const near =
      t <= DIVE
        ? hold.from + holdRate * t
        : hermite(t, DIVE, DURATION, hold.to, macro.near, holdRate, MACRO.nearRate);
    const target = [0, 1, 2].map((i) => mix(HERO[i], macro.target[i], turn));
    // Focus: the lockup's plane (well in front of the wall) while holding,
    // racking onto the card as the camera arrives.
    const rack = progress(t, DIVE, DURATION - 150, ease.inOutCubic);
    return {
      rotation,
      target,
      near,
      offset: [
        mix(hold.offset[0], macro.offset[0], turn),
        mix(hold.offset[1], macro.offset[1], turn),
      ],
      focus: mix(-2200, 0, rack),
      fStop: 2.4,
      focalLength: 60,
      maxBlur: 9,
    };
  };
}

export const shot = {
  key: "end",
  title: "Volli 0.2 — end card",
  description:
    "The Volli mark builds in front of the wall, then the camera dives into VC-239 — the hook's first frame.",
  durationMs: DURATION,
  perspective: 1400,
  nodes: WALL_NODES,
  guard: WALL_GUARD,
  rig: endRig,
};

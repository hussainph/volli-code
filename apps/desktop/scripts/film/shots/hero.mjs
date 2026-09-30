/**
 * volli.app's hero (VC-472) — web-only, not part of the release film. The hook
 * (./hook.mjs) opens it: the same tight oblique sweep down the sidebar's live
 * agents. Then, where the film parks the window off to the left for a super,
 * this pulls back to the window centred in frame and settles into a slow drift
 * that is exactly periodic, so the site can play the sweep once and loop the
 * drift forever without a seam (src/flute/shots/hero.tsx).
 *
 *   0 ────────── INTRO_MS ───────────────── INTRO_MS + LOOP_MS
 *   sweep, pull back   drift (pose at both ends identical, zero velocity at the join)
 */
import { ease, mix, progress } from "../lib.mjs";

export const INTRO_MS = 2600;
export const LOOP_MS = 6000;

const RIGS = {
  wide: {
    start: { rot: [26, 30, -9], target: [-620, -170, 0], near: 800 },
    sweepY: 260,
    end: { rot: [8, 12, -2.5], target: [-30, 0, 0], near: -170 },
  },
  tall: {
    start: { rot: [30, 22, -8], target: [-620, -170, 0], near: 800 },
    sweepY: 300,
    end: { rot: [12, 10, -3], target: [-300, 0, 0], near: -900 },
  },
};

function heroRig(format) {
  const r = RIGS[format];
  return (t) => {
    const sweep = progress(t, 0, 1300, ease.inOutSine);
    const pull = progress(t, 800, INTRO_MS, ease.inOutCubic);
    // Periodic, and still at the join: both start and end at zero with zero
    // velocity. `swing` leans one way then the other; `bob` breathes twice.
    const u = t <= INTRO_MS ? 0 : ((t - INTRO_MS) % LOOP_MS) / LOOP_MS;
    const swing = Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * u) ** 2;
    const bob = Math.sin(2 * Math.PI * u) ** 2;
    const sy = mix(r.start.target[1], r.sweepY, sweep);
    return {
      rotation: {
        rotateX: mix(r.start.rot[0], r.end.rot[0], pull) + 2 * bob,
        rotateY: mix(r.start.rot[1], r.end.rot[1], pull) + 8 * swing,
        rotateZ: mix(r.start.rot[2], r.end.rot[2], pull) - 1.2 * swing,
      },
      target: [
        mix(r.start.target[0], r.end.target[0], pull),
        mix(sy, r.end.target[1], pull),
        0,
      ],
      near: mix(r.start.near, r.end.near, pull) - 50 * bob,
      offset: [0, 0],
      focus: 0,
      fStop: mix(2.8, 8, pull),
      focalLength: 60,
      maxBlur: 8,
    };
  };
}

export const shot = {
  key: "hero",
  title: "volli.app — the hero",
  description: "The hook's sweep down live agents, pulling back to the centred window, then a seamless drift.",
  durationMs: INTRO_MS + LOOP_MS,
  perspective: 1400,
  nodes: [{ id: "window" }],
  rig: heroRig,
  // Sampled at 15fps: at the film's 30 an 8.6s recipe is past Flute's 256 KB
  // project-file limit, and a camera this slow interpolates cleanly.
  stepMs: 1000 / 15,
  guard: [
    [-800, -480, 0],
    [800, -480, 0],
    [-800, 480, 0],
    [800, 480, 0],
  ],
};

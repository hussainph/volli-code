/**
 * 01 · The hook (src/flute/shots/hook.tsx). A 1600×960 AppShell window centred
 * on the origin; its sidebar's session rows sit in x ∈ [-790, -490], running
 * from y ≈ -380 down the window.
 *
 * Frame 1: a tight oblique on the sidebar's live rows, already sweeping fast
 * down the list. From ~900ms the camera pulls back and squares up to reveal
 * the whole window floating in the aurora world, settled by ~2200ms, then
 * drifts.
 */
import { ease, mix, progress } from "../lib.mjs";

const RIGS = {
  wide: {
    start: { rot: [26, 30, -9], target: [-620, -170, 0], near: 800, offset: [0, 0] },
    sweepY: 260,
    end: { rot: [10, 16, -4], target: [60, 0, 0], near: -560, offset: [-300, -110] },
  },
  tall: {
    start: { rot: [30, 22, -8], target: [-620, -170, 0], near: 800, offset: [0, 0] },
    sweepY: 300,
    end: { rot: [14, 12, -4], target: [0, 0, 0], near: -1000, offset: [0, -330] },
  },
};

function hookRig(format) {
  const r = RIGS[format];
  return (t) => {
    const sweep = progress(t, 0, 1300, ease.inOutSine);
    const pull = progress(t, 800, 2250, ease.inOutCubic);
    const drift = progress(t, 2000, 3000, ease.linear); // never settles: the last frame still moves
    const sy = mix(r.start.target[1], r.sweepY, sweep);
    return {
      rotation: {
        rotateX: mix(r.start.rot[0], r.end.rot[0], pull),
        rotateY: mix(r.start.rot[1], r.end.rot[1], pull) - 5 * drift,
        rotateZ: mix(r.start.rot[2], r.end.rot[2], pull),
      },
      target: [mix(r.start.target[0], r.end.target[0], pull), mix(sy, r.end.target[1], pull), 0],
      near: mix(r.start.near, r.end.near, pull) - 80 * drift,
      offset: [
        mix(r.start.offset[0], r.end.offset[0], pull),
        mix(r.start.offset[1], r.end.offset[1], pull),
      ],
      focus: 0,
      fStop: mix(2.8, 8, pull),
      focalLength: 60,
      maxBlur: 8,
    };
  };
}

export const shot = {
  key: "hook",
  title: "Volli 0.2 — the hook",
  description: "Tight oblique sweep down dozens of live sessions, pull back to the whole app.",
  durationMs: 3000,
  perspective: 1400,
  nodes: [{ id: "window" }],
  rig: hookRig,
  guard: [
    [-800, -480, 0],
    [800, -480, 0],
    [-800, 480, 0],
    [800, 480, 0],
  ],
};

/** VC-263 / VC-350 / VC-376 · macro trigger, then usage-window detail. */
import { ease, mix, progress } from "../lib.mjs";

/** Layout mirrors src/flute/shots/limits.tsx (stage px, origin at centre). */
// The trigger sits on the z=0 plane: its node carries no z of its own, so the
// rig target is the one place its depth is stated (it was counted twice).
const BUTTON = [-1100, -380, 0];
const PANEL = [0, 60, 120];
const PERSPECTIVE = 1800;
const magnify = (m) => PERSPECTIVE * (1 - 1 / m);

function limitsRig(format) {
  const wide = format === "wide";
  return (t) => {
    // One eased move from the button macro to the reading, already under way
    // on frame 1 and landing by ~850ms; a slow linear drift carries the rest
    // so the camera never parks.
    const travel = ease.inOutCubic(progress(t, -120, 850, ease.linear));
    const drift = progress(t, 0, 2200, ease.linear);
    const at = (i) => mix(BUTTON[i], PANEL[i], travel);
    return {
      rotation: wide
        ? {
            rotateX: mix(20, 14, travel) - 2 * drift,
            rotateY: mix(28, 18, travel) - 3 * drift,
            rotateZ: -2,
          }
        : {
            rotateX: mix(18, 12, travel) - 2 * drift,
            rotateY: mix(16, 9, travel) - 2 * drift,
            rotateZ: -1,
          },
      target: [at(0) + 30 * drift, at(1), at(2)],
      near: magnify(
        wide
          ? mix(mix(5.2, 4.6, progress(t, 0, 400, ease.linear)), 1.2, travel) + 0.12 * drift
          : mix(mix(4.4, 3.9, progress(t, 0, 400, ease.linear)), 1.1, travel) + 0.1 * drift,
      ),
      offset: wide ? [mix(0, 440, travel), mix(0, -130, travel)] : [0, mix(200, 270, travel)],
      focus: 0,
      // Stopped down on the macro so the whole tilted gauge is sharp, opening
      // up as the camera reaches the panel for the gentle falloff.
      fStop: mix(9, wide ? 3.2 : 3.6, travel),
      focalLength: 72,
      maxBlur: 6,
    };
  };
}

const panelTracks = [
  {
    target: { kind: "surface", id: "usage-limits-breakdown" },
    property: "z",
    keyframes: [
      { timeMs: 0, value: 20, easing: "cinematic" },
      { timeMs: 900, value: 120, easing: "cinematic" },
    ],
  },
  {
    target: { kind: "surface", id: "usage-limits-breakdown" },
    property: "y",
    keyframes: [
      { timeMs: 0, value: 48, easing: "cinematic" },
      { timeMs: 900, value: 0, easing: "cinematic" },
    ],
  },
  {
    target: { kind: "surface", id: "usage-limits-breakdown" },
    property: "opacity",
    keyframes: [
      { timeMs: 150, value: 0, easing: "cinematic" },
      { timeMs: 650, value: 1, easing: "cinematic" },
    ],
  },
];

export const shot = {
  key: "limits",
  title: "See your limits coming",
  description: "VC-263 / 350 / 376 — usage-limits trigger opens onto Session and weekly readings.",
  durationMs: 2200,
  stepMs: 25,
  perspective: PERSPECTIVE,
  nodes: [{ id: "usage-limits-trigger" }, { id: "usage-limits-breakdown" }],
  rig: limitsRig,
  surfaceTracks: () => panelTracks,
};

/**
 * 13 · The end card (src/flute/shots/end.tsx). Everything in it is frame
 * layer — the lockup over the ember world — so there is nothing in the stage
 * for a camera to find: the rig holds a quiet pose for Flute's validator and
 * the drift, fly-through and rings all live on the scene clock in end.tsx.
 */
const DURATION = 3600;

function endRig() {
  return () => ({
    rotation: { rotateX: 0, rotateY: 0, rotateZ: 0 },
    target: [0, 0, 0],
    near: 400,
    offset: [0, 0],
    focus: 0,
    fStop: 8,
    focalLength: 60,
    maxBlur: 0,
  });
}

export const shot = {
  key: "end",
  title: "End card",
  description: "The Volli mark builds on the ember world; name, category line, download CTA.",
  durationMs: DURATION,
  perspective: 1400,
  nodes: [],
  guard: [[0, 0, 0]],
  rig: endRig,
};

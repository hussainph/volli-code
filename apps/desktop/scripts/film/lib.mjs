/**
 * Camera arithmetic for the release film's recipes (VC-464).
 *
 * Flute's stage transform is `translate3d(-cam) rotateX rotateY rotateZ`, so
 * for a world point p the view position is R·p − cam, with R = Rx·Ry·Rz in
 * CSS's own matrices (y down, +z toward the viewer). Camera x/y/z are
 * therefore screen-space pans and a dolly, and "keep this world point at this
 * screen offset, this close" solves for the camera directly. Recipes are
 * generated from these look-at rigs because a hand-written keyframe list
 * cannot track a point across a changing rotation.
 */

const rad = (deg) => (deg * Math.PI) / 180;

export function rotate([x, y, z], { rotateX = 0, rotateY = 0, rotateZ = 0 }) {
  // Rz
  let c = Math.cos(rad(rotateZ));
  let s = Math.sin(rad(rotateZ));
  [x, y] = [c * x - s * y, s * x + c * y];
  // Ry
  c = Math.cos(rad(rotateY));
  s = Math.sin(rad(rotateY));
  [x, z] = [c * x + s * z, -s * x + c * z];
  // Rx
  c = Math.cos(rad(rotateX));
  s = Math.sin(rad(rotateX));
  [y, z] = [c * y - s * z, s * y + c * z];
  return [x, y, z];
}

export const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const mix = (a, b, p) => a + (b - a) * p;
export const ease = {
  linear: (x) => x,
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  outCubic: (x) => 1 - (1 - x) ** 3,
  inCubic: (x) => x * x * x,
  outQuart: (x) => 1 - (1 - x) ** 4,
  outQuint: (x) => 1 - (1 - x) ** 5,
  outExpo: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  inExpo: (x) => (x <= 0 ? 0 : 2 ** (10 * x - 10)),
  inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  cinematic: (x) => x * x * x * (x * (x * 6 - 15) + 10),
};

/** Eased progress of t through [from, to], clamped 0..1. */
export function progress(t, from, to, curve = ease.linear) {
  return curve(clamp01((t - from) / (to - from)));
}

/** Piecewise track over `[t, value]` stops, each segment eased. */
export function track(t, stops, curve = ease.inOutCubic) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i += 1) {
    const [t0, v0] = stops[i - 1];
    const [t1, v1] = stops[i];
    if (t <= t1) return mix(v0, v1, curve(clamp01((t - t0) / (t1 - t0))));
  }
  return stops[stops.length - 1][1];
}

/** Linear interpolation between 3-vectors along eased stops. */
export function track3(t, stops, curve = ease.inOutCubic) {
  return [0, 1, 2].map((axis) =>
    track(
      t,
      stops.map(([at, v]) => [at, v[axis]]),
      curve,
    ),
  );
}

/**
 * A look-at rig sampled into Flute camera + focus tracks.
 *
 *   rig(t) → {
 *     rotation: { rotateX, rotateY, rotateZ },   // the world's pose
 *     target: [x, y, z],                          // world point to frame
 *     near: number,        // the target's view z (+ = closer; magnifies P/(P−near))
 *     offset?: [sx, sy],   // where on screen the target sits, in scene px
 *     focus?: number,      // extra focus distance beyond the target (+ = farther)
 *     fStop?, focalLength?, maxBlur?
 *   }
 */
/**
 * Cubic Hermite from (p0, slope v0) at t0 to (p1, slope v1) at t1 — for joins
 * where two shots must meet with the same velocity (the loop).
 */
export function hermite(t, t0, t1, p0, p1, v0 = 0, v1 = 0) {
  const h = t1 - t0;
  const s = clamp01((t - t0) / h);
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * p0 +
    (s3 - 2 * s2 + s) * h * v0 +
    (-2 * s3 + 3 * s2) * p1 +
    (s3 - s2) * h * v1
  );
}

const round = (v) => Math.round(v * 100) / 100;

export function sampleRig({ durationMs, perspective, rig, stepMs = 1000 / 30, guard = [] }) {
  const times = [];
  // Integer steps, not accumulated floats: an accumulated 2200.0000001 would
  // round onto the final keyframe and duplicate it.
  for (let i = 0; i * stepMs < durationMs - 0.5; i += 1)
    times.push(Math.round(i * stepMs * 1000) / 1000);
  times.push(durationMs);
  const samples = times.map((t) => {
    const r = rig(t);
    const rotation = { rotateX: 0, rotateY: 0, rotateZ: 0, ...r.rotation };
    const [qx, qy, qz] = rotate(r.target, rotation);
    const near = r.near ?? 0;
    const [ox, oy] = r.offset ?? [0, 0];
    // Screen offset of the target is view.xy·P/(P−near); solve view.xy for it.
    const k = (perspective - near) / perspective;
    const camera = {
      x: qx - ox * k,
      y: qy - oy * k,
      z: qz - near,
      ...rotation,
    };
    const focus = {
      distance: perspective - near + (r.focus ?? 0),
      fStop: r.fStop ?? 8,
      focalLength: r.focalLength ?? 50,
      maxBlur: r.maxBlur ?? 6,
    };
    // Nothing may reach the camera plane: a surface at or past it renders
    // inside out, and Flute flags it. `guard` lists the scene's extreme points.
    for (const point of guard) {
      const [, , vz] = rotate(point, rotation);
      const depth = perspective - (vz - camera.z);
      if (depth < 120) {
        console.warn(
          `  near-plane: t=${t.toFixed(0)} point ${JSON.stringify(point)} depth ${depth.toFixed(0)}`,
        );
      }
    }
    return { t, camera, focus };
  });
  const tracks = [];
  for (const property of ["x", "y", "z", "rotateX", "rotateY", "rotateZ"]) {
    const values = samples.map((s) => round(s.camera[property]));
    if (values.every((v) => v === values[0])) continue;
    tracks.push({
      target: { kind: "camera" },
      property,
      keyframes: samples.map((s, i) => ({ timeMs: s.t, value: values[i], easing: "linear" })),
    });
  }
  for (const property of ["distance", "fStop", "focalLength", "maxBlur"]) {
    const values = samples.map((s) => round(s.focus[property]));
    if (values.every((v) => v === values[0])) continue;
    tracks.push({
      target: { kind: "focus" },
      property,
      keyframes: samples.map((s, i) => ({ timeMs: s.t, value: values[i], easing: "linear" })),
    });
  }
  const first = samples[0];
  return {
    camera: {
      perspective,
      ...Object.fromEntries(Object.entries(first.camera).map(([k, v]) => [k, round(v)])),
    },
    focus: Object.fromEntries(Object.entries(first.focus).map(([k, v]) => [k, round(v)])),
    tracks,
  };
}

/** One recipe document, in Flute's `src/flute/scenes/<id>.scene.json` shape. */
export function recipe({
  id,
  title,
  description,
  width,
  height,
  durationMs,
  perspective,
  rig,
  nodes,
  surfaceTracks = [],
  stepMs,
  guard,
}) {
  const { camera, focus, tracks } = sampleRig({ durationMs, perspective, rig, stepMs, guard });
  return {
    version: 1,
    id,
    title,
    ...(description ? { description } : {}),
    definition: {
      scene: { version: 3, camera, focus, nodes },
      motion: { durationMs, speed: 1, tracks: [...tracks, ...surfaceTracks] },
      width,
      height,
    },
  };
}

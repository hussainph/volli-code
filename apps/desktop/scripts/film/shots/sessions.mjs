/**
 * Micro-beat · dozens of sessions, still fast (src/flute/shots/sessions.tsx).
 * A 1600×960 AppShell window centred on the origin; the sidebar sits in
 * x ∈ [-790, -490]. Its list scrolls hard from scene time while the camera
 * rides a steep oblique alongside it, travelling down with the scroll so the
 * rows stream past, the window receding to the right into the aurora world.
 */
import { ease, mix, progress } from "../lib.mjs";

function sessionsRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 1400, ease.inOutSine);
    return {
      rotation: wide
        ? { rotateX: mix(12, 8, p), rotateY: mix(34, 28, p), rotateZ: mix(-6, -4, p) }
        : { rotateX: mix(20, 16, p), rotateY: mix(22, 18, p), rotateZ: mix(-6, -4, p) },
      target: [-600, mix(-160, 160, p), 0],
      near: wide ? mix(420, 520, p) : mix(360, 460, p),
      offset: wide ? [-620, -40] : [-40, -460],
      focus: 0,
      fStop: 3.2,
      focalLength: 60,
      maxBlur: 7,
    };
  };
}

export const shot = {
  key: "sessions",
  title: "Dozens of sessions, still fast",
  description: "The real sidebar scrolls hard through dozens of live sessions.",
  durationMs: 1400,
  perspective: 1400,
  nodes: [{ id: "window" }],
  rig: sessionsRig,
  guard: [
    [-800, -480, 0],
    [800, -480, 0],
    [-800, 480, 0],
    [800, 480, 0],
  ],
};

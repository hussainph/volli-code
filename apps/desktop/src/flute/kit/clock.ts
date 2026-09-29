/**
 * Scene-time arithmetic for the release film (VC-464).
 *
 * Every state change on screen is a pure function of the scene clock
 * (`useSceneTime()`), never of the wall clock: `flute export` and the film's
 * capture script seek the clock one frame at a time, so anything driven by a
 * timer, an interval or an un-pinned CSS transition would land on a different
 * frame in every render. These helpers are the only vocabulary the scenes use
 * to turn "milliseconds into the shot" into a value.
 */

export type Ease = (x: number) => number;

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);

export const ease = {
  linear: (x: number) => x,
  inCubic: (x: number) => x * x * x,
  outCubic: (x: number) => 1 - (1 - x) ** 3,
  outQuart: (x: number) => 1 - (1 - x) ** 4,
  outQuint: (x: number) => 1 - (1 - x) ** 5,
  outExpo: (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  inOutCubic: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  inOutQuint: (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  inOutSine: (x: number) => -(Math.cos(Math.PI * x) - 1) / 2,
  /** Same shape as Flute's `cinematic`: zero velocity and acceleration at both ends. */
  cinematic: (x: number) => x * x * x * (x * (x * 6 - 15) + 10),
  /** The app's own `--ease-out` token, cubic-bezier(0.23, 1, 0.32, 1), sampled. */
  appOut: (x: number) => bezier(0.23, 1, 0.32, 1, x),
  /** The app's `--ease-swift`, cubic-bezier(0.32, 0.72, 0, 1). */
  swift: (x: number) => bezier(0.32, 0.72, 0, 1, x),
  outBack: (x: number) => {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
  },
} satisfies Record<string, Ease>;

/** A CSS cubic-bezier evaluated at progress `x`, by bisection on the x curve. */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const curve = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  let s = x;
  for (let i = 0; i < 28; i += 1) {
    s = (lo + hi) / 2;
    if (curve(x1, x2, s) < x) lo = s;
    else hi = s;
  }
  return curve(y1, y2, s);
}

/** Eased progress of `t` through the window `[from, to]`, clamped to 0..1. */
export function progress(t: number, from: number, to: number, curve: Ease = ease.linear): number {
  if (to <= from) return t >= to ? 1 : 0;
  return curve(clamp01((t - from) / (to - from)));
}

export function mix(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/**
 * A piecewise track: `[timeMs, value]` stops, each segment eased by `curve`.
 * Holds the first value before the first stop and the last after the last.
 */
export function track(
  t: number,
  stops: readonly (readonly [number, number])[],
  curve: Ease = ease.inOutCubic,
): number {
  if (stops.length === 0) return 0;
  const first = stops[0]!;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (t <= b[0]) return mix(a[1], b[1], progress(t, a[0], b[0], curve));
  }
  return stops[stops.length - 1]![1];
}

/** How many of `times` have passed at `t` — a step counter for discrete events. */
export function stepsPassed(t: number, times: readonly number[]): number {
  let count = 0;
  for (const at of times) if (t >= at) count += 1;
  return count;
}

/** Characters of `text` typed by `t`, starting at `from`, one per `perCharMs`. */
export function typed(text: string, t: number, from: number, perCharMs: number): string {
  if (t < from) return "";
  return text.slice(0, Math.min(text.length, Math.floor((t - from) / perCharMs) + 1));
}

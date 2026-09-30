/**
 * Micro-shot · usage limits, always in view.
 * Component: src/flute/shots/limits.tsx. Layout: a 1440×900 AppShell window
 * centred on the origin; the usage icon sits at ≈ (206, -431) beside ⌘K, and
 * the open popover hangs under it, centred ≈ (206, -300).
 *
 * The camera starts on a tight oblique of the title-bar icon and follows the
 * press down into the popover while the bars fill, easing back just enough for
 * the gold world above the window's top edge to open up.
 */
import { ease, mix, progress } from "../lib.mjs";

const ICON = [206, -431, 0];
const PANEL = [206, -305, 0];

function limitsRig(format) {
  const wide = format === "wide";
  return (t) => {
    const travel = ease.inOutCubic(progress(t, 60, 900, ease.linear));
    const drift = progress(t, 0, 1600, ease.linear);
    const at = (i) => mix(ICON[i], PANEL[i], travel);
    return {
      rotation: wide
        ? { rotateX: mix(22, 14, travel) - 2 * drift, rotateY: mix(-20, -12, travel), rotateZ: 3 }
        : { rotateX: mix(20, 12, travel) - 2 * drift, rotateY: mix(-14, -8, travel), rotateZ: 2 },
      target: [at(0) - 20 * drift, at(1), at(2)],
      near: wide ? mix(980, 1040, travel) + 20 * drift : mix(980, 1000, travel) + 30 * drift,
      // 9:16 keeps the panel low so the gold world above the window sits behind
      // the upper super.
      offset: wide ? [0, mix(-40, -120, travel)] : [0, mix(260, 180, travel)],
      focus: 0,
      fStop: 3.6,
      focalLength: 60,
      maxBlur: 6,
    };
  };
}

export const shot = {
  key: "limits",
  title: "Your limits, always in view",
  description: "The usage-limits icon beside ⌘K opens onto Session and Weekly windows.",
  durationMs: 1600,
  perspective: 1400,
  nodes: [{ id: "window" }],
  rig: limitsRig,
  guard: [
    [-720, -450, 0],
    [720, -450, 0],
    [-720, 450, 0],
    [720, 450, 0],
  ],
};

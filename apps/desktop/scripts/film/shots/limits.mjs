/**
 * Real usage popover staged with the real 1440 × 900 AppShell. Its current
 * provider marks, accordion and pin controls need more height than the old
 * mirrored card. Frame the whole instrument, not a cropped header.
 */
import { ease, mix, progress } from "../lib.mjs";

const ICON = [166, -427, 0];
const PANEL = [166, -275, 0];

function limitsRig(format) {
  const wide = format === "wide";
  return (t) => {
    // Arrive early enough that the complete instrument already fits when
    // the real portal becomes visible at 280ms, not halfway through its reveal.
    const travel = progress(t, 0, 600, ease.inOutCubic);
    const drift = progress(t, 0, 1600);
    return {
      rotation: wide
        ? { rotateX: mix(12, 6, travel), rotateY: mix(-10, -5, travel), rotateZ: 1 }
        : { rotateX: mix(10, 5, travel), rotateY: mix(-7, -3, travel), rotateZ: 1 },
      target: ICON.map((value, index) => mix(value, PANEL[index], travel)),
      near: wide ? mix(740, 810, travel) + 10 * drift : mix(730, 790, travel) + 10 * drift,
      offset: wide ? [300, mix(-100, -140, travel)] : [0, mix(260, 230, travel)],
      focus: 0,
      fStop: 8,
      focalLength: 60,
      maxBlur: 2,
    };
  };
}

export const shot = {
  key: "limits",
  title: "Your limits, always in view",
  description: "The real usage popover: provider identities, Session and Weekly windows, and pins.",
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

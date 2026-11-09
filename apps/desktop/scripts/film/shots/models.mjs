/**
 * Current Settings' real default-model tree: 560 × 291 pane px at 2×.
 * Frame the whole ladder, including the complete model/effort pills. The
 * refreshed Ticket and re-picked Fast states come from scene time in the shot.
 */
import { ease, mix, progress, rotate } from "../lib.mjs";

const PANE = { width: 560, height: 291 };
const ZOOM = 2;
const ROW = { board: 57, utility: 97.5, ticket: 138.5, fast: 183.5, deep: 228.5, visual: 269.5 };
const world = (x, y) => [(x - PANE.width / 2) * ZOOM, (y - PANE.height / 2) * ZOOM, 0];

function modelsRig(format) {
  const wide = format === "wide";
  return (t) => {
    const drift = progress(t, 0, 2600, ease.inOutCubic);
    const beat = progress(t, 1200, 1900, ease.inOutCubic);
    const rotation = wide
      ? { rotateX: mix(12, 8, drift), rotateY: mix(-7, -3, drift), rotateZ: mix(-2, 1, drift) }
      : { rotateX: mix(12, 8, drift), rotateY: mix(-4, 3, drift), rotateZ: mix(2, -2, drift) };
    const target = world(PANE.width / 2, PANE.height / 2);
    const focused = world(300, mix(ROW.ticket, ROW.fast, beat));
    const [, , tz] = rotate(target, rotation);
    const [, , fz] = rotate(focused, rotation);
    return {
      rotation,
      target,
      // Keep the complete 1120px crop inside both authored viewports, with
      // margin for its tilted corners — never crop a label or effort pill.
      near: wide ? mix(-20, 30, drift) : mix(-400, -320, drift),
      offset: wide ? [mix(230, 200, drift), -140] : [0, 230],
      focus: tz - fz,
      fStop: 8,
      focalLength: 80,
      maxBlur: 2,
    };
  };
}

export const shot = {
  key: "models",
  title: "Newest models, a model for every subagent",
  description:
    "The current Settings default-model tree; Ticket refreshes, then Fast changes model.",
  durationMs: 2600,
  perspective: 1400,
  nodes: [{ id: "model-tree" }],
  rig: modelsRig,
};

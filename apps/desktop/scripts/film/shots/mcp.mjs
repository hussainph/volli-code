/**
 * Agents · plug in any MCP server (src/flute/shots/mcp.tsx). The real MCP pane
 * in a 900×620 settings card; figma switches on at 640ms. The camera comes in
 * on a firm oblique and slides toward the switching row, keeping the card to
 * one side so the super sits on the cobalt world: right of frame in 16:9,
 * low in 9:16.
 */
import { ease, mix, progress } from "../lib.mjs";

function mcpRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 1400, ease.outCubic);
    return {
      rotation: wide
        ? { rotateX: mix(14, 9, p), rotateY: mix(-26, -16, p), rotateZ: mix(3, 1.5, p) }
        : { rotateX: mix(18, 12, p), rotateY: mix(-14, -8, p), rotateZ: mix(3, 1.5, p) },
      target: wide ? [mix(-60, 0, p), mix(-40, 20, p), 0] : [mix(-260, -200, p), mix(-60, 0, p), 0],
      near: wide ? mix(470, 700, p) : mix(420, 560, p),
      offset: wide ? [mix(470, 520, p), 30] : [60, mix(300, 340, p)],
      focus: 0,
      fStop: 4,
      focalLength: 60,
      maxBlur: 6,
    };
  };
}

export const shot = {
  key: "mcp",
  title: "Plug in any MCP server",
  description: "Settings → MCP: four servers, figma switches on.",
  durationMs: 1400,
  perspective: 1400,
  nodes: [{ id: "card" }],
  rig: mcpRig,
  guard: [
    [-550, -350, 0],
    [550, -350, 0],
    [-550, 350, 0],
    [550, 350, 0],
  ],
};

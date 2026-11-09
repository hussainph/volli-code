/**
 * The separate Settings window's real MCP page, 1320 × 820 world px.
 * Keep the complete Settings window in both cuts: the entire rail and all
 * server/tool/status columns, with margin. Figma switches on at 640ms.
 */
import { ease, mix, progress } from "../lib.mjs";

function mcpRig(format) {
  const wide = format === "wide";
  return (t) => {
    const p = progress(t, 0, 1400, ease.outCubic);
    return {
      rotation: wide
        ? { rotateX: mix(10, 6, p), rotateY: mix(-12, -6, p), rotateZ: mix(2, 0.5, p) }
        : { rotateX: mix(12, 7, p), rotateY: mix(-8, -4, p), rotateZ: mix(2, 0.5, p) },
      target: [0, 0, 0],
      near: wide ? mix(-240, -180, p) : mix(-680, -600, p),
      offset: wide ? [260, -130] : [0, 250],
      focus: 0,
      fStop: 8,
      focalLength: 60,
      maxBlur: 2,
    };
  };
}

export const shot = {
  key: "mcp",
  title: "Plug in any MCP server",
  description: "Settings → MCP Servers: real navigation, four servers, tool counts and enablement.",
  durationMs: 1400,
  perspective: 1400,
  nodes: [{ id: "card" }],
  rig: mcpRig,
  guard: [
    [-660, -410, 0],
    [660, -410, 0],
    [-660, 410, 0],
    [660, 410, 0],
  ],
};

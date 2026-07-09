// Design tokens for the renderer (per CLAUDE.md: tokens live in one shared
// module, not per-component). Only the values already in use are seeded here
// — spacing/radii/timing come later, once real values exist to record.

export const palette = {
  accent: "#E8652A",
  background: "#111111",
  foreground: "#f5f5f5",
} as const;

export const font = {
  sans: "system-ui, sans-serif",
  mono: "monospace",
} as const;

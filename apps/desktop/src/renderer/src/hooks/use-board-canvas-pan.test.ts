import { describe, expect, it } from "vite-plus/test";

import { isBoardCanvasPanTarget } from "./use-board-canvas-pan";

describe("isBoardCanvasPanTarget", () => {
  const canvas = {} as EventTarget;
  const card = {} as EventTarget;

  it("starts a primary-button pan only on the canvas background", () => {
    expect(isBoardCanvasPanTarget(canvas, canvas, 0)).toBe(true);
    expect(isBoardCanvasPanTarget(card, canvas, 0)).toBe(false);
  });

  it("starts a middle-button pan anywhere on the canvas", () => {
    expect(isBoardCanvasPanTarget(canvas, canvas, 1)).toBe(true);
    expect(isBoardCanvasPanTarget(card, canvas, 1)).toBe(true);
  });

  it("ignores other buttons", () => {
    expect(isBoardCanvasPanTarget(canvas, canvas, 2)).toBe(false);
  });
});

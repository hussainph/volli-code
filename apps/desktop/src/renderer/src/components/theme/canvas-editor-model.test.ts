import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";

import {
  CANVAS_SWATCH_PAGES,
  describeAppearance,
  droppedStopIndex,
  normalizeStopHex,
  padAnchor,
  swatchPageOf,
} from "./canvas-editor-model";

const RECT = { left: 100, top: 50, width: 400, height: 250 };

describe("padAnchor", () => {
  it("reports a pointer as the fraction of the pad it landed on", () => {
    expect(padAnchor({ pointerX: 300, pointerY: 175, grabX: 0, grabY: 0, rect: RECT })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it("subtracts the grab offset, so a drag never starts with a jump", () => {
    // Pressed 10px right and 8px below the orb's centre: the orb has to stay
    // gripped there, which means the anchor is the POINTER minus the grab, not
    // the pointer. Without this the orb teleports by up to its own radius on the
    // first frame past the slop — measured at 14px for a 6px move in the lab.
    const anchor = padAnchor({ pointerX: 300, pointerY: 175, grabX: 10, grabY: 8, rect: RECT });

    expect(anchor.x).toBeCloseTo((300 - 10 - 100) / 400, 10);
    expect(anchor.y).toBeCloseTo((175 - 8 - 50) / 250, 10);
  });

  it("answers the middle for a pad that has not been laid out, rather than NaN", () => {
    // A zero-sized rect divides to NaN, `moveStop`'s clamp passes NaN straight
    // through (`Math.min(NaN, …)` is NaN), and the canvas reaches CSS as an
    // unparseable gradient — a blank window with no error anywhere.
    const anchor = padAnchor({
      pointerX: 0,
      pointerY: 0,
      grabX: 0,
      grabY: 0,
      rect: { left: 0, top: 0, width: 0, height: 0 },
    });

    expect(anchor).toEqual({ x: 0.5, y: 0.5 });
  });

  it("does not clamp — the bounds are moveStop's to own", () => {
    const anchor = padAnchor({ pointerX: 0, pointerY: 0, grabX: 0, grabY: 0, rect: RECT });

    expect(anchor.x).toBeLessThan(0);
    expect(anchor.y).toBeLessThan(0);
  });
});

describe("swatchPageOf", () => {
  it("finds a swatch on whichever page holds it, case-insensitively", () => {
    expect(swatchPageOf("#E8652A")).toBe(1);
    expect(swatchPageOf("#f2a7c3")).toBe(0);
  });

  it("reports -1 for a colour no page holds, so the row can stay where it is", () => {
    // The page follows the primary; a hand-typed hex belongs to neither page and
    // must not yank the row to page 0.
    expect(swatchPageOf("#123456")).toBe(-1);
  });

  it("keeps every swatch lowercase, so the ring can be matched by value", () => {
    for (const page of CANVAS_SWATCH_PAGES) {
      for (const swatch of page) expect(swatch).toBe(swatch.toLowerCase());
    }
  });
});

describe("droppedStopIndex", () => {
  it("has nothing to drop from a one-colour canvas", () => {
    expect(droppedStopIndex(DEFAULT_CANVAS)).toBeNull();
  });

  it("drops the last stop", () => {
    const canvas: Canvas = {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#e8652a", x: 0.3, y: 0.3 },
        { hex: "#2e6f8e", x: 0.7, y: 0.7 },
      ],
      primaryIndex: 0,
    };

    expect(droppedStopIndex(canvas)).toBe(1);
  });

  it("drops the one below it when the last stop IS the primary", () => {
    // "−" means one fewer colour; taking the primary would recolour the whole
    // window instead. Mirrors `removeStop`, so the button can name its victim.
    const canvas: Canvas = {
      ...DEFAULT_CANVAS,
      stops: [
        { hex: "#e8652a", x: 0.3, y: 0.3 },
        { hex: "#2e6f8e", x: 0.7, y: 0.7 },
      ],
      primaryIndex: 1,
    };

    expect(droppedStopIndex(canvas)).toBe(0);
  });
});

describe("normalizeStopHex", () => {
  it("accepts the shapes a person types and emits the one shape the model stores", () => {
    expect(normalizeStopHex("  E8652A ")).toBe("#e8652a");
    expect(normalizeStopHex("#ABC")).toBe("#aabbcc");
    expect(normalizeStopHex("#e8652a")).toBe("#e8652a");
  });

  it("rejects anything that is not a colour", () => {
    expect(normalizeStopHex("")).toBeNull();
    expect(normalizeStopHex("#zzzzzz")).toBeNull();
    expect(normalizeStopHex("#e8652")).toBeNull();
    expect(normalizeStopHex("rebeccapurple")).toBeNull();
  });
});

describe("describeAppearance", () => {
  it("says what auto currently resolves to, because auto alone is not an answer", () => {
    expect(describeAppearance("auto", "dark")).toBe("Auto — dark right now");
    expect(describeAppearance("auto", "light")).toBe("Auto — light right now");
  });

  it("names an explicit choice plainly", () => {
    expect(describeAppearance("light", "light")).toBe("Light");
    expect(describeAppearance("dark", "light")).toBe("Dark");
  });
});

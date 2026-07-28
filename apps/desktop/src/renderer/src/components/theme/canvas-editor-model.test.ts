import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";

import {
  canvasContrastReport,
  CANVAS_FLOOR_ROLES,
  CANVAS_SWATCH_PAGES,
  describeAppearance,
  droppedStopIndex,
  easedVibrancy,
  normalizeStopHex,
  padAnchor,
  percentLabel,
  projectAppearanceChoice,
  projectCanvasChoice,
  swatchPageOf,
} from "./canvas-editor-model";

/** A one-stop canvas at a given colour and vibrancy — the sweep's input shape. */
function canvasOf(hex: string, vibrancy: number): Canvas {
  return { ...DEFAULT_CANVAS, stops: [{ hex, x: 0.5, y: 0.5 }], vibrancy };
}

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

describe("the scope tri-states", () => {
  it("reads an absent value as inheriting, never as a stored marker", () => {
    expect(projectCanvasChoice(null)).toEqual({ kind: "inherit" });
    expect(projectAppearanceChoice(null)).toEqual({ kind: "inherit" });
  });

  it("carries the stored value through when there is one", () => {
    expect(projectCanvasChoice(DEFAULT_CANVAS)).toEqual({
      kind: "custom",
      canvas: DEFAULT_CANVAS,
    });
    expect(projectAppearanceChoice("auto")).toEqual({ kind: "custom", appearance: "auto" });
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

describe("canvasContrastReport", () => {
  it("measures every floor copyFloors declares, on the surface it is solved against", () => {
    const report = canvasContrastReport(DEFAULT_CANVAS, "dark");

    expect(report.readings.map((reading) => reading.token)).toEqual(
      CANVAS_FLOOR_ROLES.map((role) => role.token),
    );
    // Secondary copy is solved on `--card`, one rung UNDER the page — scoring it
    // on `--background` is exactly how it came to be 3 Lc short on every panel
    // in the app while a readout said it passed.
    expect(report.readings[1].surface).toBe("--card");
  });

  it("strands nothing on the shipped canvas, in both modes", () => {
    for (const resolved of ["light", "dark"] as const) {
      const report = canvasContrastReport(DEFAULT_CANVAS, resolved);

      expect(report.stranded).toEqual([]);
      expect(report.worstShortfall).toBe(0);
      for (const reading of report.readings) {
        // Half an Lc of slack for the 8-bit hex the solver actually emits.
        expect(reading.achieved).toBeGreaterThan(reading.floor - 0.5);
      }
    }
  });

  it("names the floor a saturated canvas physically strands", () => {
    // Not a hypothetical. Swept across hue × chroma × lightness × vibrancy, a
    // saturated magenta in LIGHT is where the ladder runs out of space: the
    // settled surface spread pushes `--sidebar` to a lightness where no ink of
    // any hue clears 75 on it. The engine clamps and says nothing, so this report
    // is the only thing in the app that can tell.
    const report = canvasContrastReport(canvasOf("#e068d8", 1), "light");

    expect(report.stranded.map((reading) => reading.token)).toEqual(["--sidebar-foreground"]);
    expect(report.worstShortfall).toBeGreaterThan(0.5);
    expect(report.worstShortfall).toBeLessThan(1);
    // The reading still reports what it DID reach — the panel says how far short
    // rather than only that it is short — and what it reached IS the ceiling,
    // because that is exactly what the solver clamped to.
    expect(report.stranded[0].achieved).toBeCloseTo(report.stranded[0].ceiling, 0);
  });

  it("separates a hairline ceiling from a stranded one", () => {
    // The distinction the whole warning rests on. This canvas puts BOTH body and
    // sidebar at their ceilings, but body misses by a few hundredths of an Lc —
    // finer than the hex it is emitted as. Reporting both as capped is honest;
    // alarming about both is not, and the shipped canvas crosses that same
    // hairline as the vibrancy slider moves.
    const report = canvasContrastReport(canvasOf("#e068d8", 1), "light");

    expect(report.capped.map((reading) => reading.token)).toEqual([
      "--foreground",
      "--sidebar-foreground",
    ]);
    expect(report.stranded.map((reading) => reading.token)).toEqual(["--sidebar-foreground"]);
    const body = report.readings[0];
    expect(body.capped).toBe(true);
    expect(body.stranded).toBe(false);
    expect(body.shortfall).toBeLessThan(0.5);
  });

  it("leaves dark alone — the dark ladder has ceilings to spare", () => {
    const report = canvasContrastReport(canvasOf("#e068d8", 1), "dark");

    expect(report.capped).toEqual([]);
    expect(report.stranded).toEqual([]);
  });
});

describe("easedVibrancy", () => {
  it("offers nothing when nothing is stranded", () => {
    expect(easedVibrancy(DEFAULT_CANVAS, "light")).toBeNull();
    expect(easedVibrancy(DEFAULT_CANVAS, "dark")).toBeNull();
  });

  it("offers a vibrancy that actually clears, not merely a lower one", () => {
    // The shortfall is NOT monotone in vibrancy — measured, a magenta strands
    // less at 0.5 than at 0.75 — so this has to search rather than step once. An
    // offer that did not clear would be worse than no offer.
    const canvas = canvasOf("#e068d8", 1);
    const eased = easedVibrancy(canvas, "light");

    expect(eased).not.toBeNull();
    expect(eased!).toBeLessThan(canvas.vibrancy);
    expect(canvasContrastReport({ ...canvas, vibrancy: eased! }, "light").stranded).toEqual([]);
  });

  it("lands on a slider notch, so the offer is a value the user can also reach by hand", () => {
    const eased = easedVibrancy(canvasOf("#e068d8", 1), "light");

    expect(Math.round(eased! * 100) % 5).toBe(0);
  });
});

describe("percentLabel", () => {
  it("rounds a 0–1 control to whole percent", () => {
    expect(percentLabel(0)).toBe("0%");
    expect(percentLabel(0.153)).toBe("15%");
    expect(percentLabel(1)).toBe("100%");
  });
});

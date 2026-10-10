import { describe, expect, it } from "vite-plus/test";
import { resolveStudyValues, MACOS27_STOPS } from "./macos27";
import { deriveCanvasPaint } from "@renderer/theme/canvas-paint";
import { SURFACE_PRESETS, studyCanvas, surfaceStyle, type SurfaceValues } from "./model";

export function values(): SurfaceValues {
  return {
    reference: { treatment: "surface", balance: 0.5, active: true },
    canvas: {
      appearance: "light",
      environment: "neutral",
      keyColour: "#359b96",
      returnColour: "#8d65ac",
      vibrancy: 0.35,
      grain: 0,
      backdropDetail: false,
    },
    lens: {
      material: "glass",
      bevel: 5,
      sheen: 0.12,
      opacity: 0.76,
      blur: 12,
      lift: 20,
      shadow: 0.8,
      radius: 20,
      tint: 0.18,
    },
    workPane: {
      material: "matte",
      opacity: 1,
      blur: 0,
      tint: 0.04,
      lift: 6,
      shadow: 0.45,
      bevel: 1.5,
      sheen: 0.04,
      rim: 0.25,
      radius: 20,
    },
    lighting: { angle: 135, rim: 0.7, thickness: 1.5 },
    controls: { crown: 0.12, colour: 0.18 },
    placement: { _collapsed: true, keyX: 0.22, keyY: 0.22, returnX: 0.78, returnY: 0.78 },
    opticalExperiment: { _collapsed: true, displacement: 0 },
  };
}

const COLOURS = ["#359b96", "#8d65ac"] as const;

describe("Surface study materials", () => {
  it("starts neutral, not Ember; authored colours enter only in the colour environment", () => {
    const input = values();
    expect(studyCanvas(input, COLOURS).stops).toEqual([{ hex: "#808080", x: 0.5, y: 0.5 }]);
    input.canvas.environment = "colour";
    expect(studyCanvas(input, COLOURS).stops.map((stop) => stop.hex)).toEqual(COLOURS);
  });

  for (const mode of ["light", "dark"] as const) {
    it(`uses the production canvas derivation in ${mode}, including shadows and portal tokens`, () => {
      const input = values();
      const canvas = studyCanvas(input, COLOURS);
      const expected = deriveCanvasPaint(canvas, mode);
      const style = surfaceStyle(input, canvas, mode, "lens-filter");
      expect(style).toMatchObject({
        ...expected.tokens,
        ...expected.canvasTokens,
        colorScheme: mode,
      });
      expect(style["--surface-backdrop"]).toBe("blur(12px)");
    });
  }

  it("keeps matte colours and ink fixed while optical controls change", () => {
    const input = values();
    const canvas = studyCanvas(input, COLOURS);
    const before = surfaceStyle(input, canvas, "light", "lens-filter");
    input.lens.opacity = 0.35;
    input.lighting.rim = 1;
    input.opticalExperiment.displacement = 16;
    const after = surfaceStyle(input, canvas, "light", "lens-filter");
    expect(after["--card"]).toBe(before["--card"]);
    expect(after["--foreground"]).toBe(before["--foreground"]);
    expect(after["--surface-opacity"]).toBe("35%");
    expect(after["--surface-backdrop"]).toBe("blur(12px) url(#lens-filter)");
  });

  it("tunes work-pane transmission without changing ink, theme tokens or inspector optics", () => {
    const input = values();
    const canvas = studyCanvas(input, COLOURS);
    const before = surfaceStyle(input, canvas, "dark", "lens-filter");
    input.workPane.opacity = 0.4;
    input.workPane.blur = 14;
    input.workPane.bevel = 8;
    const after = surfaceStyle(input, canvas, "dark", "lens-filter");
    expect(after["--foreground"]).toBe(before["--foreground"]);
    expect(after["--card"]).toBe(before["--card"]);
    expect(after["--surface-opacity"]).toBe(before["--surface-opacity"]);
    expect(after["--work-opacity"]).toBe("40%");
    expect(after["--work-backdrop"]).toBe("blur(14px)");
    expect(after["--work-bevel"]).toBe("8px");
  });

  it("flat removes lift, crown and refraction instead of leaving a decorative shadow", () => {
    const input = values();
    Object.assign(input.lens, SURFACE_PRESETS.flat.lens);
    Object.assign(input.workPane, SURFACE_PRESETS.flat.workPane);
    Object.assign(input.lighting, SURFACE_PRESETS.flat.lighting);
    Object.assign(input.controls, SURFACE_PRESETS.flat.controls);
    const style = surfaceStyle(input, studyCanvas(input, COLOURS), "dark", "lens-filter");
    expect(style["--surface-shadow"]).toBe("none");
    expect(style["--surface-contact"]).toBe("none");
    expect(style["--work-backdrop"]).toBe("none");
    expect(style["--work-shadow"]).toBe("none");
    expect(style["--work-bevel"]).toBe("0px");
    expect(style["--surface-rim"]).toBe("0%");
    expect(style["--surface-backdrop"]).toBe("none");
    expect(style["--surface-opacity"]).toBe("100%");
  });
});

it("leaves authored Aqua materials untouched and resolves a continuous coordinated glass study", () => {
  const authored = values();
  expect(resolveStudyValues(authored)).toBe(authored);
  authored.reference.treatment = "macos27";
  const original = structuredClone(authored);
  const samples = MACOS27_STOPS.map((stop) =>
    resolveStudyValues({
      ...authored,
      reference: { ...authored.reference, balance: stop.balance },
    }),
  );
  expect(samples.map((sample) => sample.lens.opacity)).toEqual([0.24, 0.57, 0.9]);
  expect(samples.map((sample) => sample.lens.blur)).toEqual([6, 14, 22]);
  expect(samples[0].lens.tint).toBeLessThan(samples[2].lens.tint);
  const between = resolveStudyValues({
    ...authored,
    reference: { ...authored.reference, balance: 0.37 },
  });
  expect(between.lens.opacity).toBeCloseTo(0.4842);
  expect(between.lens.blur).toBeCloseTo(11.92);
  expect(authored).toEqual(original);
  expect(between.canvas).toBe(authored.canvas);
  expect(between.placement).toBe(authored.placement);
  expect(between.workPane).toMatchObject({ opacity: 1, lift: 0, blur: 0, bevel: 0 });
  expect(between.opticalExperiment.displacement).toBe(0);
});

it("recedes inactive chrome without fading ink or mutating theme tokens", () => {
  const authored = values();
  authored.reference.treatment = "macos27";
  const active = resolveStudyValues(authored);
  const inactive = resolveStudyValues({
    ...authored,
    reference: { ...authored.reference, active: false },
  });
  const canvas = studyCanvas(authored, ["#359b96", "#8d65ac"]);
  for (const mode of ["light", "dark"] as const) {
    const on = surfaceStyle(active, canvas, mode, "optics");
    const off = surfaceStyle(inactive, canvas, mode, "optics");
    expect(off["--foreground"]).toBe(on["--foreground"]);
    expect(off["--card"]).toBe(on["--card"]);
    expect(off["--surface-opacity"]).toBe(on["--surface-opacity"]);
    expect(inactive.lens.shadow).toBeLessThan(active.lens.shadow);
    expect(inactive.lighting.rim).toBeLessThan(active.lighting.rim);
    expect(on["--surface-backdrop"]).toBe("blur(14px)");
    expect(on["--reference-saturation"]).toBe("1.11");
    expect(on["--surface-bevel"]).toBe("0px");
  }
});

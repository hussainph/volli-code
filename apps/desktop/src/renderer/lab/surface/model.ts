/** Lab-only material recipes. These are tuning inputs, not new canonical tokens. */
import type { CSSProperties } from "react";
import type { DialConfig, DialKitValueUpdates, ResolvedValues } from "dialkit";
import { effectiveStopHexes, type Canvas, type ResolvedAppearance } from "@volli/shared";

import { deriveCanvasPaint } from "@renderer/theme/canvas-paint";

export const SURFACE_CONFIG = {
  reference: {
    treatment: {
      type: "select",
      options: [
        { value: "surface", label: "Surface" },
        { value: "macos27", label: "macOS 27" },
      ],
      default: "surface",
    },
    balance: [0.5, 0, 1, 0.01],
    active: true as boolean,
  },
  canvas: {
    appearance: { type: "select", options: ["light", "dark", "system"], default: "light" },
    environment: { type: "select", options: ["neutral", "colour"], default: "neutral" },
    keyColour: { type: "color", default: "#359b96" },
    returnColour: { type: "color", default: "#8d65ac" },
    vibrancy: [0.35, 0, 1, 0.01],
    grain: [0, 0, 0.5, 0.01],
    backdropDetail: false,
  },
  lens: {
    material: { type: "select", options: ["glass", "satin", "porcelain"], default: "glass" },
    bevel: [5, 0, 12, 0.5],
    sheen: [0.12, 0, 0.4, 0.01],
    opacity: [0.76, 0.35, 1, 0.01],
    blur: [12, 0, 32, 1],
    lift: [20, 0, 32, 1],
    shadow: [0.8, 0, 1, 0.01],
    radius: [20, 8, 28, 1],
    tint: [0.18, 0, 0.4, 0.01],
  },
  workPane: {
    material: { type: "select", options: ["matte", "frosted", "glass"], default: "matte" },
    opacity: [1, 0.15, 1, 0.01],
    blur: [0, 0, 24, 1],
    tint: [0.04, 0, 0.3, 0.01],
    lift: [6, 0, 24, 1],
    shadow: [0.45, 0, 1, 0.01],
    bevel: [1.5, 0, 12, 0.5],
    sheen: [0.04, 0, 0.3, 0.01],
    rim: [0.25, 0, 1, 0.01],
    radius: [20, 8, 32, 1],
  },
  lighting: {
    angle: [135, 0, 360, 1],
    rim: [0.7, 0, 1, 0.01],
    thickness: [1.5, 0, 3, 0.1],
  },
  controls: { crown: [0.12, 0, 0.3, 0.01], colour: [0.18, 0, 0.4, 0.01] },
  placement: {
    _collapsed: true,
    keyX: [0.22, 0.02, 0.98, 0.01],
    keyY: [0.22, 0.02, 0.98, 0.01],
    returnX: [0.78, 0.02, 0.98, 0.01],
    returnY: [0.78, 0.02, 0.98, 0.01],
  },
  opticalExperiment: { _collapsed: true, displacement: [0, 0, 16, 1] },
} satisfies DialConfig;

export type SurfaceValues = ResolvedValues<typeof SURFACE_CONFIG>;
export type SurfacePreset = "flat" | "borrowed" | "aqua" | "glass" | "sculpted";

// Authored canvas seeds are the ONLY literal colours. Everything painted is derived.
export function studyCanvas(values: SurfaceValues, colours: readonly [string, string]): Canvas {
  const stops =
    values.canvas.environment === "colour"
      ? [
          { hex: colours[0], x: 0.1, y: 0.1 },
          { hex: colours[1], x: 0.9, y: 0.9 },
        ]
      : [{ hex: "#808080", x: 0.5, y: 0.5 }];
  return { stops, primaryIndex: 0, vibrancy: values.canvas.vibrancy, grain: values.canvas.grain };
}

export const SURFACE_PRESETS: Record<SurfacePreset, DialKitValueUpdates<typeof SURFACE_CONFIG>> = {
  flat: {
    lens: {
      material: "porcelain",
      bevel: 0,
      sheen: 0,
      opacity: 1,
      blur: 0,
      lift: 0,
      shadow: 0,
      radius: 20,
      tint: 0,
    },
    workPane: {
      material: "matte",
      opacity: 1,
      blur: 0,
      tint: 0,
      lift: 0,
      shadow: 0,
      bevel: 0,
      sheen: 0,
      rim: 0,
      radius: 20,
    },
    lighting: { angle: 135, rim: 0, thickness: 0 },
    controls: { crown: 0, colour: 0 },
    opticalExperiment: { displacement: 0 },
  },
  borrowed: {
    lens: {
      material: "glass",
      bevel: 2,
      sheen: 0.06,
      opacity: 0.94,
      blur: 8,
      lift: 14,
      shadow: 0.6,
      radius: 18,
      tint: 0.08,
    },
    workPane: {
      material: "matte",
      opacity: 1,
      blur: 0,
      tint: 0.02,
      lift: 3,
      shadow: 0.3,
      bevel: 1,
      sheen: 0.02,
      rim: 0.15,
      radius: 20,
    },
    lighting: { angle: 135, rim: 0.35, thickness: 1 },
    controls: { crown: 0.06, colour: 0.08 },
    opticalExperiment: { displacement: 0 },
  },
  glass: {
    lens: {
      material: "glass",
      bevel: 3,
      sheen: 0.08,
      opacity: 0.6,
      blur: 12,
      lift: 18,
      shadow: 0.6,
      radius: 20,
      tint: 0.15,
    },
    workPane: {
      material: "glass",
      opacity: 0.6,
      blur: 8,
      tint: 0.1,
      lift: 8,
      shadow: 0.4,
      bevel: 3,
      sheen: 0.08,
      rim: 0.45,
      radius: 20,
    },
    lighting: { angle: 135, rim: 0.65, thickness: 1.5 },
    controls: { crown: 0.08, colour: 0.1 },
    opticalExperiment: { displacement: 0 },
  },
  sculpted: {
    lens: {
      material: "glass",
      bevel: 8,
      sheen: 0.18,
      opacity: 0.72,
      blur: 12,
      lift: 26,
      shadow: 0.8,
      radius: 24,
      tint: 0.18,
    },
    workPane: {
      material: "matte",
      opacity: 0.94,
      blur: 0,
      tint: 0.04,
      lift: 14,
      shadow: 0.6,
      bevel: 7,
      sheen: 0.15,
      rim: 0.6,
      radius: 24,
    },
    lighting: { angle: 135, rim: 0.8, thickness: 1.5 },
    controls: { crown: 0.18, colour: 0.18 },
    opticalExperiment: { displacement: 0 },
  },
  aqua: {
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
    opticalExperiment: { displacement: 0 },
  },
};

export const INSPECTOR_PRESETS = {
  glass: {
    material: "glass",
    bevel: 6,
    sheen: 0.12,
    opacity: 0.72,
    blur: 12,
    lift: 24,
    shadow: 0.8,
    radius: 22,
    tint: 0.18,
  },
  satin: {
    material: "satin",
    bevel: 8,
    sheen: 0.2,
    opacity: 0.96,
    blur: 0,
    lift: 20,
    shadow: 0.7,
    radius: 22,
    tint: 0.06,
  },
  porcelain: {
    material: "porcelain",
    bevel: 10,
    sheen: 0.12,
    opacity: 1,
    blur: 0,
    lift: 18,
    shadow: 0.65,
    radius: 22,
    tint: 0.03,
  },
} satisfies Record<string, NonNullable<DialKitValueUpdates<typeof SURFACE_CONFIG>["lens"]>>;

// Independent work-pane starts: do not reset the inspector, canvas or placement.
export const WORK_PANE_PRESETS = {
  opaque: {
    material: "matte",
    opacity: 1,
    blur: 0,
    tint: 0.02,
    lift: 0,
    shadow: 0.3,
    bevel: 0,
    sheen: 0,
    rim: 0.15,
    radius: 20,
  },
  frosted: {
    material: "frosted",
    opacity: 0.82,
    blur: 12,
    tint: 0.08,
    lift: 6,
    shadow: 0.45,
    bevel: 2,
    sheen: 0.06,
    rim: 0.3,
    radius: 20,
  },
  clear: {
    material: "glass",
    opacity: 0.5,
    blur: 0,
    tint: 0.1,
    lift: 8,
    shadow: 0.5,
    bevel: 3,
    sheen: 0.08,
    rim: 0.4,
    radius: 20,
  },
  sculpted: {
    material: "matte",
    opacity: 0.94,
    blur: 0,
    tint: 0.04,
    lift: 14,
    shadow: 0.6,
    bevel: 7,
    sheen: 0.15,
    rim: 0.6,
    radius: 24,
  },
} satisfies Record<string, NonNullable<DialKitValueUpdates<typeof SURFACE_CONFIG>["workPane"]>>;

export type SurfaceStyle = CSSProperties & Record<`--${string}`, string | number>;
const percent = (value: number) => `${Number((value * 100).toFixed(4))}%`;
const shadowRecipe = (lift: number, strength: number) =>
  lift === 0 || strength === 0
    ? "none"
    : `0 0 ${Math.max(4, lift * 1.2)}px -4px color-mix(in srgb, var(--scrim) 55%, transparent)`;

/** Scoped, including on portals. Never paints the document or touches the theme store. */
export function surfaceStyle(
  values: SurfaceValues,
  canvas: Canvas,
  resolved: ResolvedAppearance,
  filterId: string,
): SurfaceStyle {
  const { tokens, canvasTokens } = deriveCanvasPaint(canvas, resolved);
  const pools = effectiveStopHexes(canvas, resolved);
  const highlight = resolved === "light" ? tokens["--card"] : tokens["--foreground"];
  return {
    ...tokens,
    ...canvasTokens,
    colorScheme: resolved,
    "--surface-highlight": highlight,
    "--surface-key": pools[0],
    "--surface-return": pools[pools.length - 1],
    "--surface-opacity": percent(values.lens.opacity),
    "--surface-tint": percent(values.lens.tint),
    "--surface-rim": percent(values.lighting.rim),
    "--surface-thickness": `${values.lighting.thickness}px`,
    "--surface-angle": `${values.lighting.angle}deg`,
    "--surface-radius": `${values.lens.radius}px`,
    "--surface-bevel": `${values.lens.bevel}px`,
    "--surface-sheen": percent(values.lens.sheen),
    "--work-opacity": percent(values.workPane.opacity),
    "--work-bevel": `${values.workPane.bevel}px`,
    "--work-sheen": percent(values.workPane.sheen),
    "--work-radius": `${values.workPane.radius}px`,
    "--work-shadow": shadowRecipe(values.workPane.lift, values.workPane.shadow),
    "--work-shadow-blur": `${values.workPane.lift * 0.7}px`,
    "--surface-shadow-blur": `${values.lens.lift * 0.7}px`,
    "--work-backdrop": values.workPane.blur === 0 ? "none" : `blur(${values.workPane.blur}px)`,
    "--surface-colour": percent(values.controls.colour),
    "--surface-crown": percent(values.controls.crown),
    "--surface-contact": values.controls.crown === 0 ? "none" : "var(--shadow-raised)",
    "--surface-shadow": shadowRecipe(values.lens.lift, values.lens.shadow),
    "--reference-saturation": `${Number((1.2 - 0.18 * values.reference.balance).toFixed(4))}`,
    "--surface-backdrop":
      values.lens.blur === 0 && values.opticalExperiment.displacement === 0
        ? "none"
        : `blur(${values.lens.blur}px)${values.opticalExperiment.displacement > 0 ? ` url(#${filterId})` : ""}`,
  };
}

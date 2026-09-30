import {
  GrainGradientShapes,
  getShaderNoiseTexture,
  grainGradientFragmentShader,
} from "@paper-design/shaders";

import type { WorldShaderPalette } from "../data/worlds";
import type { EngineOptions, WorldEngine } from "./worldShaderEngine";
import { mix, mountPaper, NIGHT, rgba, SIZING, type Rgba } from "./worldShaderPaper";

/**
 * GrainGradient, "corners": colour gathers into the frame's corners through a
 * grainy, sand-like ramp — the most textural of the three, and the least like
 * the app.
 */
function grainUniforms(palette: WorldShaderPalette, noise: HTMLImageElement) {
  const light = palette.light;
  const colors: Rgba[] = [
    rgba(palette.canvas[0]!.hex),
    mix(light[0]!.hex, palette.base, 0.35),
    mix((light[1] ?? light[0])!.hex, palette.base, 0.45),
  ];
  return {
    u_colorBack: mix(palette.base, NIGHT, 0.5),
    u_colors: colors,
    u_colorsCount: colors.length,
    u_softness: 0.9,
    u_intensity: 0.3,
    u_noise: 0.18,
    u_shape: GrainGradientShapes.corners,
    u_noiseTexture: noise,
    ...SIZING,
    u_scale: 1,
  };
}

/** Tuned so the corners breathe over a minute and a half. */
const PACE = 0.12;

export async function mountGrain(
  host: HTMLElement,
  palette: WorldShaderPalette,
  options: EngineOptions,
): Promise<WorldEngine | null> {
  const noise = getShaderNoiseTexture();
  if (!noise) return null;
  await noise.decode();
  return mountPaper(host, grainGradientFragmentShader, grainUniforms(palette, noise), PACE, options);
}

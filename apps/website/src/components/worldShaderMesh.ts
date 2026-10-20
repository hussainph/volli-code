import { meshGradientFragmentShader } from "@paper-design/shaders";

import type { WorldShaderPalette } from "../data/worlds";
import type { EngineOptions, WorldEngine } from "./worldShaderEngine";
import { mix, mountPaper, NIGHT, rgba, SIZING, type Rgba } from "./worldShaderPaper";

/**
 * MeshGradient: every colour is a spot on its own trajectory, weighted by
 * distance. The world's light (tempered toward the base so white type holds)
 * alternates with the canvas's deep tones and the night, so the panel stays
 * mostly dark with the pools wandering through it.
 */
function meshUniforms(palette: WorldShaderPalette) {
  const colors: Rgba[] = [rgba(palette.base)];
  palette.light.forEach((pool, index) => {
    const deep = palette.canvas[palette.canvas.length - 1 - index] ?? palette.canvas[0]!;
    colors.push(mix(pool.hex, palette.base, pool.primary ? 0.3 : 0.42));
    colors.push(rgba(deep.hex));
    colors.push(mix(palette.base, NIGHT, 0.55));
  });
  return {
    u_colors: colors.slice(0, 10),
    u_colorsCount: Math.min(colors.length, 10),
    u_distortion: 0.5,
    u_swirl: 0.12,
    u_grainMixer: 0.08,
    u_grainOverlay: 0.1,
    ...SIZING,
    u_scale: 0.85,
  };
}

/** Tuned so a spot takes a couple of minutes to cross the frame. */
const PACE = 0.06;

export function mountMesh(
  host: HTMLElement,
  palette: WorldShaderPalette,
  options: EngineOptions,
): WorldEngine | null {
  return mountPaper(host, meshGradientFragmentShader, meshUniforms(palette), PACE, options);
}

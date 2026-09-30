/**
 * The Paper Shaders engines (https://shaders.paper.design, Apache-2.0,
 * © Lost Coast Labs / Paper): MeshGradient and GrainGradient, driven through
 * the vanilla `ShaderMount` so `WorldShader` owns the lifecycle — when to
 * mount, when to pause, when to hand the GPU context back.
 *
 * Loaded with a dynamic import (via `worldShaderMesh.ts` / `worldShaderGrain.ts`),
 * so a page that only uses the hand-written `glsl` variant never downloads it,
 * and the mesh never pays for the grain's noise texture.
 */
import { ShaderFitOptions, ShaderMount, type ShaderMountUniforms } from "@paper-design/shaders";

import type { EngineOptions, WorldEngine } from "./worldShaderEngine";

export type Rgba = [number, number, number, number];

export function rgba(hex: string, alpha = 1): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

/** `a` pulled toward `b` by `k` (0 = a, 1 = b), in sRGB like a CSS mix. */
export function mix(a: string, b: string, k: number, alpha = 1): Rgba {
  const [ar, ag, ab] = rgba(a);
  const [br, bg, bb] = rgba(b);
  return [ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k, alpha];
}

export const NIGHT = "#050507";

export const SIZING = {
  u_fit: ShaderFitOptions.cover,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
};

/** Mounts one Paper fragment shader; `pace` is the variant's tuned speed. */
export function mountPaper(
  host: HTMLElement,
  fragment: string,
  uniforms: ShaderMountUniforms,
  pace: number,
  options: EngineOptions,
): WorldEngine | null {
  const speed = pace * options.speed;
  const pixelBudget = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr);
    return Math.max(1, host.clientWidth * host.clientHeight * dpr * dpr);
  };

  let mount: ShaderMount;
  try {
    mount = new ShaderMount(
      host,
      fragment,
      uniforms,
      { alpha: true, antialias: false, powerPreference: "low-power" },
      0,
      options.frame,
      // Render at device pixels, never the library's 2× supersample: the
      // budget below is what caps the ratio.
      1,
      pixelBudget(),
    );
  } catch {
    host.querySelector(":scope > canvas")?.remove();
    return null;
  }
  const canvas = mount.canvasElement;
  canvas.classList.add("world-shader-canvas");

  const onLost = (event: Event) => {
    event.preventDefault();
    options.onLost();
  };
  canvas.addEventListener("webglcontextlost", onLost);

  const resize = new ResizeObserver(() => mount.setMaxPixelCount(pixelBudget()));
  resize.observe(host);

  // ShaderMount draws its first frame from its own ResizeObserver; wait until
  // the canvas has a size, then one frame for it to be composited.
  let disposed = false;
  let tries = 0;
  const waitForFrame = () => {
    if (disposed) return;
    if (canvas.width > 0 && canvas.height > 0) {
      requestAnimationFrame(() => !disposed && options.onReady());
    } else if (tries++ < 120) {
      requestAnimationFrame(waitForFrame);
    }
  };
  requestAnimationFrame(waitForFrame);

  return {
    setPlaying(on) {
      mount.setSpeed(on ? speed : 0);
    },
    frame: () => mount.getCurrentFrame(),
    dispose() {
      disposed = true;
      resize.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      const gl = canvas.getContext("webgl2");
      mount.dispose();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      host.removeAttribute("data-paper-shader");
    },
  };
}

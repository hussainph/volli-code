/**
 * The opt-in living light behind a World (`<World shader="…">`).
 *
 * The static, build-time paint of the world is always underneath and always
 * first: this island adds a canvas over it, and only fades that canvas in once
 * a real frame is on screen. Everything that can go wrong — no WebGL, a shader
 * that will not compile, a context the GPU takes back — ends in the canvas
 * never appearing, which is the static world, which is fine.
 *
 * Cost control, in order of how much it saves:
 *   - a world far from the viewport holds no GPU context at all (browsers cap
 *     live WebGL contexts at ~16 a page, and the site has more worlds);
 *   - a mounted world only ticks while it is actually on screen and the tab is
 *     visible;
 *   - the backing canvas is capped at 1.5 device pixels per CSS pixel;
 *   - under `prefers-reduced-motion: reduce` it paints one still frame.
 *
 * Variants: `glsl` is a hand-written shader with no dependency that paints the
 * static world exactly and then lets it drift; `mesh` and `grain` are Paper
 * Shaders' MeshGradient and GrainGradient, loaded on demand.
 */
import { useEffect, useRef, useState } from "react";

import type { WorldShaderPalette } from "../data/worlds";
import type { WorldEngine, WorldShaderVariant } from "./worldShaderEngine";
import "./WorldShader.css";

export type { WorldShaderVariant };

interface Props {
  palette: WorldShaderPalette;
  variant?: WorldShaderVariant;
  /** Multiplies the variant's tuned pace. */
  speed?: number;
}

const MAX_DPR = 1.5;
/** How far outside the viewport a world keeps its GPU context. */
const NEAR_MARGIN = "60% 0px";

let webgl1: boolean | undefined;
let webgl2: boolean | undefined;

function supports(version: 1 | 2): boolean {
  const cached = version === 1 ? webgl1 : webgl2;
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const gl = document
      .createElement("canvas")
      .getContext(version === 1 ? "webgl" : "webgl2", { failIfMajorPerformanceCaveat: true });
    ok = gl !== null;
    (gl as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    ok = false;
  }
  if (version === 1) webgl1 = ok;
  else webgl2 = ok;
  return ok;
}

export default function WorldShader({ palette, variant = "glsl", speed = 1 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const world = host?.closest<HTMLElement>(".world") ?? host?.parentElement;
    if (!host || !world) return;
    if (!supports(variant === "glsl" ? 1 : 2)) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let engine: WorldEngine | null = null;
    let pending = false;
    let frame = 0;
    let near = false;
    let visible = false;
    let failed = false;
    let generation = 0;

    const playing = () => visible && !document.hidden && !motion.matches;
    const sync = () => engine?.setPlaying(playing());

    const show = (on: boolean) => {
      setReady(on);
      world.toggleAttribute("data-shader-ready", on);
    };

    const unmount = () => {
      generation++;
      if (engine) {
        frame = engine.frame();
        engine.dispose();
        engine = null;
      }
      show(false);
    };

    const mount = async () => {
      if (engine || pending || failed) return;
      pending = true;
      const mine = ++generation;
      const options = {
        speed: motion.matches ? 0 : speed,
        frame,
        maxDpr: MAX_DPR,
        onReady: () => mine === generation && show(true),
        onLost: () => {
          failed = true;
          unmount();
        },
      };
      let next: WorldEngine | null = null;
      try {
        if (variant === "glsl") {
          const { mountGl } = await import("./worldShaderGl");
          next = mine === generation ? mountGl(host, palette, options) : null;
        } else if (variant === "mesh") {
          const { mountMesh } = await import("./worldShaderMesh");
          next = mine === generation ? mountMesh(host, palette, options) : null;
        } else {
          const { mountGrain } = await import("./worldShaderGrain");
          next = mine === generation ? await mountGrain(host, palette, options) : null;
        }
      } catch {
        next = null;
      }
      pending = false;
      if (mine !== generation || !near) {
        next?.dispose();
        // Scrolled away and back while this mount was in flight.
        if (near && mine !== generation) void mount();
        return;
      }
      if (!next) {
        failed = true;
        return;
      }
      engine = next;
      sync();
    };

    const nearObserver = new IntersectionObserver(
      ([entry]) => {
        near = entry?.isIntersecting ?? false;
        if (near) void mount();
        else unmount();
      },
      { rootMargin: NEAR_MARGIN },
    );
    const visibleObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    nearObserver.observe(world);
    visibleObserver.observe(world);

    const onMotion = () => {
      // The pace is fixed at mount; a preference change remounts at the new one.
      unmount();
      if (near) void mount();
    };
    document.addEventListener("visibilitychange", sync);
    motion.addEventListener("change", onMotion);

    return () => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion.removeEventListener("change", onMotion);
      unmount();
    };
  }, [palette, variant, speed]);

  return (
    <div
      ref={hostRef}
      className="world-shader"
      data-variant={variant}
      data-ready={ready ? "" : undefined}
      aria-hidden="true"
    />
  );
}

/**
 * The dependency-free world shader: one hand-written WebGL 1 fragment shader
 * that paints a world exactly the way the static page does — the app canvas
 * (base fill + its pools, as `canvasBackground` draws them), the world's own
 * light pools over it, and the canvas grain — and then lets every pool drift on
 * its own slow orbit.
 *
 * At time zero it is the static world, so fading it in over the build-time
 * paint changes the motion, not the picture. Interpolation happens in sRGB
 * like a CSS gradient does, for the same reason.
 */
import type { WorldShaderPalette } from "../data/worlds";
import type { EngineOptions, WorldEngine } from "./worldShaderEngine";

const MAX_POOLS = 3;

/*
 * Geometry mirrored from the static world in site.css: the canvas layer is
 * inset -12% (so its percentages are of a 1.24× box), the light pools inset
 * -18% (a 1.36× box) and drawn as `ellipse 48% 44%` fading out at 70%.
 */
const FRAGMENT = /* glsl */ `
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform float u_dpr;
uniform vec3 u_base;
uniform float u_grain;

uniform int u_cCount;
uniform vec3 u_cCol[${MAX_POOLS}];
uniform vec4 u_cGeo[${MAX_POOLS}];   // x, y, rx, ry (fractions of the canvas box)
uniform float u_cFade[${MAX_POOLS}];

uniform int u_lCount;
uniform vec3 u_lCol[${MAX_POOLS}];
uniform vec3 u_lGeo[${MAX_POOLS}];   // x, y, alpha

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// A slow, closed orbit per pool: two incommensurate sines, so the path never
// visibly repeats, at periods of roughly a minute.
vec2 orbit(float i, float t, float amp) {
  float a = 0.105 + 0.023 * i;
  float b = 0.083 + 0.017 * i;
  float p = i * 2.399;
  return amp * vec2(sin(t * a + p) - sin(p), cos(t * b + p * 1.3) - cos(p * 1.3));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = vec2(frag.x, u_res.y - frag.y) / u_res;
  float t = u_time;

  // A breath of fluid warp, so the light bends as it drifts rather than
  // sliding as rigid ellipses.
  vec2 w = uv + 0.018 * vec2(
    sin(uv.y * 3.1 + t * 0.21) - sin(uv.y * 3.1),
    cos(uv.x * 2.7 - t * 0.17) - cos(uv.x * 2.7)
  );

  vec3 col = u_base;

  vec2 cuv = (w + 0.12) / 1.24;
  for (int i = 0; i < ${MAX_POOLS}; i++) {
    if (i >= u_cCount) break;
    float fi = float(i);
    vec4 g = u_cGeo[i];
    vec2 c = g.xy + orbit(fi, t, 0.05);
    float breathe = 1.0 + 0.05 * sin(t * (0.07 + 0.013 * fi) + fi);
    float r = length((cuv - c) / (g.zw * breathe));
    float a = clamp(1.0 - r / u_cFade[i], 0.0, 1.0);
    col = mix(col, u_cCol[i], a);
  }

  vec2 luv = (w + 0.18) / 1.36;
  for (int i = 0; i < ${MAX_POOLS}; i++) {
    if (i >= u_lCount) break;
    float fi = float(i) + 3.0;
    vec3 g = u_lGeo[i];
    vec2 c = g.xy + orbit(fi, t, 0.07);
    float r = length((luv - c) / vec2(0.48, 0.44));
    float a = clamp(1.0 - r / 0.7, 0.0, 1.0) * g.z;
    col = mix(col, u_lCol[i], a);
  }

  // The canvas grain: black specks, one per CSS pixel, still while the light
  // moves (animated grain reads as noise, not texture).
  float n = hash(floor(frag / u_dpr));
  col *= 1.0 - u_grain * n;

  gl_FragColor = vec4(col, 1.0);
}
`;

const VERTEX = /* glsl */ `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Time runs in seconds of world time; `speed` 1 is the tuned calm pace. */
export function mountGl(
  host: HTMLElement,
  palette: WorldShaderPalette,
  options: EngineOptions,
): WorldEngine | null {
  const canvas = document.createElement("canvas");
  canvas.className = "world-shader-canvas";
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u("u_res");
  const uTime = u("u_time");
  const uDpr = u("u_dpr");

  const pools = palette.canvas.slice(0, MAX_POOLS);
  const lights = palette.light.slice(0, MAX_POOLS);
  gl.uniform3fv(u("u_base"), rgb(palette.base));
  // The static grain: `grain × alphaScale` of black, on turbulence whose
  // luminance averages about a half.
  gl.uniform1f(u("u_grain"), palette.grain * 0.55 * 0.9);
  gl.uniform1i(u("u_cCount"), pools.length);
  gl.uniform3fv(u("u_cCol"), pools.flatMap((p) => rgb(p.hex)));
  gl.uniform4fv(
    u("u_cGeo"),
    pools.flatMap((p) => [p.x, p.y, p.rx, p.ry]),
  );
  gl.uniform1fv(
    u("u_cFade"),
    pools.map((p) => p.fade),
  );
  gl.uniform1i(u("u_lCount"), lights.length);
  gl.uniform3fv(u("u_lCol"), lights.flatMap((p) => rgb(p.hex)));
  gl.uniform3fv(
    u("u_lGeo"),
    lights.flatMap((p) => [p.x, p.y, p.primary ? 0.62 : 0.46]),
  );

  host.append(canvas);

  let time = options.frame / 1000;
  let playing = false;
  let raf = 0;
  let last = 0;
  let ready = false;
  let disposed = false;
  let dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr);

  const draw = () => {
    gl.uniform1f(uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!ready) {
      ready = true;
      // The frame is queued, not yet composited; one more frame and it is.
      requestAnimationFrame(() => !disposed && options.onReady());
    }
  };

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr);
    const width = Math.max(1, Math.round(host.clientWidth * dpr));
    const height = Math.max(1, Math.round(host.clientHeight * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(uRes, width, height);
    gl.uniform1f(uDpr, dpr);
    draw();
  };

  // The motion is a minute-long drift; 30 frames a second is indistinguishable
  // from 60 at that pace and halves the GPU time.
  const FRAME_MS = 1000 / 30;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (last === 0) last = now;
    const dt = now - last;
    if (dt < FRAME_MS - 2) return;
    last = now;
    time += (Math.min(dt, 100) / 1000) * options.speed;
    draw();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const onLost = (event: Event) => {
    event.preventDefault();
    options.onLost();
  };
  canvas.addEventListener("webglcontextlost", onLost);

  return {
    setPlaying(on) {
      const next = on && options.speed > 0;
      if (next === playing) return;
      playing = next;
      if (playing) {
        last = 0;
        raf = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(raf);
      }
    },
    frame: () => time * 1000,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

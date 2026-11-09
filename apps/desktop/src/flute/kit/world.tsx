/**
 * The film's world (VC-464): which app theme a shot wears, and the living
 * backdrop it floats in.
 *
 * Themes are real Volli canvases — the same `{stops, vibrancy, grain}` the
 * Settings → Appearance editor authors — painted with the app's own
 * `paintCanvas`, so every surface, ink tier and accent in frame is what that
 * theme actually looks like. Each chapter of the film wears a different one:
 * the themes are shown passively, never announced.
 *
 * The backdrop is that same canvas at world scale: the app's `--canvas`
 * gradient (grain included) drifting slowly behind the window, a bloom of the
 * theme's own primary behind the subject, and the working-ring motif rippling
 * out from it. It is driven from scene time like everything else.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { DEFAULT_CANVAS, type Canvas, type ResolvedAppearance } from "@volli/shared";

import { paintCanvas } from "@renderer/theme/canvas-paint";

import { ease, progress } from "./clock";
import { useCaptureViewport } from "./film";

export interface FilmTheme {
  canvas: Canvas;
  mode: ResolvedAppearance;
}

const canvas = (
  stops: Canvas["stops"],
  vibrancy: number,
  grain = 0.16,
  primaryIndex = 0,
): Canvas => ({ stops, primaryIndex, vibrancy, grain });

/**
 * The film's palette of app themes. Hexes are what a user would pick; the
 * canvas pipeline pulls each into the mode's band exactly as it does in-app.
 */
export const THEMES = {
  /** The shipped default: one ember pool, high right. The end card's. */
  ember: { canvas: DEFAULT_CANVAS, mode: "dark" },
  /** Violet over teal — the hook. */
  aurora: {
    canvas: canvas(
      [
        { hex: "#7b5cff", x: 0.72, y: 0.22 },
        { hex: "#19c3b4", x: 0.18, y: 0.82 },
      ],
      0.85,
    ),
    mode: "dark",
  },
  /** Deep teal — automations. */
  lagoon: {
    canvas: canvas(
      [
        { hex: "#12b5a0", x: 0.25, y: 0.2 },
        { hex: "#2f6bff", x: 0.85, y: 0.85 },
      ],
      0.8,
    ),
    mode: "dark",
  },
  /** Electric blue — agents. */
  cobalt: {
    canvas: canvas(
      [
        { hex: "#3d6bff", x: 0.7, y: 0.25 },
        { hex: "#b04dff", x: 0.15, y: 0.75 },
        { hex: "#00c2ff", x: 0.9, y: 0.95 },
      ],
      0.85,
    ),
    mode: "dark",
  },
  /** Rose and plum — multitasking. */
  rose: {
    canvas: canvas(
      [
        { hex: "#ff4f8b", x: 0.2, y: 0.25 },
        { hex: "#7a3cff", x: 0.85, y: 0.8 },
      ],
      0.8,
    ),
    mode: "dark",
  },
  /** Lavender daylight — context switching, the one light-mode chapter. */
  paper: {
    canvas: canvas(
      [
        { hex: "#8f7cff", x: 0.75, y: 0.2 },
        { hex: "#ff9a6b", x: 0.2, y: 0.85 },
      ],
      0.7,
      0.12,
    ),
    mode: "light",
  },
  /** Acid lime — a montage hit. */
  lime: {
    canvas: canvas([{ hex: "#9be13c", x: 0.3, y: 0.25 }], 0.75),
    mode: "dark",
  },
  /** Gold — a montage hit. */
  gold: {
    canvas: canvas(
      [
        { hex: "#ffb31a", x: 0.7, y: 0.2 },
        { hex: "#ff5a3c", x: 0.2, y: 0.9 },
      ],
      0.75,
    ),
    mode: "dark",
  },
} satisfies Record<string, FilmTheme>;

export type ThemeKey = keyof typeof THEMES;

/**
 * Paints `THEMES[key]` onto the document, once, during render — before any
 * child reads a token — and again if the key changes. Every surface in the
 * scene resolves its colours from the result.
 */
export function useFilmTheme(key: ThemeKey): void {
  const painted = React.useRef<ThemeKey | null>(null);
  if (painted.current !== key && typeof document !== "undefined") {
    painted.current = key;
    const theme: FilmTheme = THEMES[key];
    paintCanvas(theme.canvas, theme.mode);
  }
}

/**
 * The world behind the window: the theme's canvas at world scale, drifting;
 * a bloom of the primary behind the subject; rings rippling outward.
 *
 * `focus` is where the bloom and rings centre, as fractions of the frame.
 * Portaled into the capture viewport *before* Flute's stage, so the stage
 * paints over it.
 */
const CENTRE: readonly [number, number] = [0.5, 0.5];

export function Backdrop({
  t,
  theme,
  focus = CENTRE,
  rings = true,
  bloom = 1,
}: {
  t: number;
  /** The shot's theme: its stops become the aurora's light pools. */
  theme: ThemeKey;
  focus?: readonly [number, number];
  rings?: boolean;
  bloom?: number;
}) {
  const viewport = useCaptureViewport();
  const [host] = React.useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  React.useLayoutEffect(() => {
    if (viewport === null || host === null) return;
    host.className = "film-backdrop";
    viewport.prepend(host);
    return () => host.remove();
  }, [viewport, host]);
  if (viewport === null || host === null) return null;

  // Slow, never-repeating-looking drift: incommensurate periods.
  const s = t / 1000;
  const dx = Math.sin(s * 0.37) * 2.2 + Math.sin(s * 0.13) * 1.4;
  const dy = Math.cos(s * 0.29) * 1.8;
  const turn = Math.sin(s * 0.21) * 2.5;
  const zoom = 1.18 + Math.sin(s * 0.17) * 0.03;
  const [fx, fy] = focus;

  return createPortal(
    <>
      <div
        className="film-backdrop-canvas"
        style={{
          transform: `translate(${dx}%, ${dy}%) rotate(${turn}deg) scale(${zoom})`,
        }}
      />
      <Aurora t={t} theme={theme} />
      <div
        className="film-backdrop-bloom"
        style={{
          opacity: bloom,
          background: `radial-gradient(ellipse 48% 42% at ${fx * 100}% ${fy * 100}%, color-mix(in oklab, var(--ring) 55%, transparent), transparent 70%)`,
        }}
      />
      {rings ? <Rings t={t} focus={focus} /> : null}
    </>,
    host,
  );
}

/**
 * The theme's own stops as light: each authored hex, unpulled by the mode
 * transform, as a large soft pool drifting on its own slow orbit. Two
 * complements join a one-stop theme so the world never reads as a flat wash.
 */
function Aurora({ t, theme }: { t: number; theme: ThemeKey }) {
  const { canvas: authored, mode } = THEMES[theme] as FilmTheme;
  const s = t / 1000;
  const pools =
    authored.stops.length > 1
      ? authored.stops
      : [
          ...authored.stops,
          { ...authored.stops[0]!, x: 1 - authored.stops[0]!.x, y: 1 - authored.stops[0]!.y },
        ];
  return (
    <div className="film-backdrop-aurora" data-mode={mode}>
      {pools.map((stop, index) => {
        const phase = index * 2.1;
        const x = stop.x * 100 + Math.sin(s * 0.23 + phase) * 9;
        const y = stop.y * 100 + Math.cos(s * 0.19 + phase) * 7;
        const size = 46 + Math.sin(s * 0.31 + phase) * 6;
        return (
          <div
            key={`${stop.hex}-${stop.x}-${stop.y}`}
            className="film-backdrop-pool"
            style={{
              background: `radial-gradient(ellipse ${size}% ${size * 0.9}% at ${x}% ${y}%, ${stop.hex}, transparent 70%)`,
              opacity: index === authored.primaryIndex ? 0.62 : 0.46,
            }}
          />
        );
      })}
    </div>
  );
}

const RING_PERIOD = 5200;
const RING_COUNT = 4;

/** The working-ring motif, at world scale: thin rings rippling outward. */
function Rings({ t, focus }: { t: number; focus: readonly [number, number] }) {
  return (
    <div
      className="film-backdrop-rings"
      style={{ left: `${focus[0] * 100}%`, top: `${focus[1] * 100}%` }}
    >
      {Array.from({ length: RING_COUNT }, (_, index) => {
        const phase =
          (((t + (index * RING_PERIOD) / RING_COUNT) % RING_PERIOD) + RING_PERIOD) % RING_PERIOD;
        const p = phase / RING_PERIOD;
        const grow = ease.outCubic(p);
        const fade = progress(p, 0, 0.15, ease.linear) * (1 - progress(p, 0.45, 1, ease.inCubic));
        return (
          <div
            key={index}
            className="film-backdrop-ring"
            style={{
              transform: `translate(-50%, -50%) scale(${0.35 + grow * 1.9})`,
              opacity: 0.55 * fade,
            }}
          />
        );
      })}
    </div>
  );
}

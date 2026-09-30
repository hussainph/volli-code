/**
 * The release film's shared frame (VC-464): the scene clock, the pinning that
 * makes real components' own CSS motion obey it, the one-time fixture setup a
 * lab scratch would have done, and the supers layer.
 *
 * Determinism is the whole job. `flute export` and `scripts/film/capture.mjs`
 * seek the scene clock frame by frame; anything that moves on the wall clock
 * lands somewhere different in every render. Three rules follow:
 *
 *   1. UI state is a pure function of `useFilm()`'s time — no timers.
 *   2. The components' OWN transitions and keyframes (the Session cursor's
 *      glide, a press ring, a status ring's spin) are kept, not disabled: every
 *      `Animation` in the document is paused and its `currentTime` set from the
 *      scene clock, measured from the scene time it first appeared at. The
 *      motion on screen is the component's real curve, played by our clock.
 *   3. The capture script waits for `data-film-time` to name the frame it
 *      asked for before it takes the picture.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { useSceneTime } from "@webprodigies/flute";
import { frameData, MotionGlobalConfig } from "motion/react";

import { installFakeApi, type ApiOverrides } from "../../renderer/lab/fake-api";
import { ease, progress } from "./clock";
import "./film.css";

export type Format = "landscape" | "portrait";

export const FORMAT_SIZE: Record<Format, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
};

const firstSeen = new WeakMap<Animation, number>();

/**
 * The scene clock, with every document animation pinned to it. Call once per
 * shot, from the component that owns the shot.
 */
export function useFilm(): number {
  const t = useSceneTime();
  // Components animated with `motion` (the Activity Island's springs, the
  // board's drag overlay) run on motion's own frame loop. Manual timing makes
  // that loop read `frameData.timestamp` instead of `performance.now()`, so
  // their springs advance on the scene clock too. Set during render, before
  // the children commit, so an animation a child starts this frame starts at
  // this frame's time.
  MotionGlobalConfig.useManualTiming = true;
  frameData.timestamp = t;
  React.useLayoutEffect(() => {
    for (const animation of document.getAnimations()) {
      let start = firstSeen.get(animation);
      if (start === undefined || start > t) {
        // Inside `[data-film-settled]` a shot opens on something that was
        // already on screen before its first frame: its entrance is long over.
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const settled = target instanceof Element && target.closest("[data-film-settled]") !== null;
        start = settled ? t - 60_000 : t;
        firstSeen.set(animation, start);
      }
      animation.pause();
      animation.currentTime = t - start;
    }
    document.documentElement.dataset.filmTime = String(t);
  });
  return t;
}

/**
 * Pins `Date.now()` to the scene clock while the calling shot is mounted, for
 * real components that keep their own wall-clock loop (the armed countdown's
 * `useFrameClock`). Without it the loop keeps reading real time while the
 * capture waits on a frame, and a window seeded "1.8 s left" reads 0 s.
 * `epoch` is what Date.now() returns at scene time 0.
 */
let filmNow: number | null = null;
const realDateNow = Date.now.bind(Date);
const pinnedDateNow = () => filmNow ?? realDateNow();
export function useFilmWallClock(t: number, epoch: number): void {
  filmNow = epoch + t;
  // Installed during render, before any child's first render reads the clock
  // (a `useState(() => Date.now())` would otherwise start on real time).
  Date.now = pinnedDateNow;
  React.useLayoutEffect(() => {
    // Again on (re)mount: StrictMode's mount → unmount → mount runs the
    // cleanup below between the two, and effects declared after this one in
    // the same shot must still read the pinned clock.
    Date.now = pinnedDateNow;
    return () => {
      Date.now = realDateNow;
    };
  }, []);
}

/**
 * Installs a scratch's bridge stubs and store seed once, during render, for
 * the same reason the lab shell does: effects run after children mount, and a
 * component that reads a store in its first render must find the fixture.
 */
export function useFixtures(setup: { api?: ApiOverrides; seed?: () => void }): void {
  const done = React.useRef(false);
  if (!done.current) {
    done.current = true;
    installFakeApi(setup.api ?? {});
    setup.seed?.();
  }
}

/** The capture viewport Flute's ScenePreview renders into, once it exists. */
export function useCaptureViewport(): HTMLElement | null {
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  // Flute mounts the viewport around the scene, so it may not exist on this
  // component's first commit: look again each frame until it does.
  React.useLayoutEffect(() => {
    if (element?.isConnected) return;
    let frame = 0;
    const find = () => {
      const found = document.querySelector<HTMLElement>('[data-flute-capture="scene"]');
      if (found === null) frame = requestAnimationFrame(find);
      else setElement(found);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [element]);
  return element;
}

/**
 * Anything that belongs to the frame rather than to the world: supers, the
 * grade. Portaled into the capture viewport above the scene, laid out in the
 * format's own pixels and scaled the way ScenePreview scales the scene.
 */
export function FrameLayer({ format, children }: { format: Format; children: React.ReactNode }) {
  const viewport = useCaptureViewport();
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    if (viewport === null) return;
    const size = FORMAT_SIZE[format];
    const measure = () =>
      setScale(
        Math.max(viewport.clientWidth / size.width, viewport.clientHeight / size.height) || 1,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport, format]);
  if (viewport === null) return null;
  const size = FORMAT_SIZE[format];
  return createPortal(
    <div className="film-frame" aria-hidden>
      <div
        className="film-frame-inner"
        style={{
          width: size.width,
          height: size.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>,
    viewport,
  );
}

// ---- supers -------------------------------------------------------------------

export interface Cue {
  /** Scene ms the super starts arriving, and starts leaving. */
  at: number;
  until: number;
  /** Mono line above the super: the tickets that shipped the claim. */
  eyebrow?: string;
  /** Display lines, each revealed from its own mask. */
  lines: string[];
  /** Quieter line under the display lines. */
  sub?: string;
  /** A word in `lines` drawn in the accent colour (the theme's ring by default). */
  accent?: string;
  /**
   * Mona Sans weight each line lands at (default 780). Lines arrive light and
   * wide and settle into this, so a heavy line against a light one reads as
   * emphasis rather than as two sizes of the same thing.
   */
  weights?: number[];
  accentColor?: string;
  size?: "hero" | "large" | "medium";
  place?: "lower" | "upper" | "center" | "lower-right";
}

const SIZES: Record<Format, Record<NonNullable<Cue["size"]>, number>> = {
  landscape: { hero: 184, large: 116, medium: 96 },
  portrait: { hero: 150, large: 100, medium: 84 },
};

function Line({
  text,
  accent,
  accentColor,
}: {
  text: string;
  accent?: string;
  accentColor?: string;
}) {
  if (accent === undefined || !text.includes(accent)) return <>{text}</>;
  const [before, after] = [
    text.slice(0, text.indexOf(accent)),
    text.slice(text.indexOf(accent) + accent.length),
  ];
  return (
    <>
      {before}
      <span style={{ color: accentColor ?? "var(--ring)" }}>{accent}</span>
      {after}
    </>
  );
}

function Super({ cue, t, format }: { cue: Cue; t: number; format: Format }) {
  if (t < cue.at || t > cue.until + 400) return null;
  const size = SIZES[format][cue.size ?? "large"];
  const out = progress(t, cue.until, cue.until + 320, ease.inCubic);
  const place = cue.place ?? "lower";
  const eyebrowIn = progress(t, cue.at, cue.at + 260, ease.outCubic);
  const eyebrowChars =
    cue.eyebrow === undefined
      ? 0
      : Math.ceil(cue.eyebrow.length * progress(t, cue.at, cue.at + 380, ease.linear));
  const scrim = progress(t, cue.at, cue.at + 500, ease.outCubic) * (1 - out);
  return (
    <>
      <div
        className="film-scrim"
        data-place={place}
        data-format={format}
        style={{ opacity: scrim }}
      />
      <div
        className="film-super"
        data-place={place}
        data-format={format}
        style={{ opacity: 1 - out, transform: `translateY(${-24 * out}px)` }}
      >
        {cue.eyebrow !== undefined ? (
          <div className="film-eyebrow" style={{ opacity: eyebrowIn }}>
            {cue.eyebrow.slice(0, eyebrowChars)}
            <span
              className="film-eyebrow-caret"
              style={{ opacity: eyebrowChars < cue.eyebrow.length ? 1 : 0 }}
            />
          </div>
        ) : null}
        {cue.lines.map((line, index) => {
          const p = progress(t, cue.at + 80 + index * 90, cue.at + 620 + index * 90, ease.outExpo);
          // The weight lands a beat behind the rise: the line arrives thin and
          // wide, then sets hard.
          const w = progress(
            t,
            cue.at + 180 + index * 90,
            cue.at + 760 + index * 90,
            ease.outCubic,
          );
          return (
            <div key={line} className="film-line-mask" style={{ fontSize: size }}>
              <div
                className="film-line"
                style={{
                  transform: `translateY(${(1 - p) * 105}%)`,
                  letterSpacing: `${-0.04 + (1 - w) * 0.02}em`,
                  fontWeight: Math.round(220 + ((cue.weights?.[index] ?? 780) - 220) * w),
                  fontStretch: `${124 - 16 * w}%`,
                }}
              >
                <Line text={line} accent={cue.accent} accentColor={cue.accentColor} />
              </div>
            </div>
          );
        })}
        {cue.sub !== undefined ? (
          <div
            className="film-sub"
            style={{
              fontSize: Math.round(size * 0.54),
              opacity: progress(t, cue.at + 300, cue.at + 700, ease.outCubic),
              transform: `translateY(${(1 - progress(t, cue.at + 300, cue.at + 800, ease.outExpo)) * 18}px)`,
            }}
          >
            {cue.sub}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function Supers({ cues, t, format }: { cues: readonly Cue[]; t: number; format: Format }) {
  return (
    <>
      {cues.map((cue) => (
        <Super key={`${cue.at}-${cue.lines.join("|")}`} cue={cue} t={t} format={format} />
      ))}
    </>
  );
}

/** The grade: a soft vignette so supers and the void read as one frame. */
export function Vignette({ strength = 0.55 }: { strength?: number }) {
  return (
    <div
      className="film-vignette"
      style={{
        background: `radial-gradient(ellipse 75% 70% at 50% 45%, transparent 55%, rgb(0 0 0 / ${strength}) 100%)`,
      }}
    />
  );
}

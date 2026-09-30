/**
 * The end card (VC-464). The film's only brand beat, on the app's shipped
 * default theme (ember). The Volli mark builds itself the way a board fills:
 * three columns run down from the top line and the orange Doing card lands in
 * the middle one, while the working-ring motif ripples out behind it. Then the
 * name, one line that tells a newcomer what Volli is, and where to get it.
 * The camera flies through the mark on the way out, so the loop back to the
 * hook is a cut on motion.
 *
 * The mark is `apps/desktop/build/icon-source.svg`'s "Doing Cursor" glyph,
 * drawn here from the same rects so each part can move on the scene clock.
 */
import { ease, mix, progress } from "../kit/clock";
import { FrameLayer, useFilm, Vignette, type Format } from "../kit/film";
import { Backdrop, useFilmTheme } from "../kit/world";

const CREAM = "#F2EAE0";
const ORANGE = "#E8652A";

/** The glyph's rects, in the icon's 256-unit box; bars hang from y = 42. */
const BARS = [
  { x: 48, height: 172 },
  { x: 108, height: 100 },
  { x: 168, height: 136 },
] as const;
const DOING = { x: 108, y: 158, width: 40, height: 44 };
const TOP = 42;
/** The lockup's box: fixed, so the fly-through origin is known exactly. */
const LOCKUP_WIDTH: Record<Format, number> = { landscape: 1200, portrait: 1000 };

/** Beats (ms). The dive is timed against the rig's (end.mjs): keep in step. */
const BEAT = {
  bars: 120,
  barStagger: 110,
  barMs: 620,
  doing: 620,
  doingMs: 560,
  name: 700,
  nameMs: 620,
  tagline: 980,
  taglineMs: 560,
  out: 1260,
  outMs: 560,
  leave: 3080,
  through: 3140,
  throughMs: 420,
  end: 3600,
};

function Mark({ t, height }: { t: number; height: number }) {
  return (
    <svg
      viewBox="40 34 176 188"
      height={height}
      width={(height * 176) / 188}
      style={{ overflow: "visible" }}
      aria-hidden
    >
      {BARS.map((bar, index) => {
        const grow = progress(
          t,
          BEAT.bars + index * BEAT.barStagger,
          BEAT.bars + index * BEAT.barStagger + BEAT.barMs,
          ease.outExpo,
        );
        const h = bar.height * grow;
        return (
          <rect
            key={bar.x}
            x={bar.x}
            y={TOP}
            width={40}
            height={h}
            rx={18}
            fill={CREAM}
            opacity={progress(
              t,
              BEAT.bars + index * BEAT.barStagger,
              BEAT.bars + index * BEAT.barStagger + 90,
            )}
          />
        );
      })}
      {(() => {
        // The Doing card lands in the middle column: a short drop from inside
        // the column's gap, scaling up from its own centre with an overshoot.
        const land = progress(t, BEAT.doing, BEAT.doing + BEAT.doingMs, ease.outBack);
        const scale = mix(0.3, 1, land);
        const cx = DOING.x + DOING.width / 2;
        const cy =
          mix(
            DOING.y - 18,
            DOING.y,
            progress(t, BEAT.doing, BEAT.doing + BEAT.doingMs, ease.outCubic),
          ) +
          DOING.height / 2;
        return (
          <rect
            x={cx - (DOING.width * scale) / 2}
            y={cy - (DOING.height * scale) / 2}
            width={DOING.width * scale}
            height={DOING.height * scale}
            rx={10 * scale}
            fill={ORANGE}
            opacity={progress(t, BEAT.doing, BEAT.doing + 90)}
          />
        );
      })()}
    </svg>
  );
}

function Lockup({ t, format }: { t: number; format: Format }) {
  const portrait = format === "portrait";
  const settle = progress(t, 0, 1400, ease.outCubic);
  const push = progress(t, 1200, BEAT.leave, ease.linear);
  // Flying through: the camera passes the mark's plane through the gap
  // between its first two columns, so the bars sweep out past the edges of
  // frame instead of fading into a grey wash.
  const through = progress(t, BEAT.through, BEAT.through + BEAT.throughMs, ease.inCubic);
  const scale = mix(0.94, 1, settle) + 0.035 * push + 34 * through;
  const markOpacity =
    1 - progress(t, BEAT.through + BEAT.throughMs * 0.8, BEAT.through + BEAT.throughMs);
  const markHeight = portrait ? 380 : 330;
  // The gap between bars 1 and 2 (x 88–108, y ≈ 120 in the glyph's box), in
  // the lockup's own coordinates, measured from its top-left corner.
  const gap = {
    x: 0.5 * LOCKUP_WIDTH[format] - (markHeight * 176) / 188 / 2 + (markHeight * (98 - 40)) / 188,
    y: (markHeight * (120 - 34)) / 188,
  };
  const textOut = progress(t, BEAT.leave, BEAT.leave + 240, ease.outCubic);
  const name = progress(t, BEAT.name, BEAT.name + BEAT.nameMs, ease.outExpo);
  const out = progress(t, BEAT.out, BEAT.out + BEAT.outMs, ease.outCubic);
  const tagline = progress(t, BEAT.tagline, BEAT.tagline + BEAT.taglineMs, ease.outCubic);
  // The name lands thin and wide, then sets hard — the supers' own gesture.
  const weight = progress(t, BEAT.name + 80, BEAT.name + BEAT.nameMs + 120, ease.outCubic);
  if (markOpacity <= 0) return null;
  return (
    <div
      className="film-end"
      data-format={format}
      style={{
        width: LOCKUP_WIDTH[format],
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: `${gap.x}px ${gap.y}px`,
        opacity: markOpacity,
      }}
    >
      <Mark t={t} height={markHeight} />
      <div className="film-end-name-mask" style={{ opacity: 1 - textOut }}>
        <div
          className="film-end-name"
          style={{
            transform: `translateY(${(1 - name) * 105}%)`,
            fontWeight: Math.round(mix(220, 800, weight)),
            fontStretch: `${mix(125, 110, weight)}%`,
          }}
        >
          Volli 0.2
        </div>
      </div>
      <div
        className="film-end-tagline"
        style={{
          opacity: tagline * (1 - textOut),
          transform: `translateY(${(1 - tagline) * 16}px)`,
        }}
      >
        The workspace for parallel coding agents.
      </div>
      <div
        className="film-end-row"
        style={{
          opacity: out * (1 - textOut),
          transform: `translateY(${(1 - out) * 18}px)`,
        }}
      >
        <span className="film-end-out">Download for Mac</span>
        <span className="film-end-dot" />
        <span className="film-end-url">volli.app</span>
      </div>
    </div>
  );
}

export function EndShot({ format }: { format: Format }) {
  useFilmTheme("ember");
  const t = useFilm();
  const portrait = format === "portrait";
  // Rings and bloom centre on the mark, which sits above the lockup's middle.
  const focus: [number, number] = portrait ? [0.5, 0.4] : [0.5, 0.33];
  return (
    <>
      <Backdrop t={t + 1800} theme="ember" focus={focus} />
      <FrameLayer format={format}>
        <Vignette strength={0.5} />
        <Lockup t={t} format={format} />
      </FrameLayer>
    </>
  );
}

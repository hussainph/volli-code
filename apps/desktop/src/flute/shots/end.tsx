/**
 * The end card (VC-464). The wall of 175 hangs far back in the dark, out of
 * focus, every card dimmed but VC-239. In front of it the Volli mark builds
 * itself the way a board fills: three columns run down from the top line and
 * the orange Doing card lands in the middle one. "Volli 0.2", then "Out now"
 * and volli.app. Then the camera dives: through the mark, into the wall, and
 * arrives on VC-239 at exactly the pose and speed the hook opens with, so the
 * film loops without a seam (the rig is scripts/film/shots/end.mjs).
 *
 * The mark is `apps/desktop/build/icon-source.svg`'s "Doing Cursor" glyph,
 * drawn here from the same rects so each part can move on the scene clock.
 */
import { ease, mix, progress } from "../kit/clock";
import { FORMAT_SIZE, FrameLayer, useFilm, Vignette, type Format } from "../kit/film";
import { Wall } from "../kit/wall";

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
  out: 1080,
  outMs: 560,
  leave: 2720,
  through: 2780,
  throughMs: 440,
  wallWake: 2700,
  wallWakeMs: 1000,
  end: 3800,
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
        const grow = progress(t, BEAT.bars + index * BEAT.barStagger, BEAT.bars + index * BEAT.barStagger + BEAT.barMs, ease.outExpo);
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
            opacity={progress(t, BEAT.bars + index * BEAT.barStagger, BEAT.bars + index * BEAT.barStagger + 90)}
          />
        );
      })}
      {(() => {
        // The Doing card lands in the middle column: a short drop from inside
        // the column's gap, scaling up from its own centre with an overshoot.
        const land = progress(t, BEAT.doing, BEAT.doing + BEAT.doingMs, ease.outBack);
        const scale = mix(0.3, 1, land);
        const cx = DOING.x + DOING.width / 2;
        const cy = mix(DOING.y - 18, DOING.y, progress(t, BEAT.doing, BEAT.doing + BEAT.doingMs, ease.outCubic)) + DOING.height / 2;
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
  const markOpacity = 1 - progress(t, BEAT.through + BEAT.throughMs * 0.8, BEAT.through + BEAT.throughMs);
  const markHeight = portrait ? 380 : 330;
  // The gap between bars 1 and 2 (x 88–108, y ≈ 120 in the glyph's box), in
  // the lockup's own coordinates, measured from its top-left corner.
  const gap = { x: 0.5 * LOCKUP_WIDTH[format] - (markHeight * 176) / 188 / 2 + (markHeight * (98 - 40)) / 188, y: (markHeight * (120 - 34)) / 188 };
  const textOut = progress(t, BEAT.leave, BEAT.leave + 240, ease.outCubic);
  const name = progress(t, BEAT.name, BEAT.name + BEAT.nameMs, ease.outExpo);
  const out = progress(t, BEAT.out, BEAT.out + BEAT.outMs, ease.outCubic);
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
          style={{ transform: `translateY(${(1 - name) * 105}%)` }}
        >
          Volli 0.2
        </div>
      </div>
      <div
        className="film-end-row"
        style={{
          opacity: out * (1 - textOut),
          transform: `translateY(${(1 - out) * 18}px)`,
        }}
      >
        <span className="film-end-out">Out now</span>
        <span className="film-end-dot" />
        <span className="film-end-url">volli.app</span>
      </div>
    </div>
  );
}

export function EndShot({ format }: { format: Format }) {
  const t = useFilm();
  const size = FORMAT_SIZE[format];
  // The wall wakes as the camera dives, and is exactly the hook's first frame
  // (dim 0, vignette 0.45) by the last one.
  const wake = progress(t, BEAT.wallWake, BEAT.wallWake + BEAT.wallWakeMs, ease.inOutCubic);
  return (
    <>
      <Wall stageWidth={size.width} stageHeight={size.height} dim={mix(0.8, 0, wake)} />
      <FrameLayer format={format}>
        <Vignette strength={mix(0.7, 0.45, wake)} />
        <Lockup t={t} format={format} />
      </FrameLayer>
    </>
  );
}

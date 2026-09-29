/**
 * Every candidate glyph for the usage-limits button (VC-376), drawn from one
 * shared reading so they can be compared rather than admired one at a time.
 * `CANDIDATES` at the foot of the file is the list the picker walks.
 *
 * THE BOX IS THE ARGUMENT. The old Gauge inherited `size-6` with a
 * `size-3.5` glyph — 24px of target around 14px of drawing. The 14px rung
 * exposed why that box could not carry a figure, and 22px made a centred
 * figure match the ⌘K pill. Neither settled the two-figure stack with a mark:
 * it needs the chosen 26px glyph, with 11-unit medium figures in its 24-unit
 * coordinate space, in a 32px target. The stage and ladder keep the 14px
 * comparison visible so growing the drawing remains an explicit cost.
 *
 * WHAT THE VARIANTS DISAGREE ABOUT is the second channel — the one Apple's
 * combined icon gets from using three different SHAPES for three different
 * kinds of fact. We have one kind of fact (a percentage left) repeated up to
 * six times, so the second channel has to be invented rather than borrowed:
 *
 *   • `Ring`        — no second channel. The control against which every other
 *                     shape here has to justify its extra ink.
 *   • `RingCentre`  — the figure in the middle, `dots` adding Apple's literal
 *                     answer in a notch at the bottom: beads that count either
 *                     the other ACCOUNTS or the lead account's own WINDOWS.
 *   • `RingBeads`   — the same ring and beads with the figure dropped.
 *   • `MarkCentre` / `MarkNotch` — the second channel as an IDENTITY instead of
 *                     a count: the lead account's own mark, in the middle or
 *                     standing where the beads stood. In the earlier 22px
 *                     comparison a bead was 1.6px; a mark was far easier to
 *                     recognise at real size.
 *   • `StackedFigures` — the opposite bet: print BOTH windows as figures, one
 *                     above the other, and demote the ring to the tone and a
 *                     rough amount. Exactness instead of shape, and the one
 *                     variant where the second channel is a second number.
 *   • `SplitRing`   — the ring itself is the second channel: one arc per
 *                     window, cut by gaps. One window fills the circle, three
 *                     make three thirds. Position is by window FAMILY, never
 *                     by value, so a segment means the same thing tomorrow.
 *   • `NestedArcs`  — the ticket's named alternative: one ring per account,
 *                     nearest to running out on the outside.
 *   • `AppleRing`   — the reference's own geometry, measured off it: two gaps,
 *                     figure riding the top one, dots in the bottom one, and
 *                     optionally the account's mark in the middle where its
 *                     Wi-Fi fan goes.
 *   • `RingNumberDots` / `RingPill` — the two that break the box on purpose,
 *                     kept so "we grew the icon" can still be compared with
 *                     answers that did not require growing it.
 *
 * COLOUR IS NEVER ALONE. Every variant's primary signal is arc LENGTH, which
 * survives any colour vision; `TONE_STROKE` below is the same three tokens
 * `account-usage.tsx` paints its bars with, taken from the same `usageTone`,
 * so the glyph and the bars cannot reach different verdicts about one snapshot.
 */

import * as React from "react";
import type { UsageTone } from "@volli/shared";

import { providerMark } from "@renderer/components/models/model-identity";
import { cn } from "@renderer/lib/utils";
import type { AccountReading, IconReading, WindowReading } from "./reading";

/* ------------------------------------------------------------------ geometry */

/** The glyph's own coordinate space. Phosphor's outlines fill roughly this much of theirs. */
const BOX = 24;
const MID = BOX / 2;
/** The outermost ink any variant may touch, leaving the 1px Phosphor leaves. */
const EDGE = 11;

const RING_SW = 2.4;
const RING_R = EDGE - RING_SW / 2;

/** The same three tokens `account-usage.tsx` fills its bars with. */
const TONE_STROKE: Record<UsageTone, string> = {
  normal: "text-primary",
  attention: "text-attention",
  critical: "text-destructive",
};

const MOTION =
  "transition-[stroke-dasharray,opacity,r] duration-300 ease-out motion-reduce:transition-none";

function circumference(r: number): number {
  return 2 * Math.PI * r;
}

/**
 * One arc: a circle wearing a dash pattern, rotated so `from` degrees means
 * degrees clockwise from twelve o'clock.
 *
 * Drawn as a dashed circle rather than a path so that every animatable thing
 * about it — length, position, weight — is a CSS property the browser can
 * interpolate. A `d` attribute cannot be transitioned, and the states this
 * glyph moves between (a window appearing, an account signing out) are exactly
 * the ones worth seeing move rather than blink.
 */
function Arc({
  r,
  sw,
  from = 0,
  span = 360,
  fill,
  className,
  cap = "round",
  animate,
  cy = MID,
}: {
  r: number;
  sw: number;
  from?: number;
  span?: number;
  /** 0–1 of `span` that is inked. */
  fill: number;
  className?: string;
  cap?: "round" | "butt";
  animate?: boolean;
  /** The ring's centre, for variants that push it down to make room above. */
  cy?: number;
}) {
  const circle = circumference(r);
  const drawn = circle * (span / 360) * Math.min(1, Math.max(0, fill));
  return (
    <circle
      cx={MID}
      cy={cy}
      r={r}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      // A ZERO-LENGTH DASH WITH A ROUND CAP IS STILL A DOT. Browsers paint the
      // cap of an empty dash, so `stroke-dasharray: 0 C` does not draw nothing
      // — it draws a bead at the arc's start. That is invisible in a reference
      // check and fatal in the product: a fully spent window would wear a
      // speck at twelve o'clock that reads as dirt on the screen, and the
      // two-arc layout would show one at the top of its unfilled side at every
      // value under half. Squaring the cap at zero is what actually erases it.
      // The element stays mounted either way so the length can still animate.
      strokeLinecap={drawn <= 0 ? "butt" : cap}
      // `${drawn} ${circle}` and never a dashoffset: offset would slide the
      // arc's start as its length changed, so a shrinking arc would appear to
      // travel around the ring instead of retreating from its own end.
      strokeDasharray={`${drawn} ${circle}`}
      transform={`rotate(${from - 90} ${MID} ${cy})`}
      className={cn(className, animate === true && MOTION)}
    />
  );
}

/**
 * The full track an arc is measured against — the share already spent.
 *
 * `account-usage.tsx` paints the same fact `bg-muted`, and this deliberately
 * does not. A bar there is 8px tall and the full width of a popover, so a
 * two-step difference from the canvas is plenty; the same two steps on a 1.4
 * device-pixel ring stroke is invisible, and an invisible track turns the
 * gauge into a floating crescent with nothing to be a share OF. The token is
 * still derived — `--muted-foreground` is solved for contrast in both
 * appearances — so this stays legible on any canvas rather than only on this
 * one. The chosen stacked glyph uses this track too; its contrast against
 * the bars remains a deliberate optical difference rather than an accidental
 * token drift.
 */
function Track({
  r,
  sw,
  from,
  span,
  cap,
  cy,
}: {
  r: number;
  sw: number;
  from?: number;
  span?: number;
  cap?: "round" | "butt";
  cy?: number;
}) {
  return (
    <Arc
      r={r}
      sw={sw}
      from={from}
      span={span}
      fill={1}
      cap={cap}
      cy={cy}
      className="stroke-current text-muted-foreground/30"
    />
  );
}

/**
 * WHERE THE ARC WOULD END IF SPENDING HAD TRACKED THE CLOCK.
 *
 * This is the fix for the one state where colour was doing the work alone.
 * `usageTone` goes amber on PACE as well as on amount, so 39% left with 45% of
 * the window still to run is amber while a healthy 39% is not — and the two
 * draw the same arc. A person who cannot separate those two ambers is exactly
 * the person the colour was for.
 *
 * So the comparison gets drawn. The mark stands at the share of the window
 * still to RUN, which is where the arc's tip would be if the burn had matched
 * the clock, and the reading is a relation rather than a hue: the tip falls
 * SHORT of the mark and you are spending faster than time is passing. The gap
 * between them is the deficit itself, to scale.
 *
 * IT IS ONLY DRAWN WHEN PACE IS AHEAD, for three reasons. Everywhere else the
 * arc's own length already answers the question, so the mark would be ink
 * without a job. `paceOf` guarantees the mark clears the tip by at least
 * `USAGE_PACE_BAND_POINTS` when it does appear, so it never lands on the arc
 * it is being compared to. And its mere presence becomes the second channel —
 * something is here that is not usually here — which is what carries the state
 * for a person who sees no colour at all.
 *
 * IT IS A GAP IN THE TRACK, NOT A TICK ON IT. Two shapes were tried. A hairline
 * of ink across the band is the obvious one and it does not survive: at this
 * size the tick lands under a third of a CSS pixel, so it renders as a grey
 * smudge that reads as dirt rather than as notation. Worse, painting a notch
 * by stroking the background colour over the track binds the glyph to one
 * canvas — `--card` here, but the real chrome band is `--background`, and the
 * mark would have quietly disappeared the moment it shipped.
 *
 * Interrupting the track instead is both resolution-independent and canvas-
 * independent: there is nothing to paint, only something not drawn. A gap can
 * be made as wide as it needs to be to read, where a line cannot be made
 * thinner than a pixel.
 *
 * A MARK THAT CANNOT BE FLANKED BY TRACK IS NOT A MARK. The notch only says
 * anything by standing BETWEEN two runs of track: that is what makes it a
 * position rather than an end. Near either end of the sweep it stops being
 * that. `paceOf` calls a window ahead the moment it is more than five points
 * past an even burn, and a weekly that reset an hour ago is 99% unspent by the
 * clock — so the mark lands hard against the end of the span, and what gets
 * drawn is a crumb of track a third of a pixel long, cut off from the rest.
 * That is indistinguishable from the track simply stopping short, which is to
 * say it reads as a rendering fault rather than as notation, and it was the
 * "random hole" in the stacked glyphs.
 *
 * So the mark withdraws rather than degrade: unless a full notch-width of
 * track survives on BOTH sides of it, the track is drawn whole and the state
 * falls back to tone alone. Nothing is lost by this that was being read —
 * a mark at 99% says only that a window which has barely started is not yet
 * spent, which is true of every window that has barely started.
 */
function TrackWithPaceMark({
  r,
  sw,
  from,
  span,
  onPace,
}: {
  r: number;
  sw: number;
  from: number;
  span: number;
  /** 0–100, the share of the window still to run. */
  onPace: number;
}) {
  // Sized against the stroke rather than the box, so the gap stays the same
  // shape relative to the band it interrupts at every glyph size.
  const gapDegrees = (Math.max(1.6, sw * 1.2) / circumference(r)) * 360;
  const at = span * Math.min(1, Math.max(0, onPace / 100));
  // The clearance rule above: a notch-width of track either side, or no notch.
  // Measured from the notch's centre, that is one and a half widths from each
  // end of the sweep.
  const clear = gapDegrees * 1.5;
  if (at < clear || at > span - clear) {
    return <Track r={r} sw={sw} from={from} span={span} />;
  }
  const before = at - gapDegrees / 2;
  const afterFrom = at + gapDegrees / 2;
  return (
    <>
      <Track r={r} sw={sw} from={from} span={before} cap="butt" />
      <Track r={r} sw={sw} from={from + afterFrom} span={span - afterFrom} cap="butt" />
    </>
  );
}

/**
 * What the glyph is when there is no measurement: a hairline ring, dashed when
 * nothing has been read yet.
 *
 * This is the distinction the drawing has to carry and colour cannot: a FAT
 * muted ring with no arc means "nothing left", and a THIN ring means "nothing
 * measured". Drawing both the same way would make a spent account and a cold
 * launch identical, which is the one confusion a glyph that is always on
 * screen must not create.
 */
function QuietRing({ dashed }: { dashed: boolean }) {
  return (
    <circle
      cx={MID}
      cy={MID}
      r={EDGE - 0.55}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="round"
      strokeDasharray={dashed ? "1.8 2.6" : undefined}
      className="stroke-current text-muted-foreground/45"
    />
  );
}

/** The SVG frame every variant shares, including the accessible name. */
function Glyph({
  size,
  label,
  tall,
  children,
}: {
  size: number;
  label: string;
  /** A taller coordinate space for the variant that hangs dots below the ring. */
  tall?: number;
  children: React.ReactNode;
}) {
  const height = tall ?? BOX;
  // An EMPTY label means the drawing is decorative here — it sits inside a
  // control that already carries the same words, and repeating them makes the
  // control announce its reading two or three times over. In the app the
  // button owns the name and this svg must be silent; the lab has the same
  // problem wherever a card holds a glyph beside its own caption.
  const decorative = label === "";
  return (
    <svg
      width={size}
      height={(size * height) / BOX}
      viewBox={`0 0 ${BOX} ${height}`}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      // `overflow-visible`: round caps on a 2.4 stroke at r=9.8 graze the
      // viewBox edge, and a clipped cap reads as a flat one.
      //
      // `size-auto` is load-bearing and not decoration. `Button`'s `icon-sm`
      // carries `[&_svg:not([class*='size-'])]:size-3.5`, and a CSS `width`
      // beats an SVG's `width` ATTRIBUTE — so inside a real button every
      // variant would be forced to exactly 14×14 regardless of what it was
      // handed, and the 24×30 variant would be letterboxed into a square and
      // silently drawn smaller than the rest. Naming a `size-` class opts out
      // of that rule; `auto` then defers to the attributes above.
      className="size-auto overflow-visible"
    >
      {children}
    </svg>
  );
}

/* --------------------------------------------------------------- the variants */

export interface GlyphProps {
  reading: IconReading;
  size: number;
  label: string;
  animate?: boolean;
  /** How the figures are set before any variant-specific scaling. See {@link NumberStyle}. */
  numberStyle?: NumberStyle;
  /** Thin the stroke as the glyph grows. See {@link opticalStroke}. */
  optical?: boolean;
}

/**
 * How the figure is set, in the glyph's own 24-unit coordinates.
 *
 * WHY THIS IS A DIAL AND NOT A CONSTANT. At the old 14px glyph, a digit was
 * about seven device pixels tall; at the app's text weights its stems fell
 * under one physical pixel and greyed out into the ring behind them. That
 * demanded extra weight merely to be read. The picker varies size and weight
 * independently so the cost of growing the box and the cost of bold type
 * can be judged at real size rather than decided by the first drawing.
 *
 * The first pass was 13/700, which read as a badge rather than as chrome
 * beside the ⌘K pill. A centred figure then tried 12/500 at 22px; the chosen
 * two-figure stack instead starts at 11/500 in a 26px glyph. Its mark takes
 * room from both figures, so the ladder remains evidence rather than a rule
 * that every variant's numbers must reach `--text-label`.
 */
export interface NumberStyle {
  /** Font size in the 24-unit box; CSS px = size × glyphPx / 24 before stacking. */
  size: number;
  weight: number;
}

/**
 * The picker opens with the chosen 11-unit, medium-weight setting.
 *
 * The centred 12-unit figure once met `--text-label` at a 22px glyph, but
 * the winning stack has to make room for a provider mark between TWO figures.
 * It reduces each by a fifth, and at 26px even an 11-unit setting remains
 * below the system's 11px floor. Medium is still the right weight beside the
 * other chrome: the earlier 13/700 bought apparent legibility by shouting
 * over the lost space, turning an instrument into a badge.
 */
export const DEFAULT_NUMBER: NumberStyle = { size: 11, weight: 500 };

/** `--text-label`, 0.6875rem. The smallest type this design system admits. */
export const TYPE_FLOOR_PX = 11;

export interface FigureFit {
  /** What the figure actually renders at, in CSS px. */
  px: number;
  /** Signed fraction away from {@link TYPE_FLOOR_PX}: -0.36 is 36% under. */
  fromFloor: number;
  /** Width of two tabular digits, CSS px. */
  digits: number;
  /** Clear space between the ring's inner edges, CSS px. */
  clear: number;
  /** Whether two digits sit inside the ring with any margin at all. */
  fits: boolean;
}

/**
 * Does the figure fit, at this glyph size, with this type?
 *
 * Stated as a function because the answer is arithmetic and the arithmetic is
 * the finding: a ring's usable middle is a fixed FRACTION of its box (18/24 =
 * 75%), so the figure's size and the glyph's size are locked together and the
 * only free variable is the box. Weight does not appear here, because weight
 * cannot buy space.
 *
 * `0.56em` per digit is Inter's tabular advance; `0.86` keeps a digit's worth
 * of margin inside the stroke, without which the figure kisses the ring and
 * both stop being legible.
 */
export function figureFit(glyphPx: number, style: NumberStyle, optical = true): FigureFit {
  const k = glyphPx / BOX;
  const px = style.size * k;
  const digits = 2 * 0.56 * px;
  const clear = centreClear(glyphPx, optical) * k;
  return { px, fromFloor: px / TYPE_FLOOR_PX - 1, digits, clear, fits: digits <= clear * 0.86 };
}

/**
 * The figure, wherever a variant puts it.
 *
 * At 100% it draws nothing: three digits will not fit, and a ring drawn full
 * already says the only thing "100" would add.
 */
function GlyphNumber({
  value,
  tone,
  x = MID,
  y = MID,
  style = DEFAULT_NUMBER,
}: {
  value: number;
  tone: UsageTone;
  x?: number;
  y?: number;
  style?: NumberStyle;
}) {
  if (value >= 100) return null;
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={style.size}
      fontWeight={style.weight}
      // Tabular figures so the glyph does not change width between 8 and 11,
      // which at this size reads as the icon twitching. The app's sans rather
      // than the mono face: its digits are narrower, and narrow is the whole
      // budget here.
      className={cn(
        "fill-current tabular-nums",
        tone === "normal" ? "text-foreground" : TONE_STROKE[tone],
      )}
    >
      {value}
    </text>
  );
}

/** The share of a window still available, as an arc fraction. */
function share(window: WindowReading | null): number {
  return window === null ? 0 : window.remaining / 100;
}

/**
 * ONE RING. The amount, and nothing else.
 *
 * Everything the other five add has to beat this, because this is already a
 * complete answer to the question the button is for — "am I about to hit a
 * wall" — and it was the only variant with no legibility risk at the old 14px.
 */
export function Ring({ reading, size, label, animate }: GlyphProps) {
  const reported = reading.reported;
  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          <Track r={RING_R} sw={RING_SW} />
          <Arc
            r={RING_R}
            sw={RING_SW}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
        </>
      )}
    </Glyph>
  );
}

/**
 * WHAT A DOT MEANS, wherever a variant puts one.
 *
 * A dot is a COUNT, never a value: three dots is "three more things are
 * metered", not "three-quarters of something". That is the whole borrowing
 * from the reference — a second channel whose shape is different enough that
 * the eye does not try to compare it to the arc.
 *
 * The comparison asks what is being counted. Other
 * ACCOUNTS answers "is the number I am looking at the only one that matters".
 * The lead account's own WINDOWS answers "is this its five-hour limit or its
 * weekly one", which is the question people actually ask out loud — and it
 * fills the hollow dot for the window the ring is currently reporting.
 *
 * (Dots hung INSIDE the circle were tried first and cut: at a 14px glyph they
 * come out under a device pixel across and read as dust on the screen. Every
 * surviving variant puts them in the ring's own band, where they can be as fat
 * as its stroke, or underneath the glyph entirely.)
 */

/** A dot's two states: an outline counts, a fill marks the one being reported. */
interface Dot {
  key: string;
  tone: UsageTone | null;
  solid: boolean;
}

function accountDots(reading: IconReading, cap = 3): readonly Dot[] {
  // Capped, because a further dot is a pixel of ink that changes no decision
  // and the popover is one click away for the exact list. Three for the
  // variants that hang dots inside the circle, five for the Apple-faithful one
  // — that is what its bottom gap was drawn to hold, and five is what the
  // reference itself uses for signal strength.
  return reading.others.slice(0, cap).map((account) => ({
    key: account.providerId,
    // Tinted only when this account is the one in trouble — Apple's dots are
    // monochrome until they mean something, and so are these.
    tone:
      account.binding !== null && account.binding.tone !== "normal" ? account.binding.tone : null,
    solid: true,
  }));
}

function windowDots(reading: IconReading): readonly Dot[] {
  if (reading.lead === null) return [];
  return reading.lead.windows.slice(0, 3).map((window) => ({
    key: window.id,
    tone: window.tone !== "normal" ? window.tone : null,
    // The window the arc is reporting is the solid one. With `dotsMean:
    // "windows"` this is what tells you whether you are looking at the
    // five-hour number or the weekly one without opening anything.
    solid: window.id === reading.reported?.id,
  }));
}

function DotRow({
  dots,
  y,
  radius,
  pitch,
  animate,
}: {
  dots: readonly Dot[];
  y: number;
  radius: number;
  pitch: number;
  animate?: boolean;
}) {
  const span = (dots.length - 1) * pitch;
  return (
    <>
      {dots.map((dot, index) => (
        <circle
          key={dot.key}
          cx={MID - span / 2 + index * pitch}
          cy={y}
          r={radius}
          fill={dot.solid ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={dot.solid ? 0 : 0.7}
          className={cn(
            dot.tone === null ? "text-muted-foreground" : TONE_STROKE[dot.tone],
            animate === true && MOTION,
          )}
        />
      ))}
    </>
  );
}

/* ------------------------------------------ the number in the middle (VC-376) */

/**
 * THE RING CARRIES THE AMOUNT, THE MIDDLE CARRIES THE NUMBER, THE NOTCH
 * CARRIES THE DOTS.
 *
 * Apple puts its figure in a gap at the TOP of the ring because its middle is
 * already taken by the Wi-Fi fan. Ours is empty, so the figure goes where it
 * reads best — the centre — and that turns out to be worth more than the
 * borrowed layout, for a reason that only shows up once both are drawn:
 *
 *   APPLE'S TOP GAP COSTS HALF THE GAUGE. Two gaps of 96° and 84° leave the
 *   arc 180° to map 0–100 onto, so every point is half the length it would be
 *   on a closed ring. With the number in the middle the top gap has no job,
 *   the ring closes over the top, and the arc gets 290° back.
 *
 * So this is the proposal as it was actually asked for — bar around, number in
 * the middle, dots below — keeping the one thing from the reference that is
 * worth keeping: the dots sit IN the ring's band rather than floating inside
 * it. A bead can be as fat as the ring's own stroke because it stands where
 * the stroke would have been; a dot hung inside the circle is a fifth of that
 * and vanishes.
 *
 * THE GEOMETRY IS A FUNCTION OF THE RENDERED SIZE, not a set of constants. The
 * stroke thins as the glyph grows ({@link opticalStroke}) and the radius takes
 * up the slack, so the ring's OUTER edge stays where it is while its middle
 * opens up. Both of those are load-bearing: the outer edge is what meets the
 * ⌘K pill's height at the earlier 22px rung, and the middle is what the
 * figure spends.
 *
 * At 100% the number is dropped: three digits will not fit, and a ring drawn
 * full already says the only thing "100" would add.
 */
const CENTRE_SW = 2;

/**
 * The size {@link CENTRE_SW} was drawn for. Above it the stroke thins.
 *
 * A stroke written in box units scales LINEARLY with the glyph, which is the
 * one thing a mark must not do across this range. 2 units is 1.17 CSS px at
 * 14px — chosen to survive a 14px glyph, where anything finer greys out. Carry
 * that ratio to 22px and the same stroke lands at 1.83px: 57% more ink,
 * holding a shape that no longer needs any of it. That is most of what makes a
 * big version of a small icon look like a BADGE rather than an instrument. The
 * ring gets heavier exactly as it stops needing to be.
 *
 * So absolute weight grows as the square root of the size instead of with it:
 * still thickening, because a larger mark does want a little more presence,
 * but nothing like in step. At 22px the stroke lands at 1.46px rather than
 * 1.83 — a fine circle instead of a fat one — and the middle it gives back is
 * room the figure spends.
 */
const REFERENCE_PX = 14;

/** {@link CENTRE_SW}, corrected for optical scale, in box units at `glyphPx`. */
export function opticalStroke(glyphPx: number): number {
  if (glyphPx <= REFERENCE_PX) return CENTRE_SW;
  const wanted = (CENTRE_SW * REFERENCE_PX) / BOX; // CSS px at the reference
  return ((wanted * Math.sqrt(glyphPx / REFERENCE_PX)) / glyphPx) * BOX;
}

/**
 * What the ring actually leaves the figure, in box units: the clear diameter
 * between the inner edges of the stroke. Multiply by `glyphPx / BOX` for CSS
 * pixels. This is the number the whole design turns on — it is a fixed
 * FRACTION of the box, so the figure's size and the glyph's size are locked
 * together and the only free variable is the box. {@link figureFit} is the
 * honest version of the arithmetic.
 */
export function centreClear(glyphPx: number, optical = true): number {
  const sw = optical ? opticalStroke(glyphPx) : CENTRE_SW;
  return 2 * (EDGE - sw);
}

/** Wide enough for four beads with clearance; the arc keeps the other 290°. */
const CENTRE_NOTCH = 70;

export function RingCentre({
  reading,
  size,
  label,
  animate,
  numberStyle,
  optical = true,
  dots = "none",
}: GlyphProps & { dots?: "none" | "accounts" | "windows" }) {
  const reported = reading.reported;
  // Geometry is a function of the rendered size, not a set of constants: see
  // {@link opticalStroke}. The radius takes up the slack so the ring's OUTER
  // edge stays put as the stroke thins. At the earlier 22px rung its outer
  // diameter matched the ⌘K pill; at the chosen 26px it deliberately exceeds it.
  const sw = optical ? opticalStroke(size) : CENTRE_SW;
  const r = EDGE - sw / 2;
  const dotD = Math.min(1.7, sw * 0.85);
  const pitch = ((dotD + 0.9) / circumference(r)) * 360;
  const beads =
    dots === "none" ? [] : dots === "accounts" ? accountDots(reading, 4) : windowDots(reading);
  // The notch is only cut when something stands in it. A ring with a gap and
  // nothing in it looks broken — and it would quietly re-scale the gauge
  // between a one-account profile and a two-account one, so the same 40% would
  // draw two different lengths.
  const notch = beads.length === 0 ? 0 : CENTRE_NOTCH;
  const from = 180 + notch / 2;
  const span = 360 - notch;
  const spread = (beads.length - 1) * pitch;
  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          {/* The track carries the pace mark, because the mark IS an absence
              of track. See {@link TrackWithPaceMark}. */}
          {reported.pace === "ahead" && reported.onPace !== null ? (
            <TrackWithPaceMark r={r} sw={sw} from={from} span={span} onPace={reported.onPace} />
          ) : (
            <Track r={r} sw={sw} from={from} span={span} />
          )}
          <Arc
            r={r}
            sw={sw}
            from={from}
            span={span}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
          {beads.map((bead, index) => {
            const point = ringPoint(r, 180 - spread / 2 + index * pitch);
            return (
              <circle
                key={bead.key}
                cx={point.x}
                cy={point.y}
                r={dotD / 2}
                fill={bead.solid ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={bead.solid ? 0 : 0.6}
                className={cn(
                  bead.tone === null ? "text-muted-foreground" : TONE_STROKE[bead.tone],
                  animate === true && MOTION,
                )}
              />
            );
          })}
          <GlyphNumber
            value={reported.remaining}
            tone={reported.tone}
            y={MID + 0.2}
            style={numberStyle}
          />
        </>
      )}
    </Glyph>
  );
}

/* ------------------------------------------ the account's own mark (VC-376) */

/**
 * THE SECOND CHANNEL AS AN IDENTITY RATHER THAN A COUNT.
 *
 * The beads were the smallest thing in the earlier 22px comparison: a bead
 * was 1.6 CSS px across, against a ring of 22 and a centred figure of 11.
 * They were sized that way for a good reason — a bead may not be fatter than
 * the stroke it stands in — but the consequence is that the one channel meant
 * to be noticed second is the one channel nobody notices at all.
 *
 * So: put the lead account's own mark where the beads stood. It is a strictly
 * bigger shape in the same box, and it is closer to the reference than the
 * beads ever were — Apple's middle holds the Wi-Fi FAN, a symbol for the thing
 * the other two facts are about, and that is exactly what a provider mark is.
 * The comment above {@link AppleRing} calls our empty middle the one thing we
 * do not have from the reference; this is the answer to it.
 *
 * WHAT IS GAINED AND WHAT IS PAID, because they are not the same fact:
 *
 *   • GAINED. "Whose quota is this?" — which the glyph could not answer at all
 *     before, and which is the first thing anyone asks of a single reading
 *     drawn from up to six accounts. It also survives colour blindness and
 *     small sizes better than a bead: a silhouette is recognised, not read.
 *   • PAID. The count goes. Nothing says "three more accounts are metered",
 *     which the beads did say. And the glyph's own silhouette now CHANGES with
 *     the lead account — Anthropic's A one hour, Copilot's goggles the next.
 *     Apple's centre symbol is invariant; ours would not be. That is the real
 *     argument against, and it is a judgement about a button people locate by
 *     shape, not an arithmetic one — which is why it is drawn here rather than
 *     settled in prose.
 *
 * COLOUR STAYS THE VERDICT'S. The mark is `text-muted-foreground` in every
 * state, never the vendor's tint and never the tone: brand colour inside this
 * glyph would be a second colour language competing with the only one that
 * means anything here, and a mark that turned red with the arc would be more
 * red ink in exactly the state — everything critical — that Apple's own icon
 * is recorded as failing.
 */

/** What fraction of the clear space a mark is allowed to fill. */
const MARK_SHARE = 0.62;

/**
 * The mark's box where it replaces the beads, in glyph units.
 *
 * Sized to the notch rather than the other way round: 7 units is the widest
 * mark that leaves a bead's worth of clearance either side of the arc ends, and
 * {@link MARK_NOTCH} is then derived from it so the two cannot drift apart.
 */
const NOTCH_MARK_BOX = 7;

/**
 * The gap the notch mark stands in — computed, and CONSTANT like the bead
 * notch, for the same reason: the notch is subtracted from the span the gauge
 * maps 0–100% onto, so a notch that changed size would silently re-scale the
 * arc. One mark is always one mark, so this is a module constant; it is written
 * as arithmetic only so that changing the mark's size cannot leave the gap it
 * needs behind. `r = EDGE - 1` is the ring at the reference stroke; the notch
 * is fixed across sizes, and a tenth of a degree either way is invisible.
 */
const MARK_NOTCH =
  2 * Math.asin(Math.min(1, (NOTCH_MARK_BOX / 2 + 1.5) / (EDGE - 1))) * (180 / Math.PI);

/** A mark's own viewBox, parsed once, tolerant of anything malformed. */
function markBox(viewBox: string): { x: number; y: number; w: number; h: number } {
  const parts = viewBox.split(/[\s,]+/).map(Number);
  const [x = 0, y = 0, w = 24, h = 24] =
    parts.length === 4 && parts.every(Number.isFinite) ? parts : [0, 0, 24, 24];
  return { x, y, w, h };
}

/**
 * The lead account's mark, centred on a point, scaled into `box` glyph units.
 *
 * Half the providers that report usage today have no mark of their own — see
 * `providerMark` — so the fallback is not an edge case to note and move past:
 * Kimi, xAI and OpenCode Go all land on it, and any judgement about this
 * direction has to be made on the letter as much as on the logo. It is drawn
 * as a bare letter rather than `ModelMark`'s muted rounded square, because a
 * filled square inside a ring reads as a second ring.
 */
function AccountMark({
  account,
  box,
  cy = MID,
  animate,
}: {
  account: AccountReading | null;
  box: number;
  cy?: number;
  animate?: boolean;
}) {
  if (account === null) return null;
  const mark = providerMark(account.providerId);
  const quiet = cn("text-muted-foreground", animate === true && MOTION);
  if (mark === null) {
    return (
      <text
        x={MID}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        // A letter is measured by its cap height, a logo by its full box, so
        // the same visual mass needs the larger number here. 1.35 puts a cap
        // at roughly the box a mark would have filled.
        fontSize={box * 1.35}
        fontWeight={600}
        className={cn("fill-current", quiet)}
      >
        {account.label.trim().charAt(0).toUpperCase()}
      </text>
    );
  }
  const { x, y, w, h } = markBox(mark.viewBox);
  const scale = box / Math.max(w, h);
  return (
    <g
      // Centre, then scale, then bring the mark's own centre to the origin —
      // right to left, as SVG applies them.
      transform={`translate(${MID} ${cy}) scale(${scale}) translate(${-(x + w / 2)} ${-(y + h / 2)})`}
      className={quiet}
    >
      {mark.paths.map((path) => (
        <path key={path.slice(0, 24)} d={path} fill="currentColor" />
      ))}
    </g>
  );
}

/**
 * MARK IN THE MIDDLE, no figure — the reference's own arrangement.
 *
 * The ring closes over the top and keeps the whole 360° for the amount, and
 * the middle says whose amount it is. This is the variant that answers the
 * complaint most directly: in the earlier 22px comparison the second channel
 * went from 1.6px of bead to about 11px of mark, roughly seven times the width.
 *
 * What it gives up is the exact number, which the popover still carries and
 * which the button's accessible name still says. Worth reading on the Size
 * ladder as well as in the band: a mark is a silhouette, so it degrades more
 * gracefully than digits, but at the old 14px it is about 6px across and the
 * denser marks (Copilot's goggles) are a blob there too.
 */
export function MarkCentre({ reading, size, label, animate, optical = true }: GlyphProps) {
  const reported = reading.reported;
  const sw = optical ? opticalStroke(size) : CENTRE_SW;
  const r = EDGE - sw / 2;
  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          {reported.pace === "ahead" && reported.onPace !== null ? (
            <TrackWithPaceMark r={r} sw={sw} from={0} span={360} onPace={reported.onPace} />
          ) : (
            <Track r={r} sw={sw} />
          )}
          <Arc
            r={r}
            sw={sw}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
          <AccountMark
            account={reading.lead}
            box={centreClear(size, optical) * MARK_SHARE}
            animate={animate}
          />
        </>
      )}
    </Glyph>
  );
}

/**
 * THE LITERAL SWAP: the figure keeps the middle, the mark takes the notch.
 *
 * Everything {@link RingCentre} decided stays decided — the arc, the pace mark,
 * the figure's central position — and only the beads are replaced. In the
 * earlier 22px comparison the mark was about 6.4px: four times a bead, a
 * quarter of the middle mark. It keeps the exact number.
 *
 * The figure rides a shade higher here than in {@link RingCentre}. A mark in
 * the notch reaches further into the circle than a bead does, and a digit's
 * baseline sitting on the mark's top edge makes the two read as one smudged
 * object — which is the whole failure this redesign is trying to avoid.
 */
export function MarkNotch({
  reading,
  size,
  label,
  animate,
  numberStyle,
  optical = true,
}: GlyphProps) {
  const reported = reading.reported;
  const sw = optical ? opticalStroke(size) : CENTRE_SW;
  const r = EDGE - sw / 2;
  const from = 180 + MARK_NOTCH / 2;
  const span = 360 - MARK_NOTCH;
  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          {reported.pace === "ahead" && reported.onPace !== null ? (
            <TrackWithPaceMark r={r} sw={sw} from={from} span={span} onPace={reported.onPace} />
          ) : (
            <Track r={r} sw={sw} from={from} span={span} />
          )}
          <Arc
            r={r}
            sw={sw}
            from={from}
            span={span}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
          <AccountMark
            account={reading.lead}
            box={NOTCH_MARK_BOX}
            // Sat so the mark's box ends on the ring's own outer edge, which is
            // the outermost ink any variant here may touch.
            cy={MID + EDGE - NOTCH_MARK_BOX / 2}
            animate={animate}
          />
          <GlyphNumber
            value={reported.remaining}
            tone={reported.tone}
            y={MID - 0.9}
            style={numberStyle}
          />
        </>
      )}
    </Glyph>
  );
}

/* ------------------------------------------ two figures, stacked (VC-376) */

/**
 * BOTH WINDOWS AS FIGURES: the short span on top, the long one underneath,
 * and the ring reduced to two arcs down the sides.
 *
 * Every variant above answers "am I about to hit a wall" with a SHAPE and
 * leaves the exact numbers to the popover. This one takes the opposite bet:
 * the two numbers people actually say out loud — "I have a third of my session
 * and most of my week" — are printed, and the ring becomes two independent
 * bars, one per figure. Position carries the meaning, so it is fixed by window
 * FAMILY and never by value (`KIND_ORDER` in `reading.ts`): the top figure is
 * always the shorter span. A stack that re-ordered itself as numbers moved
 * would be unlearnable.
 *
 * EACH SIDE IS A COMPLETE GAUGE FOR ITS OWN FIGURE — left for the top number,
 * right for the bottom — and {@link SideGauge} is where that decision and its
 * geometry live. It is the one thing this shape may not get wrong: two figures
 * beside two arcs that do not correspond to them is a drawing that has to be
 * decoded rather than read.
 *
 * WHICH TWO, when an account reports three (OpenCode Go):
 *   • the window the ring is reporting — the pinned one if a pin resolves,
 *     otherwise the binding one — is always one of them, because a glyph whose
 *     arc reports a window neither figure names is a glyph arguing with
 *     itself;
 *   • the other slot goes to the next window by family order.
 * Two explicit pins would say this better than a rule does, and that is the
 * honest version of "show the two pinned" — but the pin model here holds one
 * window, so this rule guarantees the same outcome without inventing a second
 * pin before anyone has asked the Pinning view for one.
 *
 * WITH ONE WINDOW there is nothing to order. The figure takes the top slot
 * when the mark holds the middle, and the middle itself when it does not,
 * where it is both bigger and better placed.
 *
 * THE GAPS ARE THE SAME SIZE WHATEVER STANDS IN THEM. They are cut from the
 * span each side maps 0–100% onto, so a gap that closed when a window went
 * missing would silently re-scale both arcs — the same 40% drawing a different
 * length for a one-window account than for a two-window one.
 *
 * WHAT IT COSTS, which is the whole reason both versions below exist. The box
 * is 24 units tall and a figure eats {@link CAP_HEIGHT} of its own size in
 * that budget, twice over. Empty in the middle, both figures stand at the full
 * setting; at the chosen 26px and 11-unit dial they render just under 12px.
 * Put the mark between them and {@link stackGeometry} takes a fifth off both
 * figures AND hands the mark room of its own. The selected pair therefore
 * lands near 9.5px, below `--text-label`: the price of identity is paid twice,
 * once by each number. The Size view keeps that cost visible.
 */

/** Inter's cap height and tabular digit advance, as fractions of font size. */
const CAP_HEIGHT = 0.72;
const DIGIT_ADVANCE = 0.56;
/** What the outermost figure keeps clear of the glyph box, in box units. */
const STACK_MARGIN = 0.8;
/** And what it keeps clear of whatever stands between the two figures. */
const STACK_CLEAR = 1;
/**
 * The figures' setting when a mark shares the stack, as a fraction of the
 * setting they take when it does not.
 *
 * Not a taste: it is the largest scale at which the mark left over by
 * {@link stackGeometry} is still worth drawing. At the full setting the middle
 * that survives two figures is under four units — a mark smaller than a
 * Phosphor dot — so either the figures give something back or the mark is not
 * really there. A fifth off both is what buys a mark the size of the one
 * {@link MarkNotch} puts in the notch.
 */
const STACK_SCALE = 0.8;

interface StackGeometry {
  /** Font size for both figures, in box units. */
  size: number;
  /** Centre lines of the top and bottom slots. */
  top: number;
  bottom: number;
  /** The box left for a mark between them; 0 when there is none worth drawing. */
  mark: number;
  /** Half-width of each gap, in degrees either side of top and bottom. */
  gapHalf: number;
}

/**
 * The stack, solved rather than positioned by eye.
 *
 * The gap is sized from the figure it has to clear: the arc's end must sit
 * further out than the figure's own half-width plus a unit, or the digits
 * collide with the stroke. Everything else follows from the cap height.
 */
function stackGeometry(style: NumberStyle, withMark: boolean, r: number): StackGeometry {
  const size = style.size * (withMark ? STACK_SCALE : 1);
  const cap = size * CAP_HEIGHT;
  const halfWidth = size * DIGIT_ADVANCE + 1;
  return {
    size,
    top: STACK_MARGIN + cap / 2,
    bottom: BOX - STACK_MARGIN - cap / 2,
    mark: withMark ? Math.max(0, 2 * (MID - STACK_MARGIN - cap - STACK_CLEAR)) : 0,
    gapHalf: (Math.asin(Math.min(1, halfWidth / r)) * 180) / Math.PI,
  };
}

/**
 * The one or two windows the stack draws, in family order.
 *
 * See the rule above: the reported window is always one of them.
 */
function stackedWindows(reading: IconReading): readonly WindowReading[] {
  const windows = reading.lead?.windows ?? [];
  if (windows.length <= 2) return windows;
  const reportedIndex = windows.findIndex((window) => window.id === reading.reported?.id);
  const kept = reportedIndex === -1 ? 0 : reportedIndex;
  const other = kept === 0 ? 1 : 0;
  return [Math.min(kept, other), Math.max(kept, other)].flatMap((index) => {
    const window = windows[index];
    return window === undefined ? [] : [window];
  });
}

/**
 * ONE SIDE, ONE WINDOW, A COMPLETE GAUGE.
 *
 * The first pass ran a SINGLE reading across both arcs the way the reference
 * does — left side first, right side picking up whatever was over half — and
 * that is wrong the moment there are two figures to explain. With a number at
 * the top and another at the bottom, the eye pairs each figure with an arc and
 * finds that neither arc is either figure: at 39% the left side is four
 * fifths full and the right side is empty, which looks like two windows in
 * wildly different health when it is one window drawn round a corner.
 *
 * So each side is its own 0–100: the LEFT arc is the top figure's window, the
 * RIGHT arc is the bottom figure's, each measured over the same span, each
 * carrying its own tone. Two facts, two bars, nothing shared but the geometry.
 *
 * THE RIGHT SIDE IS THE LEFT SIDE MIRRORED, drawn inside a flip rather than
 * computed from its own angles. Both then fill UPWARD from the bottom —
 * fullness, the way any tank reads — and the pair is symmetric when the two
 * windows agree, which makes a difference between them visible as a lack of
 * symmetry before either number is read. Mirroring rather than re-deriving
 * also keeps the arc's own start fixed, so its length still animates as a
 * dash: an arc whose origin moved with its value would appear to travel around
 * the ring instead of growing from its end.
 *
 * THERE IS NO PACE MARK ON THESE SIDES, and the reason is arithmetic rather
 * than taste. {@link TrackWithPaceMark} needs room: the notch has to be wide
 * enough to read as a gap AND still leave visible track between itself and the
 * arc's tip, or the two merge and it reads as the arc having ended early.
 * Splitting the circle in two takes that room away. A side spans about 103° at
 * the earlier 22px rung — 18 units of arc — where the notch is 1.9 units
 * wide, a tenth of the whole side, while `USAGE_PACE_BAND_POINTS` guarantees only 5% of the
 * span between tip and mark: 0.9 units, under a CSS pixel, less than half the
 * notch's own width. They touch in the guaranteed case. Sizing the notch down
 * to fit inside that band would make it thinner than the band it interrupts,
 * which is the hairline the technique exists to avoid.
 *
 * So the mark belongs to the shapes that give it a whole circle, and PACE IS
 * TONE ALONE HERE. That is a real cost and it belongs in the comparison: this
 * shape buys two exact figures by giving up the one state the ring can draw
 * that a number cannot. Judge it on `Ahead of pace` against `Same 39%, under
 * pace` — if those two are indistinguishable to you here, that is the price,
 * stated honestly rather than hidden behind a notch too small to see.
 */
function SideGauge({
  r,
  sw,
  from,
  span,
  window: reading,
  mirror,
  animate,
}: {
  r: number;
  sw: number;
  from: number;
  span: number;
  window: WindowReading;
  /** True for the right-hand side: the same drawing, flipped about the middle. */
  mirror: boolean;
  animate?: boolean;
}) {
  const side = (
    <>
      <Track r={r} sw={sw} from={from} span={span} />
      <Arc
        r={r}
        sw={sw}
        from={from}
        span={span}
        fill={reading.remaining / 100}
        animate={animate}
        className={cn("stroke-current", TONE_STROKE[reading.tone])}
      />
    </>
  );
  // x → BOX - x, which is the vertical axis through the glyph's middle.
  return mirror ? <g transform={`translate(${BOX} 0) scale(-1 1)`}>{side}</g> : side;
}

export function StackedFigures({
  reading,
  size,
  label,
  animate,
  numberStyle,
  optical = true,
  centre = "none",
}: GlyphProps & { centre?: "none" | "mark" }) {
  const reported = reading.reported;
  const sw = optical ? opticalStroke(size) : CENTRE_SW;
  const r = EDGE - sw / 2;
  const style = numberStyle ?? DEFAULT_NUMBER;
  const withMark = centre === "mark";
  const geometry = stackGeometry(style, withMark, r);
  const windows = stackedWindows(reading);
  // One window and no mark: the figure takes the middle, where it is bigger
  // and better placed than in a slot with an empty one facing it.
  const solo = windows.length <= 1 && !withMark;
  const from = 180 + geometry.gapHalf;
  const span = 180 - 2 * geometry.gapHalf;
  const top = windows[0] ?? null;
  // A single window has no partner, so it carries BOTH sides and the glyph is
  // symmetric. The alternatives are worse: an empty right-hand track reads as
  // a second window at zero, and closing the gap instead would re-scale the
  // span, so the same 40% would draw one length for Copilot's single meter and
  // another for Claude's pair.
  const bottom = windows[1] ?? top;
  return (
    <Glyph size={size} label={label}>
      {reported === null || top === null || bottom === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          <SideGauge
            r={r}
            sw={sw}
            from={from}
            span={span}
            window={top}
            mirror={false}
            animate={animate}
          />
          <SideGauge
            r={r}
            sw={sw}
            from={from}
            span={span}
            window={bottom}
            mirror
            animate={animate}
          />
          {withMark && geometry.mark > 0 ? (
            <AccountMark account={reading.lead} box={geometry.mark} animate={animate} />
          ) : null}
          {windows.map((window, index) => (
            <GlyphNumber
              key={window.id}
              value={window.remaining}
              tone={window.tone}
              y={solo ? MID : index === 0 ? geometry.top : geometry.bottom}
              style={{ size: geometry.size, weight: style.weight }}
            />
          ))}
        </>
      )}
    </Glyph>
  );
}

/**
 * THE RING IS THE SECOND CHANNEL: one arc per window of the reported account.
 *
 * This is the variant aimed squarely at "providers have anywhere from one to
 * three measures". Codex's single weekly window fills the whole circle; Claude
 * Code's session and weekly split it in half; OpenCode Go's three take a third
 * each. Nothing is added or taken away as the count changes — the same ink is
 * divided differently, which is why the count can change under your eyes
 * without the glyph becoming a different glyph.
 *
 * SEGMENTS ARE ORDERED BY FAMILY, not by value (`KIND_ORDER` in `reading.ts`).
 * Twelve o'clock is always the shortest window. A ring that re-sorted itself
 * as numbers moved would be unlearnable, which is the failure mode that makes
 * most multi-arc dashboards useless at a glance.
 *
 * The cost, and the thing to look hardest at in the all-critical fixture: with
 * three segments the gaps eat about a seventh of the circle, so each arc is
 * short enough that "empty" and "nearly empty" start to look alike — Apple's
 * smudge, arriving by a different road.
 */
export function SplitRing({ reading, size, label, animate }: GlyphProps) {
  const windows = reading.lead?.windows ?? [];
  if (reading.reported === null || windows.length === 0) {
    return (
      <Glyph size={size} label={label}>
        <QuietRing dashed={reading.kind === "unread"} />
      </Glyph>
    );
  }
  const shown = windows.slice(0, 3);
  const count = shown.length;
  // No gap at all when there is one window: a lone arc with a notch in it
  // would imply a second segment that does not exist.
  const gap = count === 1 ? 0 : 18;
  const stride = 360 / count;
  return (
    <Glyph size={size} label={label}>
      {shown.map((window, index) => {
        const from = index * stride + gap / 2;
        const span = stride - gap;
        return (
          <React.Fragment key={window.id}>
            <Track
              r={RING_R}
              sw={RING_SW}
              from={from}
              span={span}
              cap={count === 1 ? "round" : "butt"}
            />
            <Arc
              r={RING_R}
              sw={RING_SW}
              from={from}
              span={span}
              fill={share(window)}
              animate={animate}
              cap={count === 1 ? "round" : "butt"}
              className={cn("stroke-current", TONE_STROKE[window.tone])}
            />
          </React.Fragment>
        );
      })}
    </Glyph>
  );
}

/**
 * THE TICKET'S NAMED ALTERNATIVE: one ring per account, nearest to running out
 * on the outside.
 *
 * Three concentric arcs at the old 14px rung put roughly 1.2 device pixels
 * of stroke and 0.7 of gap between neighbours, so this remains a comparison,
 * not a claim that the old target could support it. The specific thing to check is whether
 * the inner ring is distinguishable from the middle one at all when both are
 * part-full — if it is not, six accounts of the same kind of fact was always
 * going to be a chart rather than an icon, and the ticket's own reasoning
 * stands.
 */
export function NestedArcs({ reading, size, label, animate }: GlyphProps) {
  const accounts: readonly AccountReading[] =
    reading.lead === null ? [] : [reading.lead, ...reading.others].slice(0, 3);
  if (accounts.length === 0) {
    return (
      <Glyph size={size} label={label}>
        <QuietRing dashed={reading.kind === "unread"} />
      </Glyph>
    );
  }
  const sw = 1.8;
  return (
    <Glyph size={size} label={label}>
      {accounts.map((account, index) => {
        const r = EDGE - sw / 2 - index * (sw + 1.05);
        const binding = account.binding;
        return (
          <React.Fragment key={account.providerId}>
            <Track r={r} sw={sw} />
            {binding === null ? null : (
              <Arc
                r={r}
                sw={sw}
                fill={share(binding)}
                animate={animate}
                className={cn("stroke-current", TONE_STROKE[binding.tone])}
              />
            )}
          </React.Fragment>
        );
      })}
    </Glyph>
  );
}

/**
 * THE WHOLE PROPOSAL AT ONCE: arc around, number inside, dots underneath.
 *
 * The dots move OUT of the ring so they stop competing with the number for the
 * same ten pixels at the old 14px rung, which costs the glyph its square box:
 * it is 24×30 units, so at 14px wide it stands 17.5px tall inside its target.
 * At 26px wide it stands 32.5px tall even before padding, taller than the
 * 32px square button. This variant stays as evidence of what dots underneath
 * cost, not as a shape that fits the chosen box.
 */
export function RingNumberDots({
  reading,
  size,
  label,
  animate,
  numberStyle,
  dotsMean = "windows",
}: GlyphProps & { dotsMean?: "accounts" | "windows" }) {
  const reported = reading.reported;
  const dots = dotsMean === "accounts" ? accountDots(reading) : windowDots(reading);
  return (
    <Glyph size={size} label={label} tall={30}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          <Track r={RING_R} sw={RING_SW} />
          <Arc
            r={RING_R}
            sw={RING_SW}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
          <GlyphNumber value={reported.remaining} tone={reported.tone} style={numberStyle} />
          <DotRow dots={dots} y={27.5} radius={1.2} pitch={3.4} animate={animate} />
        </>
      )}
    </Glyph>
  );
}

/* --------------------------------------------------- dots as part of the ring */

/**
 * Where a point on the ring falls, in the glyph's own coordinates.
 * `deg` is clockwise from twelve o'clock, like everything else here.
 */
function ringPoint(r: number, deg: number, cy: number = MID): { x: number; y: number } {
  const radians = ((deg - 90) * Math.PI) / 180;
  return { x: MID + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
}

/**
 * The notch at the bottom of the ring where the beads live, in degrees.
 *
 * FIXED, never sized to the number of beads. The notch is subtracted from the
 * span the gauge arc maps 0–100% onto, so a notch that grew with the account
 * count would silently re-scale the arc: the same 40% would draw a different
 * length before and after signing into a second account, which is the one
 * thing a gauge may never do.
 */
const NOTCH_DEG = 68;
/** Bead diameter and centre-to-centre pitch, in the glyph's coordinates. */
const BEAD_D = 2;
const BEAD_PITCH_DEG = ((BEAD_D + 1.3) / circumference(RING_R)) * 360;

/**
 * DOTS AS PART OF THE RING — the arrangement Apple actually uses.
 *
 * The dots on the foldable's cover-screen icon are not marks floating inside
 * the circle; they sit in the ring's own band, in a gap cut out of it, so the
 * eye reads one object with a punctuation mark in it rather than two objects
 * sharing a box. Transposed here that buys something the inside-the-circle
 * version cannot have at this size: a bead can be as fat as the ring's own
 * stroke, because it is standing where the stroke would have been. The dots
 * drawn inside the ring were a fifth of that and vanished at the old 14px rung.
 *
 * The gauge therefore runs 0–100% over `360 − NOTCH_DEG` and starts at the
 * notch's far edge, which puts its origin at the lower left and fills
 * clockwise — a speedometer, and the one gauge convention that already has a
 * gap at the bottom.
 *
 * `dotsMean` is the same question as before, now asked where the answer is
 * legible: beads either COUNT the other metered accounts, or NAME this
 * account's windows with the reported one filled in.
 */
export function RingBeads({
  reading,
  size,
  label,
  animate,
  dotsMean = "windows",
}: GlyphProps & { dotsMean?: "accounts" | "windows" }) {
  const reported = reading.reported;
  const beads = dotsMean === "accounts" ? accountDots(reading) : windowDots(reading);
  const from = 180 + NOTCH_DEG / 2;
  const span = 360 - NOTCH_DEG;
  const spread = (beads.length - 1) * BEAD_PITCH_DEG;
  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          <Track r={RING_R} sw={RING_SW} from={from} span={span} />
          <Arc
            r={RING_R}
            sw={RING_SW}
            from={from}
            span={span}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
          {beads.map((bead, index) => {
            const point = ringPoint(RING_R, 180 - spread / 2 + index * BEAD_PITCH_DEG);
            return (
              <circle
                key={bead.key}
                cx={point.x}
                cy={point.y}
                r={BEAD_D / 2}
                fill={bead.solid ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={bead.solid ? 0 : 0.65}
                className={cn(
                  bead.tone === null ? "text-muted-foreground" : TONE_STROKE[bead.tone],
                  animate === true && MOTION,
                )}
              />
            );
          })}
        </>
      )}
    </Glyph>
  );
}

/* ------------------------------------------------- the reference, transposed */

/**
 * The iPhone Duo cover-screen icon's actual geometry, measured off the
 * reference rather than remembered.
 *
 * Two things about it are not what the ticket's description implies, and both
 * matter:
 *
 *  1. THE RING HAS TWO GAPS, NOT ONE. There is a wide gap at the TOP that the
 *     number sits in, and a narrower one at the BOTTOM that the dots sit in.
 *     The ring is therefore two mirrored arcs down the left and right sides.
 *  2. THE NUMBER IS NOT INSIDE THE RING. It occupies the top gap and rides
 *     above the ring's own top edge. That is the whole trick, and it is the
 *     answer to the problem every centre-number variant on this page has:
 *     inside the ring a figure is capped by the inner diameter, which at a
 *     14px glyph is about ten device pixels. In the top gap it is capped by
 *     the glyph box instead, so it can be half again as tall at that rung.
 *
 * THE FILL RUNS LEFT ARC THEN RIGHT ARC, from the bottom-left end, clockwise.
 * The reference confirms it twice over: at 50 the left arc is exactly full and
 * the right is exactly empty, and at 16 the ink is a short stub at the bottom
 * of the left arc. So the gauge maps 0–100 onto the two arcs' combined span,
 * and half is the nine-o'clock-to-twelve quadrant — a reading that is easy to
 * take at a glance and, usefully, symmetric.
 *
 * WHAT WE DO NOT HAVE is Apple's centre. Theirs holds the Wi-Fi fan, which is
 * the "what" the other two facts are about; ours would be empty, because our
 * three channels are all about one account. An empty middle is the honest
 * thing to look at here — whether the glyph still reads as one object, or as a
 * bracket with a number balanced on top.
 *
 * …unless the middle holds the ACCOUNT's mark, which is the one thing we have
 * that is a symbol for a thing rather than another percentage. `centre:
 * "mark"` fills it in, and that version is the closest this page gets to the
 * reference: number in the top gap, symbol in the middle, dots along the
 * bottom, arc down both sides. See {@link AccountMark}.
 */
const APPLE_CY = 13.6;
const APPLE_R = 8.3;
const APPLE_SW = 2.2;
/**
 * Half-widths of the two gaps, in degrees either side of top and bottom.
 *
 * The top gap is sized so the opening between the two arc ends is just wider
 * than two digits: at r=8.3 a 48° half-gap leaves 12.3 units of clear width,
 * and `50` at the font size below is 11.8. That is the proportion the
 * reference holds, and getting it wrong in either direction is what makes the
 * glyph look like a number balanced on a bracket rather than one object.
 *
 * The bottom gap is sized to hold four dots with clearance rather than to some
 * round number: dots that touch the arc ends read as a broken ring.
 */
const APPLE_TOP_HALF = 48;
const APPLE_BOTTOM_HALF = 42;
/**
 * One side's span; the gauge maps 0–100 onto two of these.
 *
 * NOTE THE COST, because it is the real argument against this layout: the two
 * gaps together take 90° out of the circle, so the amount is drawn over 180°
 * rather than 360°. Every percentage point is half the arc it would be on a
 * plain ring. Apple can afford that because the number is doing the precise
 * work and the arc is only a shape; if our number turns out not to survive
 * the old 14px rung, this layout loses half its resolution for nothing.
 */
const APPLE_ARC_SPAN = 180 - APPLE_TOP_HALF - APPLE_BOTTOM_HALF;

export function AppleRing({
  reading,
  size,
  label,
  animate,
  numberStyle,
  dotsMean = "accounts",
  showNumber = true,
  centre = "none",
}: GlyphProps & {
  dotsMean?: "accounts" | "windows";
  showNumber?: boolean;
  /** What stands in the ring's middle. See the note above. */
  centre?: "none" | "mark";
}) {
  const reported = reading.reported;
  const dots = dotsMean === "accounts" ? accountDots(reading, 4) : windowDots(reading);
  // Left arc first, then the right one picks up whatever is left over.
  const total = share(reported) * (APPLE_ARC_SPAN * 2);
  const leftFill = Math.min(1, total / APPLE_ARC_SPAN);
  const rightFill = Math.max(0, (total - APPLE_ARC_SPAN) / APPLE_ARC_SPAN);
  const leftFrom = 180 + APPLE_BOTTOM_HALF;
  const rightFrom = APPLE_TOP_HALF;
  const tone = reported === null ? "normal" : reported.tone;
  const spread = (dots.length - 1) * APPLE_DOT_PITCH;

  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          <Track r={APPLE_R} sw={APPLE_SW} cy={APPLE_CY} from={leftFrom} span={APPLE_ARC_SPAN} />
          <Track r={APPLE_R} sw={APPLE_SW} cy={APPLE_CY} from={rightFrom} span={APPLE_ARC_SPAN} />
          <Arc
            r={APPLE_R}
            sw={APPLE_SW}
            cy={APPLE_CY}
            from={leftFrom}
            span={APPLE_ARC_SPAN}
            fill={leftFill}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[tone])}
          />
          <Arc
            r={APPLE_R}
            sw={APPLE_SW}
            cy={APPLE_CY}
            from={rightFrom}
            span={APPLE_ARC_SPAN}
            fill={rightFill}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[tone])}
          />
          {dots.map((dot, index) => {
            const point = ringPoint(
              APPLE_DOT_R,
              180 - spread / 2 + index * APPLE_DOT_PITCH,
              APPLE_CY,
            );
            return (
              <circle
                key={dot.key}
                cx={point.x}
                cy={point.y}
                r={APPLE_DOT_D / 2}
                fill={dot.solid ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={dot.solid ? 0 : 0.6}
                className={cn(
                  dot.tone === null ? "text-muted-foreground" : TONE_STROKE[dot.tone],
                  animate === true && MOTION,
                )}
              />
            );
          })}
          {centre === "mark" ? (
            <AccountMark
              account={reading.lead}
              // Apple's ring is smaller than ours and sits lower, so the mark
              // is measured against ITS inner clear rather than the box: the
              // same fraction of a smaller middle, on the ring's own centre.
              box={2 * (APPLE_R - APPLE_SW / 2) * MARK_SHARE}
              cy={APPLE_CY}
              animate={animate}
            />
          ) : null}
          {showNumber ? (
            // Sat so its cap height starts just below the glyph box's top edge
            // and its baseline lands a shade into the ring's top gap, which is
            // the overlap the reference has. Higher and it draws outside the
            // box; lower and it collides with the two arc ends. Two units
            // smaller than the centred variants', because the top gap is
            // narrower than the ring's inside.
            <GlyphNumber
              value={reported.remaining}
              tone={tone}
              y={4.7}
              style={{
                size: (numberStyle ?? DEFAULT_NUMBER).size - 2.2,
                weight: (numberStyle ?? DEFAULT_NUMBER).weight,
              }}
            />
          ) : null}
        </>
      )}
    </Glyph>
  );
}

/**
 * Dot diameter, ring and pitch for the reference geometry.
 *
 * The dots ride a slightly smaller circle than the ring, as they do in the
 * reference — sitting exactly on the ring's own radius makes them read as
 * pieces the ring has shed rather than as a separate row.
 */
const APPLE_DOT_D = 1.65;
const APPLE_DOT_R = APPLE_R - 0.5;
const APPLE_DOT_PITCH = ((APPLE_DOT_D + 0.85) / circumference(APPLE_DOT_R)) * 360;

/**
 * THE HONEST ESCAPE HATCH, if the number turns out not to fit.
 *
 * This was the escape hatch when the experiment still assumed the Gauge's
 * 24px button and 14px glyph were fixed. It puts the figure BESIDE the ring
 * at the label size instead of squeezing it into the ten-pixel circle at that
 * rung. The chosen stack solves a different problem by growing the target,
 * but this alternative stays visible so that decision has a comparison.
 *
 * It is the arrangement where a figure is unambiguously readable even at
 * the old glyph size. What it costs is the row:
 * the cluster stops being a run of equal squares, the control's width now
 * changes with its own content (8% is narrower than 88%), and a button that
 * changes width is a button whose position the ⌘K pill inherits. `tabular-nums`
 * holds the digits still; nothing holds the `100%` case still except dropping
 * the number there, which it does.
 */
export function RingPill({ reading, size, label, animate }: GlyphProps) {
  const reported = reading.reported;
  return (
    <span
      // Same convention as {@link Glyph}: an empty label means the control
      // around this already carries the words.
      {...(label === "" ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      className="flex h-6 items-center gap-1 rounded-md px-1 text-muted-foreground"
    >
      <Ring reading={reading} size={size} label="" animate={animate} />
      {reported === null || reported.remaining >= 100 ? null : (
        <span
          className={cn(
            "text-label tabular-nums",
            reported.tone === "normal" ? "text-muted-foreground" : TONE_STROKE[reported.tone],
          )}
        >
          {reported.remaining}%
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------- registry */

/** Every candidate, in the order the stage lays them out. */
export interface Candidate {
  id: string;
  name: string;
  /** What this variant is betting on, in one line. */
  bet: string;
  render(props: GlyphProps): React.ReactElement;
  /**
   * What this shape multiplies {@link NumberStyle.size} by, when it sets its
   * figures smaller than the dial says — so the Size view measures the type
   * this shape actually draws rather than the type it was handed.
   */
  figureScale?: number;
  /**
   * True when the figures are STACKED rather than centred. What caps them is
   * then the box's height, not the ring's clear middle, and the Size view has
   * to say so or its arithmetic describes a different drawing.
   */
  stacked?: boolean;
  /**
   * `"pill"` marks a candidate that is its own control rather than a glyph
   * inside a square icon button — i.e. one that breaks the row.
   */
  chrome?: "icon" | "pill";
}

export const CANDIDATES: readonly Candidate[] = [
  // The brief's original three come first in the comparison order: bar around,
  // number in the middle, dots below. They differ only in what a dot counts.
  {
    id: "centre-windows",
    name: "Centre + beads (windows)",
    bet: "The proposal: arc for the amount, figure in the middle, one bead per window with the reported one filled.",
    render: (props) => <RingCentre {...props} dots="windows" />,
  },
  {
    id: "centre-accounts",
    name: "Centre + beads (accounts)",
    bet: "The same, with the beads counting the OTHER metered accounts instead of this one's windows.",
    render: (props) => <RingCentre {...props} dots="accounts" />,
  },
  {
    id: "centre-plain",
    name: "Centre, no beads",
    bet: "Number in the middle and nothing else — the closed ring keeps the full 360° for the amount.",
    render: (props) => <RingCentre {...props} dots="none" />,
  },
  // The beads' successor: the same second channel, drawn as an identity rather
  // than a count, because in the earlier 22px comparison a bead was 1.6px
  // and a mark was four to seven times that. Three placements show the cost.
  {
    id: "mark-centre",
    name: "Mark in the middle",
    bet: "Apple's own arrangement: the ring is the amount, the middle says whose. No figure — the popover keeps it.",
    render: (props) => <MarkCentre {...props} />,
  },
  {
    id: "mark-notch",
    name: "Number + mark in the notch",
    bet: "The literal swap: beads out, the account's mark in, and the figure keeps the middle.",
    render: (props) => <MarkNotch {...props} />,
  },
  {
    id: "apple-mark",
    name: "Apple, transposed + mark",
    bet: "All three channels where the reference stacks them: figure in the top gap, mark in the middle, dots below.",
    render: (props) => <AppleRing {...props} dotsMean="accounts" centre="mark" />,
  },
  // The other bet entirely: print both windows and demote the ring. The pair
  // exists because the mark's whole cost is visible only by comparing them.
  {
    id: "two-figures-mark",
    name: "Two figures + mark",
    bet: "Both windows as numbers — short span on top, long one below — each with its own bar on its own side, and the mark between them.",
    render: (props) => <StackedFigures {...props} centre="mark" />,
    figureScale: STACK_SCALE,
    stacked: true,
  },
  {
    id: "two-figures",
    name: "Two figures",
    bet: "The same pair of bars with the middle empty: at the chosen size both figures are larger, showing what the mark costs.",
    render: (props) => <StackedFigures {...props} />,
    stacked: true,
  },
  {
    id: "ring",
    name: "Ring",
    bet: "The amount alone is the whole answer; anything else is ink that has to justify itself.",
    render: (props) => <Ring {...props} />,
  },
  {
    id: "apple",
    name: "Apple, transposed",
    bet: "The reference's own geometry: gap at the top for the number, gap at the bottom for the dots, fill left arc then right.",
    render: (props) => <AppleRing {...props} dotsMean="accounts" />,
  },
  {
    id: "apple-no-number",
    name: "Apple, no number",
    bet: "The same two-gap ring with the top gap left empty — the old 14px test if its figure did not survive.",
    render: (props) => <AppleRing {...props} dotsMean="accounts" showNumber={false} />,
  },
  {
    id: "ring-beads-windows",
    name: "Beads, no number",
    bet: "The centre variant's ring without the figure — the old 14px test if two digits did not survive.",
    render: (props) => <RingBeads {...props} dotsMean="windows" />,
  },
  {
    id: "split-ring",
    name: "Split ring",
    bet: "One arc per window; 1, 2 or 3 windows divide the same circle instead of adding shapes.",
    render: (props) => <SplitRing {...props} />,
  },
  {
    id: "nested-arcs",
    name: "Nested arcs",
    bet: "The ticket's alternative — one ring per account, nearest to running out outermost.",
    render: (props) => <NestedArcs {...props} />,
  },
  {
    id: "ring-number-dots",
    name: "Ring + number + dots",
    bet: "The full proposal, at the price of a 24×30 box in a row of square glyphs.",
    render: (props) => <RingNumberDots {...props} />,
  },
  {
    id: "ring-pill",
    name: "Ring + number beside it",
    bet: "Breaks the square-button rule on purpose — two digits beside the ring are legible even at the old 14px rung.",
    render: (props) => <RingPill {...props} />,
    chrome: "pill",
  },
];

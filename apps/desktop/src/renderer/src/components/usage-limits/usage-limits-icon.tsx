/**
 * The window-bar usage glyph: both of an account's windows as figures, each
 * with its own bar, and the account's own mark between them (VC-376).
 *
 * WHAT IT REPLACED, and why the shape changed rather than the size. The button
 * used to draw Phosphor's Gauge — the same glyph the effort picker and the
 * activity bar use, so one shape meant three unrelated things — and it drew
 * the identical picture at 95% left and at 2%. The answer was one click away,
 * all day, on every page.
 *
 * WHY NOT APPLE'S ICON, WHICH STARTED THIS. iOS 27's cover-screen glyph folds
 * Wi-Fi, cellular and battery into one ring because those are three facts of
 * three different KINDS: an arc for an amount, a symbol for a thing, dots for
 * a count, and the eye separates them without being taught. We have up to six
 * accounts of one to three windows each, and every one of them is the same
 * kind of fact — a percentage left. Six arcs of one shape is a chart, not an
 * icon. So this took the idea (one small shape carries the state, colour is
 * the verdict, the detail is one click away) and not the layout.
 *
 * THE BET THIS DRAWING MAKES is exactness over shape. The candidates that kept
 * a single ring had to pick ONE window to report and leave the other to the
 * popover; this prints both — the short span on top, the long one below, in
 * family order — and demotes each ring to a half-circle beside its own figure.
 * Two numbers in a glyph is more than an icon usually carries, and it is the
 * whole reason the glyph is 26px rather than the 14 the Gauge sat at: the
 * ring's clear middle is a fixed FRACTION of its box, so at 14px two digits of
 * the system's smallest type are wider than the space that exists. The rest of
 * the picker's reasoning, and the shapes this beat, are in the lab scratch.
 *
 * WHAT IT COSTS, recorded here because it is a real loss and not a detail.
 * `usageTone` turns amber on PACE as well as on amount, and the round variants
 * could draw that as a notch in the track where the arc would end if the burn
 * had matched the clock. Half a circle has no room for one — the notch is a
 * tenth of a 109° side, while the pace band guarantees under a pixel of track
 * between it and the arc's tip — so in THIS shape pace is carried by tone
 * alone on screen, and by the spoken name for anyone who cannot use it. The
 * amount, which is what the icon is mostly for, is still length first.
 */

import type { ReactNode } from "react";
import type { UsageTone } from "@volli/shared";

import { providerMark } from "@renderer/components/models/model-identity";
import {
  usageIconWindows,
  type UsageAccountReading,
  type UsageIconReading,
  type UsageWindowReading,
} from "@renderer/components/usage-limits/icon-reading";
import { cn } from "@renderer/lib/utils";

/* ------------------------------------------------------------------ geometry */

/** The glyph's own coordinate space. Phosphor's outlines fill about this much of theirs. */
const BOX = 24;
const MID = BOX / 2;
/** The outermost ink the drawing may touch, leaving the 1px Phosphor leaves. */
const EDGE = 11;

/**
 * What the glyph renders at, and the size everything else here is solved for.
 *
 * Not a taste and not a Phosphor default: two digits at the system's smallest
 * type (`--text-label`, 11px) need a clear middle no 14px ring has, and the
 * stacked pair needs more still. 26 is the rung where both figures come within
 * a twentieth of the floor while the button stays inside a 36px band.
 */
export const USAGE_ICON_PX = 26;

/** `icon-sm`'s own proportion: 3px of padding around the glyph, either side. */
export const USAGE_ICON_BUTTON_PX = USAGE_ICON_PX + 6;

/**
 * How the figures are set, in the 24-unit box.
 *
 * A number inside a glyph is not body copy and cannot be set like one, so both
 * halves of this were found by eye at real size in the lab rather than picked
 * from the type scale: 11 units is what leaves the mark between the two
 * figures a box worth drawing, and `medium` is the weight the rest of the
 * chrome band uses. The first pass was bolder, and bolder read as a BADGE —
 * the weight was never style, it was a figure under the floor shouting to stay
 * legible.
 */
const FIGURE = { size: 11, weight: 500 } as const;

/** The same three tokens `account-usage.tsx` fills its bars with. */
const TONE_STROKE: Record<UsageTone, string> = {
  normal: "text-primary",
  attention: "text-attention",
  critical: "text-destructive",
};

/**
 * Small, gentle, and off under reduced motion.
 *
 * Only the length of an arc and the mark's opacity move. A glyph in window
 * chrome that animated its position or its size would be a thing moving in the
 * corner of the eye all day; a bar that grows into its new value is the one
 * change worth seeing, because it says WHICH WAY the number went.
 */
const MOTION =
  "transition-[stroke-dasharray,opacity] duration-300 ease-out motion-reduce:transition-none";

function circumference(r: number): number {
  return 2 * Math.PI * r;
}

/**
 * The ring's stroke, corrected for the fact that the glyph is nearly twice the
 * size the weight was drawn for.
 *
 * A stroke written in box units scales LINEARLY with the glyph: 2 units is
 * 1.17 CSS px at 14px, where anything finer greys out, but the same 2 units at
 * 26px is 2.17px — 86% more ink holding a shape that no longer needs any of
 * it. That is most of what makes a big version of a small icon look like a
 * badge. Absolute weight grows as the square ROOT of the size instead: still
 * thickening, because a larger mark does want some more presence, but nothing
 * like in step. The middle it gives back is room the figures spend.
 */
const CENTRE_SW = 2;
/** The size {@link CENTRE_SW} was drawn for. Above it the stroke thins. */
const REFERENCE_PX = 14;

function opticalStroke(glyphPx: number): number {
  if (glyphPx <= REFERENCE_PX) return CENTRE_SW;
  const wanted = (CENTRE_SW * REFERENCE_PX) / BOX; // CSS px at the reference
  return ((wanted * Math.sqrt(glyphPx / REFERENCE_PX)) / glyphPx) * BOX;
}

/** Solved once: every input above is a constant, so this is not per-render work. */
const SW = opticalStroke(USAGE_ICON_PX);
/** The radius takes up the slack the thinner stroke leaves, so the OUTER edge holds still. */
const R = EDGE - SW / 2;

/* --------------------------------------------------------------- the drawing */

/**
 * One arc: a circle wearing a dash pattern, rotated so `from` degrees means
 * degrees clockwise from twelve o'clock.
 *
 * Drawn as a dashed circle rather than a path so that its length is a CSS
 * property the browser can interpolate. A `d` attribute cannot be transitioned,
 * and the changes this glyph makes — a window refilling on reset, an account
 * signing out — are exactly the ones worth seeing move rather than blink.
 */
function Arc({
  from,
  span,
  fill,
  className,
}: {
  from: number;
  span: number;
  /** 0–1 of `span` that is inked. */
  fill: number;
  className?: string;
}) {
  const circle = circumference(R);
  const drawn = circle * (span / 360) * Math.min(1, Math.max(0, fill));
  return (
    <circle
      cx={MID}
      cy={MID}
      r={R}
      fill="none"
      stroke="currentColor"
      strokeWidth={SW}
      // A ZERO-LENGTH DASH WITH A ROUND CAP IS STILL A DOT. Browsers paint the
      // cap of an empty dash, so `stroke-dasharray: 0 C` does not draw nothing
      // — it draws a bead at the arc's start. In this glyph that would put a
      // speck at the foot of a spent window's bar, which reads as dirt on the
      // screen. Squaring the cap at zero is what actually erases it; the
      // element stays mounted either way so the length can still animate.
      strokeLinecap={drawn <= 0 ? "butt" : "round"}
      // `${drawn} ${circle}` and never a dashoffset: an offset would slide the
      // arc's start as its length changed, so a shrinking bar would appear to
      // travel around the ring instead of retreating from its own end.
      strokeDasharray={`${drawn} ${circle}`}
      transform={`rotate(${from - 90} ${MID} ${MID})`}
      className={className}
    />
  );
}

/**
 * The full sweep an arc is measured against — the share already spent.
 *
 * `account-usage.tsx` paints the same fact `bg-muted`, and this deliberately
 * does not. A bar there is 8px tall and the width of a popover, so two steps
 * from the canvas is plenty; the same two steps on a 1.5 device-pixel ring
 * stroke is invisible, and an invisible track turns each bar into a floating
 * crescent with nothing to be a share OF. The token is still derived, so this
 * stays legible on any canvas rather than only on today's.
 */
function Track({ from, span }: { from: number; span: number }) {
  return (
    <Arc from={from} span={span} fill={1} className="stroke-current text-muted-foreground/30" />
  );
}

/**
 * What the glyph is when there is no measurement: a hairline ring, dashed when
 * nothing has been read yet.
 *
 * This is the distinction the drawing has to carry and colour cannot. A FAT
 * muted ring with no bars means "nothing left"; a THIN one means "nothing
 * measured". Drawing both the same way would make a spent account and a cold
 * launch identical, which is the one confusion a glyph that is always on
 * screen must not create. The dashes then separate "not yet" from "asked and
 * failed", which the popover explains in words the moment it is opened.
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

/** The SVG frame, silent: the button around it already carries the name. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={USAGE_ICON_PX}
      height={USAGE_ICON_PX}
      viewBox={`0 0 ${BOX} ${BOX}`}
      aria-hidden
      // `overflow-visible`: a round cap at this radius grazes the viewBox edge,
      // and a clipped cap reads as a flat one.
      //
      // `size-auto` is load-bearing. `Button`'s `icon-sm` carries
      // `[&_svg:not([class*='size-'])]:size-3.5`, and a CSS width beats an
      // SVG's width ATTRIBUTE — so without naming a `size-` class this glyph
      // would be forced to 14px inside the very button it was drawn for.
      // `auto` then defers to the attributes above.
      className="size-auto overflow-visible"
    >
      {children}
    </svg>
  );
}

/**
 * One figure.
 *
 * At 100% it draws nothing: three digits will not fit, and a bar drawn full
 * already says the only thing "100" would add.
 */
function GlyphNumber({ value, tone, y }: { value: number; tone: UsageTone; y: number }) {
  if (value >= 100) return null;
  return (
    <text
      x={MID}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={STACK.size}
      fontWeight={FIGURE.weight}
      // Tabular figures so the glyph does not change width between 8 and 11,
      // which at this size reads as the icon twitching. The app's sans rather
      // than the mono face: its digits are narrower, and narrow is the budget.
      className={cn(
        "fill-current tabular-nums",
        tone === "normal" ? "text-foreground" : TONE_STROKE[tone],
      )}
    >
      {value}
    </text>
  );
}

/* -------------------------------------------------------------------- the mark */

/** A mark's own viewBox, parsed once, tolerant of anything malformed. */
function markBox(viewBox: string): { x: number; y: number; w: number; h: number } {
  const parts = viewBox.split(/[\s,]+/).map(Number);
  const [x = 0, y = 0, w = 24, h = 24] =
    parts.length === 4 && parts.every(Number.isFinite) ? parts : [0, 0, 24, 24];
  return { x, y, w, h };
}

/**
 * The lead account's mark, standing between the two figures.
 *
 * THIS IS THE SECOND CHANNEL, and it is an identity rather than a count. The
 * first pass put beads here — one per window, Apple's own answer — and at the
 * size that ships a bead is about 1.6px: present in a mockup, invisible in the
 * band. The mark is five times that, and it answers a question the numbers
 * cannot: WHOSE quota this is, on a machine where four accounts are signed in.
 *
 * COLOUR STAYS THE VERDICT'S. The mark is `text-muted-foreground` in every
 * state — never the vendor's tint, never the tone. Brand colour inside this
 * glyph would be a second colour language competing with the only one that
 * means anything here, and a mark that turned red with the bars would be more
 * red ink in exactly the state Apple's own icon is recorded as failing.
 *
 * Half the providers that report usage have no mark of their own, so the
 * fallback is not an edge case: Kimi, xAI and OpenCode Go all land on the
 * letter. It is drawn bare rather than in `ModelMark`'s muted rounded square,
 * because a filled square between two bars reads as a third bar.
 */
function AccountMark({ account }: { account: UsageAccountReading | null }) {
  if (account === null) return null;
  const mark = providerMark(account.providerId);
  const quiet = cn("text-muted-foreground", MOTION);
  if (mark === null) {
    return (
      <text
        x={MID}
        y={MID}
        textAnchor="middle"
        dominantBaseline="central"
        // A letter is measured by its cap height and a logo by its full box,
        // so the same visual mass needs the larger number here: 1.35 puts a
        // cap at roughly the box a mark would have filled.
        fontSize={STACK.mark * 1.35}
        fontWeight={600}
        className={cn("fill-current", quiet)}
      >
        {account.label.trim().charAt(0).toUpperCase()}
      </text>
    );
  }
  const { x, y, w, h } = markBox(mark.viewBox);
  const scale = STACK.mark / Math.max(w, h);
  return (
    <g
      // Centre, then scale, then bring the mark's own centre to the origin —
      // right to left, as SVG applies them.
      transform={`translate(${MID} ${MID}) scale(${scale}) translate(${-(x + w / 2)} ${-(y + h / 2)})`}
      className={quiet}
    >
      {mark.paths.map((path) => (
        <path key={path.slice(0, 24)} d={path} fill="currentColor" />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------- the stack */

/** Inter's cap height and tabular digit advance, as fractions of font size. */
const CAP_HEIGHT = 0.72;
const DIGIT_ADVANCE = 0.56;
/** What the outer edge of a figure keeps clear of the glyph box, in box units. */
const STACK_MARGIN = 0.8;
/** And what it keeps clear of the mark between them. */
const STACK_CLEAR = 1;
/**
 * What the mark costs both figures, as a fraction of their setting.
 *
 * Not a taste: it is the largest scale at which the middle left over by two
 * figures is still worth drawing a mark in. At the full setting what survives
 * is under four units — a mark smaller than a bead, which is the thing this
 * drawing replaced. A fifth off both is what buys one worth having, and it is
 * the price of the account's identity, paid twice, once by each number.
 */
const STACK_SCALE = 0.8;

/**
 * The stack, solved rather than positioned by eye — and solved ONCE, because
 * every input is a constant.
 *
 * The gap at the top and bottom is sized from the figure it has to clear: each
 * bar must end further round than the figure's own half-width plus a unit, or
 * the digits collide with the stroke. Everything else follows from the cap
 * height.
 *
 * THE GAPS ARE THE SAME SIZE WHATEVER STANDS IN THEM. They are cut from the
 * span each bar maps 0–100% onto, so a gap that closed when a window went
 * missing would silently re-scale both bars — the same 40% drawing a different
 * length for a one-window account than for a two-window one.
 */
function stackGeometry(): {
  size: number;
  top: number;
  bottom: number;
  mark: number;
  from: number;
  span: number;
} {
  const size = FIGURE.size * STACK_SCALE;
  const cap = size * CAP_HEIGHT;
  const halfWidth = size * DIGIT_ADVANCE + 1;
  const gapHalf = (Math.asin(Math.min(1, halfWidth / R)) * 180) / Math.PI;
  return {
    size,
    top: STACK_MARGIN + cap / 2,
    bottom: BOX - STACK_MARGIN - cap / 2,
    mark: Math.max(0, 2 * (MID - STACK_MARGIN - cap - STACK_CLEAR)),
    // Six o'clock plus half a gap, sweeping clockwise up the left-hand side.
    from: 180 + gapHalf,
    span: 180 - 2 * gapHalf,
  };
}

const STACK = stackGeometry();

/**
 * ONE SIDE, ONE WINDOW, A COMPLETE GAUGE.
 *
 * The first pass ran a single reading across both sides the way Apple's ring
 * does — left first, right picking up whatever was over half — and that is
 * wrong the moment there are two figures to explain. With a number at the top
 * and another at the bottom the eye pairs each figure with a bar and finds
 * that neither bar is either figure: at 39% the left side is four fifths full
 * and the right side is empty, which looks like two windows in wildly
 * different health when it is one window drawn round a corner.
 *
 * So each side is its own 0–100: the LEFT bar is the top figure's window, the
 * RIGHT bar is the bottom figure's, each over the same span, each carrying its
 * own tone. Two facts, two bars, nothing shared but the geometry.
 *
 * THE RIGHT SIDE IS THE LEFT SIDE MIRRORED, drawn inside a flip rather than
 * computed from its own angles. Both then fill UPWARD from the bottom —
 * fullness, the way any tank reads — and the pair is symmetric when the two
 * windows agree, which makes a difference between them visible as a lack of
 * symmetry before either number is read. Mirroring rather than re-deriving
 * also keeps each arc's own start fixed, so its length still animates as a
 * dash instead of appearing to travel.
 */
function SideGauge({ window: reading, mirror }: { window: UsageWindowReading; mirror: boolean }) {
  const side = (
    <>
      <Track from={STACK.from} span={STACK.span} />
      <Arc
        from={STACK.from}
        span={STACK.span}
        fill={reading.remaining / 100}
        className={cn("stroke-current", TONE_STROKE[reading.tone], MOTION)}
      />
    </>
  );
  // x → BOX - x, which is the vertical axis through the glyph's middle.
  return mirror ? <g transform={`translate(${BOX} 0) scale(-1 1)`}>{side}</g> : side;
}

export function UsageLimitsIcon({ reading }: { reading: UsageIconReading }) {
  const windows = usageIconWindows(reading);
  const top = windows[0];
  // A single window has no partner, so it carries BOTH sides and the glyph is
  // symmetric. The alternatives are worse: an empty right-hand track reads as
  // a second window at zero, and closing the gap instead would re-scale the
  // span, so the same 40% would draw one length for Copilot's single meter and
  // another for Claude's pair.
  const bottom = windows[1] ?? top;
  if (top === undefined || bottom === undefined) {
    return (
      <Glyph>
        <QuietRing dashed={reading.kind === "unread"} />
      </Glyph>
    );
  }
  return (
    <Glyph>
      <SideGauge window={top} mirror={false} />
      <SideGauge window={bottom} mirror />
      <AccountMark account={reading.lead} />
      {windows.map((window, index) => (
        <GlyphNumber
          key={window.id}
          value={window.remaining}
          tone={window.tone}
          y={index === 0 ? STACK.top : STACK.bottom}
        />
      ))}
    </Glyph>
  );
}

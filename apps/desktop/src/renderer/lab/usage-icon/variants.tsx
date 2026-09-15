/**
 * Six candidate glyphs for the usage-limits button (VC-376), drawn from the
 * same reading so they can be compared rather than admired one at a time.
 *
 * THE BOX IS THE ARGUMENT. Every button in the chrome band's command cluster
 * is `size-6` with a `size-3.5` glyph — 24px of target around 14px of drawing.
 * Each variant below renders at whatever size it is handed, but the only size
 * that decides anything is 14, and the stage puts every one of them in a mock
 * band at exactly that size for precisely this reason. A shape that needs 28px
 * to be read has not solved this problem; it has changed it.
 *
 * WHAT THE VARIANTS DISAGREE ABOUT is the second channel — the one Apple's
 * combined icon gets from using three different SHAPES for three different
 * kinds of fact. We have one kind of fact (a percentage left) repeated up to
 * six times, so the second channel has to be invented rather than borrowed:
 *
 *   • `Ring`        — no second channel. The control against which the other
 *                     five have to justify their extra ink.
 *   • `RingDots`    — Apple's literal answer: a row of dots inside the bottom
 *                     of the ring. `dotsMean` switches what a dot counts —
 *                     other ACCOUNTS, or the lead account's own WINDOWS.
 *   • `RingNumber`  — the number in the middle, which is the only variant that
 *                     answers "how much exactly" without a click, and the only
 *                     one whose legibility is in genuine doubt at 14px.
 *   • `SplitRing`   — the ring itself is the second channel: one arc per
 *                     window, cut by gaps. One window fills the circle, three
 *                     make three thirds. Position is by window FAMILY, never
 *                     by value, so a segment means the same thing tomorrow.
 *   • `NestedArcs`  — the ticket's named alternative: one ring per account,
 *                     nearest to running out on the outside.
 *   • `RingNumberDots` — the whole proposal at once: arc, number and dots,
 *                     which needs a taller box than 14 square and therefore
 *                     has to prove it still belongs in the row.
 *
 * COLOUR IS NEVER ALONE. Every variant's primary signal is arc LENGTH, which
 * survives any colour vision; `TONE_STROKE` below is the same three tokens
 * `account-usage.tsx` paints its bars with, taken from the same `usageTone`,
 * so the glyph and the bars cannot reach different verdicts about one snapshot.
 */

import * as React from "react";
import type { UsageTone } from "@volli/shared";

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
 * one. If the ring is adopted, the bars and the ring should be reconciled
 * deliberately rather than left to drift.
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
  return (
    <svg
      width={size}
      height={(size * height) / BOX}
      viewBox={`0 0 ${BOX} ${height}`}
      role="img"
      aria-label={label}
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
 * wall" — and it is the only variant with no legibility risk at all at 14px.
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
 * The choice the stage exists to settle is what is being counted. Other
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
 * and vanishes at 14px.
 *
 * THE GEOMETRY IS TUNED FOR THE MIDDLE rather than inherited. The stroke thins
 * from 2.4 to 2.0 and the radius grows to take up the slack, which buys the
 * figure an 18-unit inner diameter instead of 17.2 — about half a device pixel
 * of extra cap height at 14px. That sounds like nothing, and it is most of the
 * difference between two digits reading and two digits smudging.
 *
 * At 100% the number is dropped: three digits will not fit, and a ring drawn
 * full already says the only thing "100" would add.
 */
const CENTRE_SW = 2;
const CENTRE_R = EDGE - CENTRE_SW / 2;
/** Wide enough for four beads with clearance; the arc keeps the other 290°. */
const CENTRE_NOTCH = 70;
const CENTRE_DOT_D = 1.7;
const CENTRE_DOT_PITCH = ((CENTRE_DOT_D + 0.9) / circumference(CENTRE_R)) * 360;

export function RingCentre({
  reading,
  size,
  label,
  animate,
  dots = "none",
}: GlyphProps & { dots?: "none" | "accounts" | "windows" }) {
  const reported = reading.reported;
  const beads =
    dots === "none" ? [] : dots === "accounts" ? accountDots(reading, 4) : windowDots(reading);
  // The notch is only cut when something stands in it. A ring with a gap and
  // nothing in it looks broken — and it would quietly re-scale the gauge
  // between a one-account profile and a two-account one, so the same 40% would
  // draw two different lengths.
  const notch = beads.length === 0 ? 0 : CENTRE_NOTCH;
  const from = 180 + notch / 2;
  const span = 360 - notch;
  const spread = (beads.length - 1) * CENTRE_DOT_PITCH;
  return (
    <Glyph size={size} label={label}>
      {reported === null ? (
        <QuietRing dashed={reading.kind === "unread"} />
      ) : (
        <>
          <Track r={CENTRE_R} sw={CENTRE_SW} from={from} span={span} />
          <Arc
            r={CENTRE_R}
            sw={CENTRE_SW}
            from={from}
            span={span}
            fill={share(reported)}
            animate={animate}
            className={cn("stroke-current", TONE_STROKE[reported.tone])}
          />
          {beads.map((bead, index) => {
            const point = ringPoint(CENTRE_R, 180 - spread / 2 + index * CENTRE_DOT_PITCH);
            return (
              <circle
                key={bead.key}
                cx={point.x}
                cy={point.y}
                r={CENTRE_DOT_D / 2}
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
          {reported.remaining >= 100 ? null : (
            <text
              x={MID}
              y={MID + 0.2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontWeight={700}
              // Tabular figures so the glyph does not change width between 8
              // and 11, which at this size reads as the icon twitching. The
              // app's sans rather than the mono face: its digits are narrower,
              // and narrower is the entire budget here.
              className={cn(
                "fill-current tabular-nums",
                reported.tone === "normal" ? "text-foreground" : TONE_STROKE[reported.tone],
              )}
            >
              {reported.remaining}
            </text>
          )}
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
 * Three concentric arcs at 14px put roughly 1.2 device pixels of stroke and
 * 0.7 of gap between neighbours, so this is included to be measured, not
 * because it is expected to survive. The specific thing to check is whether
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
 * same ten pixels, which costs the glyph its square box — it is 24×30, so at a
 * 14px width it stands 17.5px tall inside a 24px button. It still fits the
 * target, but it no longer matches the optical height of the ⌘K pill and the
 * sidebar toggle beside it, and that is the thing to judge in the mock band
 * rather than here.
 */
export function RingNumberDots({
  reading,
  size,
  label,
  animate,
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
          {reported.remaining >= 100 ? null : (
            <text
              x={MID}
              y={MID}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={11}
              fontWeight={600}
              className={cn(
                "fill-current font-mono tabular-nums",
                reported.tone === "normal" ? "text-foreground" : TONE_STROKE[reported.tone],
              )}
            >
              {reported.remaining}
            </text>
          )}
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
 * drawn inside the ring are a fifth of that and vanish at 14px.
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
 *     the glyph box instead, so it can be half again as tall.
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
 * 14px, this layout loses half its resolution for nothing.
 */
const APPLE_ARC_SPAN = 180 - APPLE_TOP_HALF - APPLE_BOTTOM_HALF;

export function AppleRing({
  reading,
  size,
  label,
  animate,
  dotsMean = "accounts",
  showNumber = true,
}: GlyphProps & { dotsMean?: "accounts" | "windows"; showNumber?: boolean }) {
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
          {showNumber && reported.remaining < 100 ? (
            // Sat so its cap height starts just below the glyph box's top edge
            // and its baseline lands a shade into the ring's top gap, which is
            // the overlap the reference has. Higher and it draws outside the
            // box; lower and it collides with the two arc ends.
            <text
              x={MID}
              y={4.7}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9.8}
              fontWeight={700}
              className={cn(
                "fill-current tabular-nums",
                tone === "normal" ? "text-foreground" : TONE_STROKE[tone],
              )}
            >
              {reported.remaining}
            </text>
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
 * Every variant above obeys the rule the ticket sets — 24px button, 14px
 * glyph, the same box as every neighbour in the command cluster. This one
 * breaks it on purpose, and it is here so the choice is made with both options
 * visible rather than by discovering halfway through that two digits never had
 * a chance inside a ten-pixel circle.
 *
 * It keeps the ring at exactly 14px and puts the figure BESIDE it at the
 * label size the rest of the app uses, which is the only arrangement on this
 * page where the number is unambiguously readable. What it costs is the row:
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
      role="img"
      aria-label={label}
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
  /** True when the drawing is taller than it is wide. */
  tall?: boolean;
  /**
   * `"pill"` marks a candidate that is its own control rather than a glyph
   * inside the standard 24px icon button — i.e. one that breaks the row.
   */
  chrome?: "icon" | "pill";
}

export const CANDIDATES: readonly Candidate[] = [
  // The three the brief actually asks for come first: bar around, number in
  // the middle, dots below. They differ only in what a dot counts.
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
    bet: "The same two-gap ring with the top gap left empty — what it looks like if the figure does not survive 14px.",
    render: (props) => <AppleRing {...props} dotsMean="accounts" showNumber={false} />,
  },
  {
    id: "ring-beads-windows",
    name: "Beads, no number",
    bet: "The centre variant's ring without the figure — what it looks like if two digits do not survive 14px.",
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
    tall: true,
  },
  {
    id: "ring-pill",
    name: "Ring + number beside it",
    bet: "Breaks the 24px rule on purpose — the only arrangement here where two digits are certainly legible.",
    render: (props) => <RingPill {...props} />,
    chrome: "pill",
  },
];

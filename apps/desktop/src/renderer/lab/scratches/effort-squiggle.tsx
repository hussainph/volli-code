/**
 * The effort slider's SQUIGGLE — the Arc-lineage wave the vibrancy pass
 * (VC-26) was always headed for, landed by VC-57 and taken back out of the
 * shipped control by VC-82. The lab is where it lives now.
 *
 * WHY THIS RIG IS A REPLICA. VC-82 removed the wave from
 * `composer-effort-ui.tsx`, so mounting the real `EffortPill` would show a
 * pill with no wave on it — the thing this scratch exists to keep. Instead the
 * two components below (`EffortPillWithWave`, `EffortSliderWithWave`) are
 * copied verbatim from `composer-effort-ui.tsx` as it stood immediately
 * before VC-82, wave SVG included, and the geometry
 * (`EFFORT_SQUIGGLE_WAVELENGTH`, `EFFORT_SQUIGGLE_AMPLITUDE`,
 * `effortSquigglePath`, `effortSquiggleScale`, and the private `effortTravel`
 * they read) is copied verbatim from `chat/composer-effort.ts` with its
 * original prose. Every other decision — the ramp, the halo, the comb, the
 * elastic ends — is unchanged in the shipped control, which still supplies
 * all the arithmetic this replica renders with. The design and its reasons
 * survive here for as long as the lab does.
 *
 * THE DESIGN, in one paragraph so the feel-check knows what it is checking: a
 * hairline wave rides the pill's free bottom band, clipped at the same seam as
 * the wash, and its AMPLITUDE is the value — absent at the lowest stop (the
 * empty share clips it away), standing taller stop by stop to full wave at
 * `max`. It is a redundant channel on purpose (the seam and the grip already
 * carry the value), so it is quieter than the comb (`/40` against `/50`) and
 * it does not drift: the only motion is the amplitude changing, and only
 * because the value changed. Ignite's rejection is the precedent — a control
 * must report the gesture, not decorate it.
 *
 * WHAT TO WATCH
 *
 *  1. **Drag from `off`/`minimal` to `max` slowly.** The wave should stand up
 *     under the seam as it sweeps — one substance getting agitated, never a
 *     second object arriving. The second stop is the real floor of the ramp
 *     (index 0 is clipped away with its empty share) — judge whether it
 *     separates from the third.
 *  2. **Descenders.** The wave's peaks reach ~3px into the tail of the
 *     labels' line box — descender space. Watch the `g` in `High` and
 *     `Extra high` at the stops where the seam has crossed them.
 *  3. **Seven stops** (`opus-4.6`): adjacent stops should still differ — the
 *     amplitude ramp is linear for the same reason the mix's is.
 *  4. **Reduced motion**: the wave still STANDS (it is state, not motion); only
 *     its transitions go instant.
 */
import * as React from "react";
import { CaretUpDownIcon, GaugeIcon } from "@phosphor-icons/react";
import { REASONING_LEVELS, type ReasoningLevel } from "@volli/shared";

import {
  EFFORT_DEAD_ZONE,
  EFFORT_STRETCH_LIMIT,
  effortChroma,
  effortGlow,
  effortIndex,
  effortLabel,
  effortStopPercent,
  effortWashMix,
  readEffortPointer,
} from "@renderer/chat/composer-effort";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

export const title = "Effort squiggle · amplitude as magnitude";
export const note = "The VC-57 wave, kept alive in the lab: wave height is the value";
export const viewport = "stage" as const;

/* ------------------------------------------------------- the wave's geometry */

/**
 * Where a stop sits on the ramp: 0 at the first, 1 at the last.
 *
 * A one-stop set reads as the TOP rather than as 0/0, and that is not the same
 * clamp {@link effortStopPercent} makes: a lone stop has nowhere to sit on a
 * track, so it is drawn at the left end — but it has nothing to be less vibrant
 * *than*, and a lone control painted at the dimmest end would read as disabled.
 */
function effortTravel(index: number, stops: number): number {
  const last = stops - 1;
  if (last <= 0) return 1;
  return Math.min(last, Math.max(0, index)) / last;
}

/* ---------------------------------------------------------------- squiggle */

/**
 * One full wave of the squiggle, in px (VC-57, the Arc-lineage wave).
 *
 * 12px puts a crest roughly every 6px — dense enough that the wave reads as a
 * texture of the filled share rather than as a drawn curve with a countable
 * number of bumps, and comfortably off the notch pitch (32–112px depending on
 * the stop count) so crests never look like they are trying to be ticks.
 */
const EFFORT_SQUIGGLE_WAVELENGTH = 12;

/**
 * The wave's peak, in px from its centreline, at full effort.
 *
 * 2px around a centreline at y≈23 of the 28px pill, so the peaks span
 * y 21–25 — the top ~3px of that travel sits inside the tail of the labels'
 * line box (y 4–24), which is descender territory rather than clear air.
 * Enough travel that the flattening ramp below is legible across seven stops,
 * low enough that only a descender (the `g` in "High") can meet it.
 */
const EFFORT_SQUIGGLE_AMPLITUDE = 2;

/**
 * The squiggle's geometry: a wave along `y = 0`, one SVG path string.
 *
 * Alternating quadratic half-waves — an explicit `Q` for the first and `T`
 * (smooth-quadratic, which reflects the previous control point) for the rest,
 * so the whole wave after the opening segment is one coordinate per half-wave
 * and cannot kink. The control point sits at `2 × amplitude` because a
 * quadratic's midpoint takes half its control's offset — that is what makes
 * `amplitude` the PEAK rather than a number near it.
 *
 * The wave runs to the first half-wave boundary AT or past `width` rather than
 * stopping short: the drawer clips it with the same seam that clips the wash,
 * so overshooting costs nothing and undershooting would leave the last stop's
 * share bare. Degenerate inputs (an unmeasured rail, a zero wavelength) return
 * the empty path rather than dividing by themselves.
 */
function effortSquigglePath(width: number, wavelength: number, amplitude: number): string {
  if (width <= 0 || wavelength <= 0) return "";
  const half = wavelength / 2;
  const crest = amplitude * 2;
  const segments = Math.max(1, Math.ceil(width / half));
  const parts = [`M 0 0 Q ${half / 2} ${crest} ${half} 0`];
  for (let at = 2; at <= segments; at += 1) parts.push(`T ${at * half} 0`);
  return parts.join(" ");
}

/**
 * How much of the wave's amplitude is standing at a given stop: 0 flat, 1
 * full. The 0 is never SEEN, though — the drawer clips the wave at the wash's
 * seam, and at the lowest stop the filled share is 0% wide, so the flat wave
 * is clipped away with it. The observable ramp starts at the second stop, at
 * `1/(stops-1)` of the amplitude; index 0 reads as no wave, which is the same
 * statement.
 *
 * LINEAR, like the mix and the chroma and unlike the halo's square, because it
 * is the same kind of channel they are: read by comparison between neighbour
 * stops, so every adjacent pair has to differ and a straight line is the only
 * curve that guarantees it. Drawn as a `scaleY` on the path — the one property
 * that can TRANSITION between two amplitudes; regenerating the path snaps,
 * because Chromium does not interpolate `d` — with `non-scaling-stroke` holding
 * the ink's weight while the geometry flattens. A single-stop set stands at
 * full amplitude for the wash's reason: it has nothing to be calmer *than*,
 * and a lone control drawn flat would read as disabled.
 */
function effortSquiggleScale(index: number, stops: number): number {
  return effortTravel(index, stops);
}

interface EffortPillWithWaveProps {
  /** The selected model's own stop set, in its own order. Never invented here. */
  levels: readonly string[];
  value: string;
  onChange(level: string): void;
  /** Model policy is immutable during an active turn, and effort is part of it. */
  disabled?: boolean;
}

/**
 * `⌾ High ⌄` — the chip, and the slider it opens above itself.
 *
 * A popover rather than an inline expansion, so the footer row never reflows
 * under the reader's hand: the chip is a fixed object beside the model pill and
 * the whole control appears over it. Changing effort deliberately leaves the
 * popover up — it is a smaller decision than picking a model, and it is the one
 * you take a second look at.
 */
function EffortPillWithWave({
  levels,
  value,
  onChange,
  disabled = false,
}: EffortPillWithWaveProps) {
  const [open, setOpen] = React.useState(false);
  const railRef = React.useRef<HTMLDivElement>(null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled}
          aria-label={`Reasoning effort: ${effortLabel(value)}`}
          className={cn("min-w-0 text-muted-foreground", open && "bg-accent text-foreground")}
        >
          {/* `bold`, not the outline default and not `fill`. Checked at 12px on
              the footer's resting dim: Gauge is arcs and a needle, and regular
              draws lighter than the 13px label beside it at this size — the
              exact case the house rule answers with bold's flat 1.50x, since
              coverage is scale-invariant and a bigger `size-*` could not fix
              it. `fill` would be wrong for the other reason: this chip is one
              of two peers in a control row, not the exception among them. */}
          <GaugeIcon className="size-3 shrink-0" weight="bold" />
          <span className="min-w-0 truncate">{effortLabel(value)}</span>
          <CaretUpDownIcon className="size-3 shrink-0" weight="bold" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-auto p-3"
        onOpenAutoFocus={(event) => {
          // The rail is the reason this opened. Radix's default parks focus on
          // the content box, where the first arrow key would do nothing.
          event.preventDefault();
          railRef.current?.focus();
        }}
      >
        <EffortSliderWithWave
          railRef={railRef}
          levels={levels}
          value={value}
          onChange={onChange}
          onDismiss={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * How far apart the notches are dealt in when the popover opens.
 *
 * 35ms: fast enough that seven of them finish inside 400ms — under the window
 * where a staggered entrance stops reading as one gesture and starts reading as
 * a queue — and slow enough that the order is legible rather than simultaneous.
 * A stylesheet cannot express this, because the delay is a function of a tick's
 * index and the index is data.
 */
const EFFORT_NOTCH_STAGGER_MS = 35;

/**
 * The halo, at full strength. How much of it is on is the ramp's job
 * ({@link effortGlow}); this is only its shape.
 *
 * Two shadows because one cannot be both. The tight one is the heat at the
 * pill's own edge and the wide one is the room lighting up around it; a single
 * radius wide enough to reach the popover is too diffuse to read as coming FROM
 * anything, and one tight enough to read is a rim light nobody calls a glow.
 * Both are `--primary` at the chroma the canvas derived — the halo is the one
 * place in this control where the accent is never desaturated, because it is
 * the only place nothing is legible through it.
 */
const EFFORT_HALO_SHADOW = [
  "0 0 12px oklch(from var(--primary) l c h / 0.6)",
  "0 0 30px 6px oklch(from var(--primary) l c h / 0.38)",
].join(", ");

/**
 * The rail's fixed width — `w-56` on the slider root, the one place the pill's
 * geometry is authored — which is what lets the squiggle's path be baked once
 * per mount instead of measured. The elastic overdrag scales the pill and the
 * wave stretches with it, which is what material doing the stretching should do.
 */
const EFFORT_PILL_WIDTH = 224;

/** How far the pill can be pulled past a dead zone before it stops giving. */
function stretchLimit(reduced: boolean): number {
  // Reduced motion drops elastic and overshoot; it does not drop *aim*, so the
  // dead zones stay. One number turns the whole elasticity off, which is why
  // the geometry takes it as a parameter rather than reading the media query.
  return reduced ? 0 : EFFORT_STRETCH_LIMIT;
}

/**
 * The control: one focusable node with real slider semantics.
 *
 * NOT N buttons. `role="slider"` with `aria-valuenow`/`aria-valuetext` is what
 * lets a screen reader say "Reasoning effort, High, 4 of 7", and it is the
 * direct repair of the arrangement this replaces. It is also the bigger target
 * — the whole pill is hittable and snaps to the nearest stop, where seven
 * segments were seven small ones.
 *
 * The pill carries its own name at the left and its value at the right, with
 * the filled share sweeping *under* both: at any stop the control reads as one
 * sentence rather than as a track with a caption. The notch marks are the
 * interior stops only — the pill's two ends are the first and last stops, and
 * a hairline drawn on top of a rounded cap is a smudge, not a tick.
 */
function EffortSliderWithWave({
  levels,
  value,
  onChange,
  onDismiss,
  railRef,
}: {
  levels: readonly string[];
  value: string;
  onChange(level: string): void;
  onDismiss(): void;
  railRef: React.RefObject<HTMLDivElement | null>;
}) {
  const reduced = useReducedMotion();
  const [dragging, setDragging] = React.useState(false);
  // The elastic pull, held as what it draws. `anchor` is sticky across the
  // release so the spring-back runs from the end that was actually pulled —
  // resetting it with the scale would snap the origin to the pill's middle
  // half way through the animation and the return would come from nowhere.
  const [pull, setPull] = React.useState<{ scaleX: number; anchor: "left" | "right" }>({
    scaleX: 1,
    anchor: "left",
  });

  const stops = levels.length;
  const last = stops - 1;
  const index = effortIndex(levels, value);
  const filled = effortStopPercent(index, stops);
  // The ramp, drawn once: one colour stop per EFFORT stop, each at its own
  // notch. Nothing here depends on the value — the value is the clip below —
  // which is what lets the reveal transition at all (Chromium interpolates
  // `clip-path` and does not interpolate a gradient, checked in the browser).
  //
  // Read the expression inside out: mix the accent into the pill's own unfilled
  // colour, which puts the LIGHTNESS somewhere the labels can stand in either
  // appearance; then read that colour back and multiply its CHROMA, which the
  // labels cannot feel. Both moves are on the ramp, so the wash walks from the
  // groove barely warmed to a saturated ember. See `chat/composer-effort.ts`.
  const ramp = levels
    .map((_, at) => {
      const mix = (effortWashMix(at, stops) * 100).toFixed(2);
      const chroma = effortChroma(at, stops).toFixed(3);
      const accent = `color-mix(in oklab, var(--primary) ${mix}%, var(--border-strong))`;
      return `oklch(from ${accent} l calc(c * ${chroma}) h) ${effortStopPercent(at, stops)}%`;
    })
    .join(", ");
  const commit = (next: number): void => {
    const level = levels[Math.min(last, Math.max(0, next))];
    if (level !== undefined && level !== value) onChange(level);
  };

  const track = (rail: HTMLDivElement) => ({
    width: rail.getBoundingClientRect().width,
    stops,
    deadZone: EFFORT_DEAD_ZONE,
    stretchLimit: stretchLimit(reduced),
  });

  const follow = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rail = railRef.current;
    if (rail === null) return;
    const reading = readEffortPointer(
      event.clientX - rail.getBoundingClientRect().left,
      track(rail),
    );
    commit(reading.index);
    setPull((current) =>
      reading.stretch === 0
        ? current.scaleX === 1
          ? current
          : { ...current, scaleX: 1 }
        : { scaleX: reading.scaleX, anchor: reading.stretch < 0 ? "right" : "left" },
    );
  };

  const release = (): void => {
    setDragging(false);
    setPull((current) => ({ ...current, scaleX: 1 }));
  };

  return (
    <div
      ref={railRef}
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={effortLabel(value)}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        "group/rail relative w-56 shrink-0 cursor-pointer touch-none select-none outline-none",
        "data-[dragging]:cursor-grabbing",
      )}
      onPointerDown={(event) => {
        // A secondary button is a context menu, and a second pointer mid-drag
        // is a finger swap that would teleport the value.
        if (event.button !== 0 || dragging) return;
        event.preventDefault();
        railRef.current?.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        // macOS: pressing the track jumps to where you pressed, and the same
        // press continues as a drag. One gesture, not two.
        follow(event);
      }}
      onPointerMove={(event) => {
        if (dragging) follow(event);
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        release();
      }}
      onPointerCancel={release}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // The app's Esc guard reads a bare Escape as "leave the surface".
          // Closing a control you opened is not leaving anything — the
          // composer's `/` picker makes the same call. Radix returns focus to
          // the trigger on close, so the keyboard lands where it started.
          event.stopPropagation();
          onDismiss();
          return;
        }
        const next =
          event.key === "ArrowLeft" || event.key === "ArrowDown"
            ? index - 1
            : event.key === "ArrowRight" || event.key === "ArrowUp"
              ? index + 1
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : null;
        if (next === null) return;
        event.preventDefault();
        commit(next);
      }}
    >
      {/* THE HALO — the vibrancy that is not spent on the labels.
          Everything inside the pill is capped by the two words lying on it: the
          wash can only thicken as far as `--foreground` stays at AA over it,
          which is measured and is not far. Outside the pill nothing is legible
          through anything, so this is where the accent runs at full chroma and
          the ramp can go all the way — at `max` the control lights the popover
          it is sitting in, and at the bottom of the range it is not there.

          IT IS BEHIND THE PILL, WHICH IS WHY IT IS FREE. `bg-border-strong` is
          opaque, so only the spill past the pill's edge is ever seen and not
          one pixel of this composites under a label: the contrast table upstairs
          stays true whatever this does. Sitting outside also gets it past the
          pill's `overflow-hidden`, which a glow drawn on the handle could never
          escape.

          IT HUGS THE FILLED SHARE rather than the whole pill — same width as the
          wash, so the light and the substance are the same object seen twice,
          and the seam is a hot edge rather than the middle of a lit box.

          AND IT DOES NOT STRETCH. The pill's elastic overdrag is the material
          giving; light is not material, and a 7px slip inside a 30px blur is
          not a thing anyone can see. Leaving the pull off it keeps the halo's
          own transition free to run at the wash's duration instead of being
          switched off mid-drag with the stretch. */}
      <span
        aria-hidden
        data-slot="effort-halo"
        style={{
          width: `${filled}%`,
          opacity: effortGlow(index, stops),
          boxShadow: EFFORT_HALO_SHADOW,
        }}
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 rounded-full",
          "transition-[width,opacity] duration-150 ease-out",
          "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none!",
        )}
      />

      <div
        style={{ scale: `${pull.scaleX} 1`, transformOrigin: `${pull.anchor} center` }}
        className={cn(
          // `--border-strong` unfilled and the accent filled: the same two
          // tokens `globals.css` paints `input[type="range"]` with, so this
          // reads as the object the app already ships rather than as a second
          // slider language. It is also the wash's own floor — the ramp mixes
          // the accent INTO this colour, so the filled and unfilled halves are
          // two points on one line rather than two decisions. `bg-muted` was
          // tried first and is 2 RGB steps off `--popover` on this canvas —
          // measured, and the pill's empty half simply disappeared into the
          // surface holding it.
          "relative flex h-7 items-center overflow-hidden rounded-full bg-border-strong",
          // The pill, not the rail, wears the keyboard ring: it is the object
          // the eye reads as the control, and a ring on the untransformed rail
          // would sit still while the pill stretched out through it.
          "group-focus-visible/rail:ring-2 group-focus-visible/rail:ring-ring/45",
          // 1:1 WHILE DRAGGING. A transition on the stretch is lag against a
          // finger that is already there; the spring back on release is the
          // only part that animates, and `--ease-out` is a hard decelerate, so
          // it reads as the material settling rather than as a second gesture.
          "transition-[scale] duration-200 ease-out",
          "group-data-[dragging]/rail:transition-none motion-reduce:transition-none!",
        )}
      >
        {/* The filled share, swept under the text rather than beside it — and
            the ramp itself, painted rather than merely reached.

            THE WHOLE RAMP IS ALWAYS THERE; THE VALUE IS HOW MUCH OF IT IS
            SHOWING. The gradient is laid across the FULL pill with one colour
            stop per effort stop, each sitting on its own notch, and the value
            clips it at the seam. So a single state carries the magnitude twice:
            the wash reaches further AND the colour under the value's own end of
            it holds more of the accent. The flat fill this replaces could only
            ever say it across TIME, while dragging — at rest it was one tone
            that meant nothing without the previous one to compare it to.

            The seam is therefore never an arbitrary colour: clipped at stop `n`
            the leading edge is exactly the stop the notch is on
            ({@link effortWashMix}`(n)` at {@link effortChroma}`(n)`), and at the
            top of the range it is a saturated ember rather than the brown a
            half-transparent accent over a grey track can ever be.

            DERIVED FROM LIVE TOKENS, NEVER AUTHORED. Both ends of the mix are
            variables — the accent the canvas engine derived for this scope and
            the pill's own unfilled colour — so a project that reseeds its
            accent reseeds this ramp with it, and the floor is the control's own
            groove rather than a colour someone picked to sit near it. A
            hand-mixed hex here would be the one colour in the app the theme does
            not own.

            AND IT SPENDS THE TWO CHANNELS SEPARATELY, WHICH IS THE WHOLE
            VIBRANCY. Mixing sets the LIGHTNESS, toward the track, which is the
            only direction that is safe in both appearances; the `calc(c * …)`
            then sets the CHROMA on top of that lightness, where the labels
            cannot feel it. Alpha could not do that — it moves both at once, and
            that is why the wash it painted had no headroom left to be bright
            with. {@link EFFORT_MIX_FLOOR} carries the measurements and the
            margin.

            CLIPPED, NOT RESIZED, and that is what makes the paint free. The
            gradient never changes, so the box is rastered once and the stop
            change moves a `clip-path` — the one channel Chromium interpolates
            here at all (a `background-image` between two gradients snaps to the
            new one, checked in the browser), and the reason the ramp can be a
            gradient and still animate. */}
        <span
          data-slot="effort-wash"
          style={{
            backgroundImage: `linear-gradient(to right, ${ramp})`,
            clipPath: `inset(0 ${100 - filled}% 0 0)`,
          }}
          className={cn(
            "absolute inset-0",
            "transition-[clip-path] duration-150 ease-out",
            // Shorter under the hand: 150ms reads as a snap when you click a
            // stop and as drag lag when you sweep through five of them.
            "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none!",
          )}
        />

        {/* THE SQUIGGLE — the magnitude, drawn as agitation rather than only as
            reach and warmth.

            IT LIVES IN THE BOTTOM BAND, for the comb's own reason mirrored:
            the text's line box owns the middle 20px of the 28px pill (y 4–24),
            the comb owns the top edge, and a wave through either would read
            as a rendering fault. The box below (`bottom-0.5 h-1.5`) spans
            y 20–26, so the peaks ride y 21–25 — the top of that travel sits
            ~3px inside the line box's tail, which is descender space: only a
            glyph like the `g` in "High" dips there, and a hairline at `/40`
            under a descender is the human feel-check's first watch item, not
            a collision the geometry rules out.

            IT IS CLIPPED AT THE SEAM, by the same inset the wash uses and on
            the same clock, so the wave and the wash are one substance seen
            twice — the wave never runs ahead of the colour or lags it.

            THE VALUE IS THE AMPLITUDE, via `scaleY` on the path rather than a
            regenerated `d`: Chromium interpolates a transform and does not
            interpolate a path, so scale is the one channel on which two
            amplitudes can meet mid-gesture (`effortSquiggleScale` above carries the
            ramp). `non-scaling-stroke` holds the ink at hairline weight while
            the geometry flattens — without it the wave would thin toward the
            bottom of the range and vanish before it arrived. `fill-box` makes
            the scale's origin the wave's own centreline, which is what lets it
            flatten in place instead of sagging toward an edge.

            AND IT DOES NOT DRIFT. An ambient phase-scroll while dragging was
            considered and refused on Ignite's precedent: continuous motion
            under the hand decorates the gesture rather than reporting it, and
            the grip already answers being gripped. The only thing that moves
            here is the amplitude, and only because the value moved. */}
        <svg
          aria-hidden
          data-slot="effort-squiggle"
          viewBox={`0 ${-(EFFORT_SQUIGGLE_AMPLITUDE + 1)} ${EFFORT_PILL_WIDTH} ${
            2 * (EFFORT_SQUIGGLE_AMPLITUDE + 1)
          }`}
          preserveAspectRatio="none"
          style={{ clipPath: `inset(0 ${100 - filled}% 0 0)` }}
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0.5 h-1.5",
            "transition-[clip-path] duration-150 ease-out",
            "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none!",
          )}
        >
          <path
            d={effortSquigglePath(
              EFFORT_PILL_WIDTH,
              EFFORT_SQUIGGLE_WAVELENGTH,
              EFFORT_SQUIGGLE_AMPLITUDE,
            )}
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeWidth={1.5}
            strokeLinecap="round"
            style={{
              transform: `scaleY(${effortSquiggleScale(index, stops)})`,
              transformBox: "fill-box",
              transformOrigin: "center",
            }}
            className={cn(
              // `/40`: a redundant channel — the seam and the grip already say
              // the value — so it sits a rung under the comb's resting `/50`
              // and reads as texture of the wash rather than as a second comb.
              "stroke-foreground/40",
              "transition-transform duration-150 ease-out",
              "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none!",
            )}
          />
        </svg>

        {/* Interior stops only — the pill's own ends are the first and last,
            and a hairline drawn on a rounded cap is a smudge, not a tick.

            A COMB ALONG THE TOP EDGE, not marks down the middle. Centred ticks
            were tried first and, at seven stops on a 224px pill, two of the
            five land under `Effort` and under a long value: checked in the
            browser, the first one draws a vertical bar straight through the
            word, which reads as a rendering fault rather than as a notch. The
            text's line box is the middle 20px, so a 4px mark inset 4px from
            the top clears every glyph at every stop count and the notches can
            finally all be counted.

            `data-passed` IS THE VIBRANCY RAMP'S BILL, AND IT IS EXACTLY TWO
            GROUNDS. A tick is passed precisely when it is behind the seam, so a
            passed one stands on the wash and an unpassed one stands on the
            groove — never the other way round. One ink cannot serve both: at
            `/50`, which the groove needs (3.58:1 dark, 3.10:1 light), a rung on
            the top of the wash reads 2.34:1 dark and 2.85:1 light, under the 3:1
            a non-text mark is owed. At `/90` the same rung reads 4.40:1 dark and
            6.75:1 light. So a passed tick takes a rung up, which is also the
            honest reading: the ones behind the grip have been crossed. */}
        {/* AND THEY DROP IN, LEFT TO RIGHT, WHEN THE POPOVER OPENS. The comb is
            the only thing on this control that says the axis has STOPS rather
            than a range, and at rest it is five hairlines nobody reads. Dealt
            in — 180ms each, 35ms apart, growing down from the top edge they
            hang off — the count is delivered as a fact instead of waiting to be
            noticed, and the direction is the axis's own.
            {@link EFFORT_NOTCH_STAGGER_MS} carries the delay, because the
            stagger is per-tick data and a stylesheet cannot know an index.
            The animation runs on mount, which is exactly once per opening:
            Radix unmounts the popover's content on close. */}
        {levels.slice(1, -1).map((level, at) => (
          <span
            key={level}
            data-slot="effort-tick"
            data-passed={index >= at + 1 ? "" : undefined}
            style={{
              left: `${effortStopPercent(at + 1, stops)}%`,
              animationDelay: `${at * EFFORT_NOTCH_STAGGER_MS}ms`,
            }}
            className={cn(
              "absolute top-1 h-1 w-px origin-top rounded-full bg-foreground/50",
              "transition-colors duration-150 ease-out motion-reduce:transition-none!",
              "data-[passed]:bg-foreground/90",
              "animate-[effort-notch_180ms_var(--ease-out)_both] motion-reduce:animate-none!",
            )}
          />
        ))}

        {/* A noun and its value, and nothing else. The ticks say how many stops
            there are and the wash says which one you are on, so a third readout
            would be a third voice saying what two already say better. */}
        {/* BOTH HALVES IN FULL INK, and the noun lost its muted tier to get
            there. It sits ON the wash, which is a mid-tone in both appearances
            — so `--muted-foreground`, a tier solved for the app's own quiet
            surfaces, has no relationship at all with the ground it landed on
            here. Measured over the wash at both ends of the ramp: the muted noun
            reads 4.67 → 3.30:1 in dark and 4.28 → 3.55:1 in light, under AA
            across most of the track rather than at one end of it. At
            `--foreground` the same label reads 7.14 → 5.05:1 and 9.13 → 7.58:1.
            Muting it was buying hierarchy with legibility, on the one word that
            says what the control IS.

            The hierarchy is flatter now and that is the accepted cost. It is a
            small one, because the label was never carrying the hierarchy:
            POSITION was. A noun pinned left and a value pinned right are read
            as a sentence, not as two peers competing, and the wash sweeps under
            both to say which of them is the variable. */}
        <span className="pointer-events-none relative flex min-w-0 flex-1 items-center justify-between gap-2 px-3 text-ui">
          <span className="shrink-0 text-foreground">Effort</span>
          <span className="min-w-0 truncate text-foreground">{effortLabel(value)}</span>
        </span>

        {/* THE GRIP. The seam between filled and unfilled was the value, and it
            was also nothing you could reach for: a colour boundary is a reading,
            not a handle. This is the handle — a short bar riding that seam, the
            thing the wash sweeps up to and the thing the hand aims at.

            IT TRAVELS ON `transform`, WITHOUT MEASURING ANYTHING. The mover is
            `w-full` inside the inset track, so `translateX(%)` resolves against
            the TRACK's width rather than the bar's — the one percentage trick
            that turns a position into a compositor property with no
            `ResizeObserver` behind it. Animating `left` would have worked and
            would have repainted the pill on every stop of a sweep.

            THE INSET IS WHY IT NEVER SMEARS. The track is inset 4px from both
            caps, so at the first and last stops the bar's centre stops 4px
            short of a 14px radius instead of riding into the curve and being
            sliced by `overflow-hidden`. The wash still fills to the true edge —
            the pill reads full at max, and the grip sits just inside it, which
            is where a grip at the end of its travel belongs.

            IT IS LAST, so it paints over the two labels rather than under them.
            At a middle stop the bar lands inside `Effort` or inside a long
            value — it has to, it is the value's position and cannot move to
            avoid a word. Under the text it read as a bar sliced by a letter,
            which looks like a rendering fault; over the text it reads as what
            it is, an object lying across a printed label. */}
        <span
          aria-hidden
          data-slot="effort-handle-track"
          className="pointer-events-none absolute inset-x-1 inset-y-0"
        >
          <span
            data-slot="effort-handle-mover"
            style={{ transform: `translateX(${filled}%)` }}
            className={cn(
              "absolute inset-y-0 left-0 w-full",
              "transition-transform duration-150 ease-out",
              "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none!",
            )}
          >
            <span
              data-slot="effort-handle"
              className={cn(
                "absolute top-1/2 left-0 h-5 w-1 -translate-x-1/2 -translate-y-1/2",
                "rounded-full bg-foreground shadow-raised",
                // THE GRIP ANSWERS BEING GRIPPED, and it answers loudly: twice
                // as wide, a sixth taller, and wearing a soft ring while the
                // pointer is down. A 4px bar swelling to 6px was the polite
                // version and it was invisible under the finger that caused it
                // — press feedback is the one tier where the whole job is
                // confirming the control heard the hand, so it has to survive
                // being covered by that hand.
                //
                // THE RING IS WHY IT LIFTS. Width alone reads as the bar
                // getting fatter; a halo around it reads as the bar coming off
                // the track, which is what a held grip does. It rides the
                // `scale` with the bar — a box-shadow is drawn in the scaled
                // box — so the halo stretches with the swell rather than
                // sitting on it as a separate object.
                //
                // ONCE PER GESTURE, for free: `data-dragging` arrives on
                // pointer-down and leaves on release, so the swell and the
                // spring back are the two edges of one attribute.
                "transition-[scale,box-shadow] duration-150 ease-out",
                "group-data-[dragging]/rail:scale-x-200 group-data-[dragging]/rail:scale-y-115",
                "group-data-[dragging]/rail:ring-3 group-data-[dragging]/rail:ring-foreground/30",
                "motion-reduce:scale-100! motion-reduce:ring-0! motion-reduce:transition-none!",
              )}
            />
          </span>
        </span>
      </div>
    </div>
  );
}

interface FixtureModel {
  id: string;
  label: string;
  levels: readonly ReasoningLevel[];
  seed: ReasoningLevel;
}

/** The same four stop-set shapes the original effort rig stressed. */
const MODELS: readonly FixtureModel[] = [
  {
    id: "sonnet-4.5",
    label: "sonnet-4.5 · 3 stops",
    levels: ["low", "medium", "high"],
    seed: "medium",
  },
  {
    id: "haiku-4.5",
    label: "haiku-4.5 · 4 stops with Off",
    levels: ["off", "low", "medium", "high"],
    seed: "low",
  },
  {
    id: "gpt-5.6-luna",
    label: "gpt-5.6-luna · 5 stops",
    levels: ["minimal", "low", "medium", "high", "xhigh"],
    seed: "medium",
  },
  { id: "opus-4.6", label: "opus-4.6 · all 7", levels: REASONING_LEVELS, seed: "high" },
];

function FixtureRow({ model }: { model: FixtureModel }) {
  const [level, setLevel] = React.useState<string>(model.seed);
  return (
    <section className="flex items-center gap-4">
      <span className="w-56 shrink-0 text-ui text-muted-foreground">{model.label}</span>
      <EffortPillWithWave levels={model.levels} value={level} onChange={setLevel} />
    </section>
  );
}

export default function EffortSquiggleScratch() {
  return (
    <div className="flex flex-col gap-6 pb-16">
      <p className="text-ui text-muted-foreground">
        Open each pill and drag: the wave under the labels stands with the value — flat at the
        bottom of the range, full at <span className="text-foreground">Max</span> — and is clipped
        at the same seam as the wash.
      </p>
      {MODELS.map((model) => (
        <FixtureRow key={model.id} model={model} />
      ))}
    </div>
  );
}

/**
 * Reasoning effort, as a chip that opens a notched slider.
 *
 * WHY IT IS NOT IN THE MODEL POPOVER ANY MORE. Effort used to be a segmented
 * pill rendered inside the *selected row* of the model list — two levels deep,
 * invisible until opened, and wider than the popover holding it once a model
 * offered more than four levels. It was also seven `aria-pressed` buttons
 * nested inside a `cmdk` listbox option, held together by a `stopPropagation`.
 * Model is a decision you make once; effort is a decision you make per task.
 * The volatile one is a peer of the durable one now, in the footer, where it
 * can be read without opening anything.
 *
 * WHY A SLIDER RATHER THAN SEGMENTS. Effort's whole meaning is *more or less
 * than the thing next to it*, and a row of equal-weight words encodes set
 * membership rather than magnitude. The stop count is 3–7 depending on the
 * model, which is exactly where a segmented control stops fitting and a track
 * stops caring. The discrete semantics survive intact — this snaps to stops,
 * never renders a level the harness would refuse, and re-clamps when the model
 * changes ({@link reclampEffort}) — so it is a notched slider, not a continuous
 * one pretending the levels are a range.
 *
 * WHAT MAKES IT FEEL LIKE ANYTHING. Three things, and only the first is
 * visible:
 *
 *  - **A pointer range wider than the drawn track**, with a dead zone at each
 *    end, so the two stops people reach for most never need pixel-perfect aim.
 *  - **Elastic ends.** Pull past a dead zone and the pill itself stretches on
 *    Apple's resistance curve, giving less the harder it is pulled, and springs
 *    back on release. The value never moves; the limit becomes something the
 *    hand already on the control can feel before the eye checks.
 *  - **A 1:1 grip.** The stretch is applied straight from the pointer with no
 *    transition on it, so it is glued to the finger; the *snap* keeps its
 *    transition, and shortens while dragging so the wash never lags the hand.
 *
 * The arithmetic behind all three is in `chat/composer-effort.ts`, tested
 * without a DOM. This file is the drawing and the events.
 *
 * TWO MOTION IDEAS WERE TRIED IN THE LAB AND ONE MORE WAS REJECTED THERE.
 * `lab/scratches/composer-redesign.tsx` mounted three CSS-only variants over
 * this exact component, hung off attributes it already publishes. **Grip** (the
 * handle swelling and taking a halo while held) and **Cascade** (the notches
 * dealt in left to right on open) are shipped below and no longer have toggles.
 * **Ignite** — every notch flaring as the wash crosses it — stays in the lab: it
 * fires on a *sweep*, so dragging through five stops set off five flares in a
 * row, and a control that sparkles while you use it is decorating the gesture
 * rather than reporting it. All three obeyed the same house rules the shipped
 * pair still obeys: compositor properties only, `--ease-out`, nothing that
 * moves layout, and a `motion-reduce` gate that switches the idea off rather
 * than shortening it.
 */
import * as React from "react";
import { CaretUpDownIcon, GaugeIcon } from "@phosphor-icons/react";

import {
  EFFORT_DEAD_ZONE,
  EFFORT_STRETCH_LIMIT,
  effortChroma,
  effortIndex,
  effortLabel,
  effortStopPercent,
  readEffortPointer,
} from "@renderer/chat/composer-effort";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

export interface EffortPillProps {
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
export function EffortPill({ levels, value, onChange, disabled = false }: EffortPillProps) {
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
        <EffortSlider
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
function EffortSlider({
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

  const last = levels.length - 1;
  const index = effortIndex(levels, value);
  const commit = (next: number): void => {
    const level = levels[Math.min(last, Math.max(0, next))];
    if (level !== undefined && level !== value) onChange(level);
  };

  const track = (rail: HTMLDivElement) => ({
    width: rail.getBoundingClientRect().width,
    stops: levels.length,
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
        "group/rail w-56 shrink-0 cursor-pointer touch-none select-none outline-none",
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
      <div
        style={{ scale: `${pull.scaleX} 1`, transformOrigin: `${pull.anchor} center` }}
        className={cn(
          // `--border-strong` unfilled and `--primary` filled: the same two
          // tokens `globals.css` paints `input[type="range"]` with, so this
          // reads as the object the app already ships rather than as a second
          // slider language. `bg-muted` was tried first and is 2 RGB steps off
          // `--popover` on this canvas — measured, and the pill's empty half
          // simply disappeared into the surface holding it.
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
            the ramp: it gets more SATURATED the further it reaches
            ({@link effortChroma}), so magnitude is carried by substance as well
            as by length. A warm grey at the bottom of the range, the accent at
            full strength at the top.

            DERIVED FROM THE LIVE TOKEN, NEVER AUTHORED. `oklch(from
            var(--primary) …)` reads whatever the canvas engine derived for this
            scope and moves one channel of it, so a workspace that reseeds its
            accent reseeds this ramp with it. A hand-mixed hex here would be the
            one colour in the app the theme does not own.

            AND IT MOVES THE CHANNEL THAT COSTS NOTHING. `l` and `h` are held;
            only `c` scales — so every rung has the same perceptual lightness,
            and contrast, which is a lightness relationship, barely moves. The
            alpha version of this ramp was built first and measured at 2.90:1 in
            dark against 6.33:1 in light, i.e. an AA failure in one appearance
            only. See {@link EFFORT_CHROMA_FLOOR} for the full numbers.

            `background-color` is a paint rather than a compositor property, and
            that is accepted here rather than worked around with a second
            stacked layer: this element is already transitioning its `width`, so
            it repaints on every stop regardless, and the painted box is 224×28. */}
        <span
          data-slot="effort-wash"
          style={{
            width: `${effortStopPercent(index, levels.length)}%`,
            backgroundColor: `oklch(from var(--primary) l calc(c * ${effortChroma(index, levels.length)}) h / 0.5)`,
          }}
          className={cn(
            "absolute inset-y-0 left-0",
            "transition-[width,background-color] duration-150 ease-out",
            // Shorter under the hand: 150ms reads as a snap when you click a
            // stop and as drag lag when you sweep through five of them.
            "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none!",
          )}
        />

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

            `data-passed` IS THE VIBRANCY RAMP'S BILL. A tick sits on the groove
            or on the wash depending on where the value is, and once the wash
            climbed towards a near-solid accent a single ink stopped serving
            both grounds — measured, the unpassed rung all but vanished under a
            `max` wash. So a passed tick takes a rung up, which is also the
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
              left: `${effortStopPercent(at + 1, levels.length)}%`,
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
            here. Measured over the composited wash at every stop of the ramp:
            the muted noun read 3.74–3.84:1 in dark, under AA across the WHOLE
            track rather than at one end of it, and 4.64–4.50:1 in light, which
            reaches the line and stops. At `--foreground` the same label reads
            5.72–5.87:1 and 9.90–9.60:1. Muting it was buying hierarchy with
            legibility, on the one word that says what the control IS.

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
            style={{ transform: `translateX(${effortStopPercent(index, levels.length)}%)` }}
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

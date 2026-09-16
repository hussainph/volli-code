/**
 * VC-376 — the usage-limits button, redrawn so it answers before it is opened.
 *
 * Today the button wears a Phosphor Gauge that draws the same picture whether
 * 95% or 2% of the quota is left, and the same Gauge is the effort picker in
 * the composer and in the activity bar — one shape, two unrelated meanings.
 * The redesign takes Apple's foldable-cover-screen idea (one small shape
 * carries the state, colour is the verdict, the detail is one click away)
 * without taking its layout, because Apple has three facts of three different
 * kinds and we have up to six of exactly one kind.
 *
 * THIS IS A PICKER, NOT A CONTACT SHEET. An earlier pass drew every candidate
 * against every state at once, which is the right material and the wrong
 * instrument: nine shapes times fourteen states is a hundred and twenty-six
 * drawings, and a page that shows all of them at once is a page on which no
 * single decision is easier to make. So the controls at the top hold one
 * combination and the stage below shows only that, at the size that ships.
 * Each view answers ONE question:
 *
 *   • Shapes   — at this state, which drawing wins?
 *   • States   — this drawing, does it survive everything the button can be in?
 *   • Motion   — does it get BETWEEN those states without flickering?
 *   • Pinning  — with six accounts and one arc, who chooses what it reports?
 *
 * WHAT IS BEING JUDGED, in the order it decides whether this is worth building:
 *
 *  1. DOES THE NUMBER FIT? The glyph box is 14px and the ring's inner diameter
 *     is about ten device pixels, so two digits live in less space than the
 *     `⌘K` keycap's letter. Only the band strip can answer this; every loupe
 *     on this page flatters the figure. The Type controls exist because that
 *     answer is a judgement about size and weight, not a yes or no.
 *
 *     Note what the centre costs and buys, because the reference goes the
 *     other way. Apple's figure sits in a gap at the TOP of its ring — it must,
 *     because its middle holds the Wi-Fi fan — and that gap, with the one at
 *     the bottom for the dots, leaves its arc only 180° to say 0–100 in. Our
 *     middle is empty, so the figure goes there, the ring closes over the top,
 *     and the arc gets 290° back. `Apple, transposed` stays on the Shapes view
 *     so that difference can be seen rather than asserted.
 *
 *  2. WHAT HAPPENS BETWEEN ONE AND THREE WINDOWS? Codex meters a session and a
 *     week, Copilot only a month, OpenCode Go three spans at once. A glyph
 *     that is beautiful with two arcs and broken with one has not survived
 *     contact. Motion crosses those counts under animation rather than between
 *     page loads, which is where a still-frame-only design fails.
 *
 *  3. WHAT HAPPENS WITH SIX ACCOUNTS? Dots cap and nested arcs cap, so both
 *     are lossy by construction. The question is whether what survives still
 *     answers "am I about to hit a wall".
 *
 *  4. AND WHEN EVERYTHING IS CRITICAL? Apple's own recorded failure: all the
 *     readings low at once and the icon becomes a smudge. `Everything
 *     critical` reproduces it with six accounts under a tenth.
 *
 * WHAT THIS SCRATCH DELIBERATELY DOES NOT DO is fetch anything. Where fresh
 * numbers come from is the ticket's open question and its own decision; the
 * drawing has to be settled first, because an icon nobody would want is not
 * worth plumbing. Every fixture is a fixed snapshot at a fixed `now`, and the
 * states that stand in for staleness — `unread`, `failed` — are drawn, not
 * simulated.
 *
 * THE POPOVER IS NOT REDESIGNED HERE. It stays the full breakdown, the way the
 * phone shows three separate icons once unfolded. The only thing the Pinning
 * view proposes adding to it is a pin at the end of each window row.
 */

import { GaugeIcon } from "@phosphor-icons/react/dist/csr/Gauge";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { PushPinSlashIcon } from "@phosphor-icons/react/dist/csr/PushPinSlash";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { PauseIcon } from "@phosphor-icons/react/dist/csr/Pause";
import * as React from "react";

import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

import { NOW, STATES, STATE_BY_ID, WALK, type IconState } from "../usage-icon/fixtures";
import { iconLabel, iconReading, type IconReading, type PinnedWindow } from "../usage-icon/reading";
import {
  CANDIDATES,
  DEFAULT_NUMBER,
  TYPE_FLOOR_PX,
  figureFit,
  type Candidate,
  type NumberStyle,
} from "../usage-icon/variants";

export const title = "Usage limits icon (VC-376)";
export const note = "Pick a shape and a state — the band shows it at the size that ships";

/**
 * The glyph size this design is now drawn at, and why it is not 14.
 *
 * 14px was `size-3.5` inside `icon-sm` — a Phosphor default inherited from the
 * Gauge that used to sit here, never a decision. It cannot hold a figure: the
 * ring's middle is a fixed fraction of its box, so at 14px two digits of the
 * system's SMALLEST type are wider than the space that exists.
 *
 * 22px is the size at which the figure lands exactly on `--text-label` with no
 * compensation — and, not by coincidence, the size at which the ring's outer
 * diameter equals the ⌘K pill's height to the pixel. The two chrome elements
 * stop being a small mark beside a big control and become a matched pair.
 */
const REAL = 22;
/** `icon` — 3px of padding around a 22px glyph, 4px clear of a 36px band. */
const REAL_BUTTON = 28;
/** What shipped before, kept for the comparison in the Size view. */
const LEGACY = 14;
/** Big enough to judge geometry. Never big enough to judge legibility. */
const LOUPE = 44;

type View = "size" | "shapes" | "states" | "motion" | "pinning";

const VIEWS: readonly { id: View; label: string; asks: string }[] = [
  { id: "size", label: "Size", asks: "Does a readable figure fit in the band at all?" },
  { id: "shapes", label: "Shapes", asks: "At this state, which drawing wins?" },
  { id: "states", label: "States", asks: "This drawing, across everything the button can be in." },
  { id: "motion", label: "Motion", asks: "Does it get between those states without flickering?" },
  { id: "pinning", label: "Pinning", asks: "Six accounts, one arc — who chooses what it reports?" },
];

export default function UsageLimitsIconScratch() {
  const [shapeId, setShapeId] = React.useState("centre-windows");
  const [stateId, setStateId] = React.useState("six-accounts");
  const [view, setView] = React.useState<View>("size");
  const [numberStyle, setNumberStyle] = React.useState<NumberStyle>(DEFAULT_NUMBER);
  const [glyphPx, setGlyphPx] = React.useState(REAL);
  const [optical, setOptical] = React.useState(true);

  const shape = CANDIDATES.find((candidate) => candidate.id === shapeId) ?? CANDIDATES[0];
  const state = STATE_BY_ID.get(stateId) ?? STATES[0];
  if (shape === undefined || state === undefined) return null;
  const reading = iconReading(state.kind, state.accounts, NOW);
  const glyph: GlyphArgs = { reading, numberStyle, glyphPx, optical, onGlyphPx: setGlyphPx };

  return (
    <div className="flex flex-col gap-4 pb-12">
      <Controls
        glyphPx={glyphPx}
        onGlyphPx={setGlyphPx}
        optical={optical}
        onOptical={setOptical}
        shape={shape}
        onShape={setShapeId}
        state={state}
        onState={setStateId}
        numberStyle={numberStyle}
        onNumberStyle={setNumberStyle}
      />

      {/* The stage is the same in every view, and it is the only place a
          decision may be made: one shape, one state, in a real 24px button,
          beside a real ⌘K pill. Everything below it is supporting evidence. */}
      <Stage shape={shape} state={state} glyph={glyph} />

      <ViewSwitcher value={view} onChange={setView} />

      {view === "size" ? <SizeView shape={shape} glyph={glyph} onPick={setShapeId} /> : null}
      {view === "shapes" ? <ShapesView glyph={glyph} active={shape} onPick={setShapeId} /> : null}
      {view === "states" ? <StatesView shape={shape} glyph={glyph} onPick={setStateId} /> : null}
      {view === "motion" ? <MotionView shape={shape} glyph={glyph} /> : null}
      {view === "pinning" ? <PinningView shape={shape} glyph={glyph} /> : null}
    </div>
  );
}

/** What every panel needs to draw the current combination. */
interface GlyphArgs {
  reading: IconReading;
  numberStyle: NumberStyle;
  /** The chosen shipping size. Panels that draw at another size pass it in. */
  glyphPx: number;
  optical: boolean;
  /** So a ladder rung can be adopted by clicking the thing itself. */
  onGlyphPx(next: number): void;
}

function draw(shape: Candidate, args: GlyphArgs, size: number, animate = false) {
  const label = iconLabel(args.reading);
  return shape.render({
    reading: args.reading,
    size,
    label,
    animate,
    numberStyle: args.numberStyle,
    optical: args.optical,
  });
}

/** The button that holds a glyph of this size, keeping `icon-sm`'s proportion. */
function buttonFor(glyphPx: number): number {
  return Math.round(glyphPx * (REAL_BUTTON / REAL));
}

/**
 * The same settings pointed at a different reading.
 *
 * Views that sweep states or steps vary ONE thing — what is being read — and
 * must not quietly reset size, type or stroke while they do it, or the sweep
 * stops being a comparison.
 */
function at(glyph: GlyphArgs, reading: IconReading): GlyphArgs {
  return { ...glyph, reading };
}

/* ------------------------------------------------------------------ controls */

function Controls({
  glyphPx,
  onGlyphPx,
  optical,
  onOptical,
  shape,
  onShape,
  state,
  onState,
  numberStyle,
  onNumberStyle,
}: {
  glyphPx: number;
  onGlyphPx(next: number): void;
  optical: boolean;
  onOptical(next: boolean): void;
  shape: Candidate;
  onShape(id: string): void;
  state: IconState;
  onState(id: string): void;
  numberStyle: NumberStyle;
  onNumberStyle(next: NumberStyle): void;
}) {
  return (
    <section className="flex flex-wrap items-start gap-x-8 gap-y-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      {/* Size leads, because it is the control the others depend on: the
          figure's room is a fixed fraction of this number. */}
      <Field label="Glyph size">
        <Choice
          name="Glyph size"
          value={glyphPx}
          onChange={onGlyphPx}
          options={[14, 18, 20, 22, 24, 26].map((px) => ({ value: px, label: String(px) }))}
        />
      </Field>
      <Field label="Shape">
        <Select
          name="Shape"
          value={shape.id}
          onChange={onShape}
          options={CANDIDATES.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
        />
      </Field>
      <Field label="State">
        <Select
          name="State"
          value={state.id}
          onChange={onState}
          options={STATES.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
      </Field>
      {/* Type is two controls rather than a preset list because the two
          trade against each other: a smaller figure wants more weight to hold
          its stems together, and a heavier one wants less size to stop
          shouting. A preset would hide exactly that exchange. */}
      <Field label="Figure size">
        <Choice
          name="Figure size"
          value={numberStyle.size}
          onChange={(size) => onNumberStyle({ ...numberStyle, size })}
          options={[10, 11, 12, 13, 14].map((size) => ({ value: size, label: String(size) }))}
        />
      </Field>
      <Field label="Figure weight">
        <Choice
          name="Figure weight"
          value={numberStyle.weight}
          onChange={(weight) => onNumberStyle({ ...numberStyle, weight })}
          options={[
            { value: 400, label: "Regular" },
            { value: 500, label: "Medium" },
            { value: 600, label: "Semibold" },
            { value: 700, label: "Bold" },
          ]}
        />
      </Field>
      {/* Not a style preference — a claim about how a mark should scale, which
          is only checkable by switching it off. See `opticalStroke`. */}
      <Field label="Stroke">
        <Choice
          name="Stroke"
          value={optical ? "optical" : "linear"}
          onChange={(next) => onOptical(next === "optical")}
          options={[
            { value: "optical", label: "Optical" },
            { value: "linear", label: "Linear" },
          ]}
        />
      </Field>
      <Field label="">
        <button
          type="button"
          onClick={() => onNumberStyle(DEFAULT_NUMBER)}
          className="rounded-full border border-border px-2.5 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground"
        >
          Reset type
        </button>
      </Field>
    </section>
  );
}

/* --------------------------------------------------------------------- stage */

function Stage({ shape, state, glyph }: { shape: Candidate; state: IconState; glyph: GlyphArgs }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      {/* A stand-in for `CommandCluster`: same gap-1, same 22px pill, same
          ghost icon button, on a band-coloured strip. The old Gauge sits
          beside it so the replacement is judged against what it replaces. */}
      <div
        data-testid="band-strip"
        className="flex h-9 items-center justify-center gap-1 rounded-md border border-border/50 bg-background"
      >
        <MockCommandPill />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Usage limits (today)"
          title="Today's Gauge"
        >
          <GaugeIcon />
        </Button>
        <span data-testid="real-size-row" className="flex items-center gap-1">
          <InBand shape={shape} glyph={glyph} />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          {draw(shape, glyph, LOUPE)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-ui font-medium">{shape.name}</p>
          <p className="text-label leading-snug text-muted-foreground">{shape.bet}</p>
          <p className="pt-1 text-label leading-snug text-muted-foreground">
            <span className="text-foreground">{state.name}.</span> {state.note}
          </p>
          <p className="pt-1 text-label text-muted-foreground">
            Accessible name: <code className="text-foreground">{iconLabel(glyph.reading)}</code>
          </p>
        </div>
      </div>
    </section>
  );
}

function MockCommandPill() {
  return (
    <span className="flex h-[22px] w-[280px] items-center gap-1 rounded-md border border-border/50 bg-foreground/10 px-2 text-ui text-muted-foreground">
      <MagnifyingGlassIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Search tickets and sessions</span>
      <kbd className="shrink-0 rounded-sm border border-border/70 bg-background/10 px-1 py-px font-sans text-label leading-none">
        ⌘K
      </kbd>
      <CaretDownIcon aria-hidden className="size-3 shrink-0" weight="bold" />
    </span>
  );
}

/**
 * One candidate as the band would actually mount it.
 *
 * A `pill` candidate is not a glyph in the standard icon button — it IS the
 * control, wider than 24px — so wrapping it in `size-icon-sm` would hide the
 * exact thing it is here to show. It gets a ghost button sized to its content
 * instead, which is what adopting it would really mean.
 */
function InBand({
  shape,
  glyph,
  size,
}: {
  shape: Candidate;
  glyph: GlyphArgs;
  /** Override the chosen size, for the ladder that draws every rung. */
  size?: number;
}) {
  const label = iconLabel(glyph.reading);
  const px = size ?? glyph.glyphPx;
  if (shape.chrome === "pill") {
    return (
      <Button variant="ghost" size="sm" className="h-6 px-0.5" aria-label={label} title={label}>
        {draw(shape, glyph, px)}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      style={{ width: buttonFor(px), height: buttonFor(px) }}
      aria-label={label}
      title={label}
    >
      {draw(shape, glyph, px)}
    </Button>
  );
}

/* --------------------------------------------------------------------- views */

function ViewSwitcher({ value, onChange }: { value: View; onChange(next: View): void }) {
  const active = VIEWS.find((entry) => entry.id === value);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1 rounded-full border border-border p-0.5">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onChange(entry.id)}
            aria-pressed={entry.id === value}
            className="rounded-full px-3 py-1 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="text-label text-muted-foreground">{active?.asks}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- size view */

/** The band is `h-9`. These are the things already in it, for scale. */
const BAND_NEIGHBOURS: readonly { px: number; what: string }[] = [
  { px: 13, what: "traffic light" },
  { px: 22, what: "⌘K pill" },
  { px: 24, what: "the old button" },
];

/** The rungs worth looking at, and what adopting each would really cost. */
const LADDER: readonly { glyph: number; note: string }[] = [
  { glyph: 14, note: "What shipped: `size-3.5`, a Phosphor default, never a decision." },
  { glyph: 18, note: "Free — the glyph grows into padding `icon-sm` already has." },
  { glyph: 20, note: "Legible, but 2px short of the pill: a near-miss reads as a mistake." },
  { glyph: 22, note: "Figure on `--text-label`. Outer diameter = the pill's height, exactly." },
  { glyph: 24, note: "Over the pill now, and the button starts crowding a 36px band." },
  { glyph: 26, note: "Figure reaches `--text-ui`, but the button is 33px in a 36px band." },
];

/**
 * The gating question — and the ruling is GROW IT.
 *
 * The figure was first set at 13/700 because that was the first setting that
 * could be READ, which is the wrong test: it answers "is it legible" when the
 * question is "does it belong". What was actually going on is that at 14px the
 * ring's clear middle is 10.5 CSS px, and two digits of `--text-label` — the
 * smallest type this system has — are about 12.3px wide. The app's smallest
 * type did not fit inside the app's icon. 13/700 was never a type choice; it
 * was a figure 36% under the floor compensating with weight, which is what a
 * badge IS.
 *
 * And 14px was never decided in the first place. It is `size-3.5`, the
 * Phosphor default the old Gauge came with — a size inherited from an icon
 * that carried no information, now asked to carry a number.
 *
 * WHY 22 IS A STOPPING POINT AND NOT MERELY A BIGGER NUMBER. Two independent
 * things land there at once:
 *
 *   • The figure reaches `--text-label` exactly, with no compensation. Below
 *     it the figure is under the system's floor; above it, the figure becomes
 *     the only text in the chrome set larger than the chrome's own label rung.
 *   • The ring's outer diameter equals the ⌘K pill's height — 22px and 22px.
 *     A ghost button paints nothing at rest, so what the eye sees is a circle
 *     exactly as tall as the control beside it. 20px misses by two, and a
 *     near-miss reads as a mistake where a match reads as a decision.
 *
 * WHAT KEEPS IT FROM LOOKING LIKE A BADGE is the other half of the work, and
 * it is not the size — see `opticalStroke`. A stroke written in box units
 * scales WITH the glyph, so growing the glyph 57% grows the ink 57%: the mark
 * gets heavier exactly as it stops needing to be. Optical scaling grows the
 * stroke as the square root instead, and the Stroke control switches it off so
 * the difference is checkable rather than claimed. The figure's weight drops
 * from 700 to 500 for the same reason — standing on the ladder, it has nothing
 * left to shout over.
 *
 * The two rejected answers stay at the foot of the view rather than being
 * deleted: "we grew the icon" is only a defensible answer next to the two that
 * did not require growing it.
 */
function SizeView({
  shape,
  glyph,
  onPick,
}: {
  shape: Candidate;
  glyph: GlyphArgs;
  onPick(id: string): void;
}) {
  const chosen = figureFit(glyph.glyphPx, glyph.numberStyle, glyph.optical);
  const legacy = figureFit(LEGACY, glyph.numberStyle, glyph.optical);
  const onRung = Math.abs(chosen.fromFloor) < 0.05;
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <p className="pb-2 text-ui font-medium">
          {onRung
            ? `At ${glyph.glyphPx}px the figure stands on the ladder`
            : `At ${glyph.glyphPx}px the figure is off the ladder`}
        </p>
        <p className="max-w-[72ch] text-label leading-relaxed text-muted-foreground">
          The ring leaves <Num>{chosen.clear}</Num>px of clear middle here, and two digits want{" "}
          <Num>{chosen.digits}</Num>px of it — they render at <Num>{chosen.px}</Num>px, which is{" "}
          <span className={onRung ? "text-primary" : "text-destructive"}>
            {chosen.fromFloor >= 0 ? "+" : "−"}
            {Math.abs(Math.round(chosen.fromFloor * 100))}%
          </span>{" "}
          against <code className="text-foreground">--text-label</code> ({TYPE_FLOOR_PX}px), the
          smallest type in the system. At the old {LEGACY}px it was{" "}
          <span className="text-destructive">{Math.round(legacy.fromFloor * 100)}%</span> — the
          app&rsquo;s smallest type did not fit inside the app&rsquo;s icon, and weight cannot buy
          space. That is the whole reason it read as a badge.
        </p>
      </Panel>

      <Panel>
        <p className="pb-1 text-ui font-medium">Where it stops</p>
        <p className="max-w-[72ch] pb-3 text-label leading-relaxed text-muted-foreground">
          Every rung in a real 36px band, against a real 22px pill. Two things meet at 22: the
          figure lands on <code className="text-foreground">--text-label</code>, and the
          ring&rsquo;s outer diameter equals the pill&rsquo;s height to the pixel — so at rest, when
          the ghost button paints nothing, the circle is exactly as tall as the control beside it.
        </p>
        <div data-testid="size-ladder" className="flex flex-col gap-2">
          {LADDER.map((rung) => {
            const fit = figureFit(rung.glyph, glyph.numberStyle, glyph.optical);
            const rungOnLadder = Math.abs(fit.fromFloor) < 0.05;
            const matchesPill = rung.glyph === 22;
            return (
              <button
                key={rung.glyph}
                type="button"
                onClick={() => glyph.onGlyphPx(rung.glyph)}
                aria-pressed={rung.glyph === glyph.glyphPx}
                className={cn(
                  "flex items-center gap-3 rounded-md border border-border bg-background p-2 text-left transition-colors",
                  "hover:border-border-strong aria-pressed:border-ring",
                )}
              >
                {/* The band at its true height, and the pill at its true 22px,
                    because the whole claim is about how these two compare. */}
                <span className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-border/50 px-2">
                  <span className="h-[22px] w-16 rounded-md border border-border/50 bg-foreground/10" />
                  <InBand shape={shape} glyph={glyph} size={rung.glyph} />
                </span>
                <span className="w-20 shrink-0 font-mono text-label text-foreground">
                  {rung.glyph}px
                </span>
                <span className="w-24 shrink-0 font-mono text-label text-muted-foreground">
                  {fit.px.toFixed(1)}px
                  <span className={rungOnLadder ? "text-primary" : "text-destructive"}>
                    {" "}
                    {fit.fromFloor >= 0 ? "+" : "−"}
                    {Math.abs(Math.round(fit.fromFloor * 100))}%
                  </span>
                </span>
                <span className="min-w-0 flex-1 text-label leading-snug text-muted-foreground">
                  {rung.note}
                </span>
                {matchesPill ? (
                  <span className="shrink-0 rounded-full border border-primary/40 px-2 py-0.5 text-label text-primary">
                    = pill
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <p className="pt-3 text-label text-muted-foreground">
          For scale, in the same 36px band:{" "}
          {BAND_NEIGHBOURS.map((n) => `${n.what} ${n.px}px`).join(" · ")}.
        </p>
      </Panel>

      <Panel>
        <p className="pb-1 text-ui font-medium">The stroke has to be corrected for the new size</p>
        <p className="max-w-[72ch] pb-3 text-label leading-relaxed text-muted-foreground">
          A stroke written in the glyph&rsquo;s own units scales <em>with</em> the glyph, so the
          same ring at {glyph.glyphPx}px carries {Math.round((glyph.glyphPx / LEGACY - 1) * 100)}%
          more ink than at {LEGACY}px — heavier exactly as it stops needing to be, which is the rest
          of what makes a big icon look like a badge. Optical scaling grows it as the square root
          instead. Switch the Stroke control to Linear to see what is being avoided.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <StrokeSample label="Optical" glyph={glyph} shape={shape} optical />
          <StrokeSample label="Linear" glyph={glyph} shape={shape} optical={false} />
        </div>
      </Panel>

      <Panel>
        <p className="pb-1 text-ui font-medium">The two answers that did not need a bigger icon</p>
        <p className="max-w-[72ch] pb-3 text-label leading-relaxed text-muted-foreground">
          Kept because growing the icon is only defensible next to them. Either would have let the
          glyph stay at {LEGACY}px: put the figure beside the ring where it is ordinary{" "}
          {TYPE_FLOOR_PX}px type, or drop it and let the arc carry the amount with the number one
          click away in the popover.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          <WayOut id="ring-pill" glyph={glyph} onPick={onPick} />
          <WayOut id="ring-beads-windows" glyph={glyph} onPick={onPick} />
        </div>
      </Panel>
    </div>
  );
}

/** The same drawing, same size, one geometry rule apart. */
function StrokeSample({
  label,
  glyph,
  shape,
  optical,
}: {
  label: string;
  glyph: GlyphArgs;
  shape: Candidate;
  optical: boolean;
}) {
  return (
    <span className="flex items-center gap-3 rounded-md border border-border bg-background p-2">
      <span className="flex h-9 items-center gap-1 rounded-md border border-border/50 px-2">
        <span className="h-[22px] w-16 rounded-md border border-border/50 bg-foreground/10" />
        <InBand shape={shape} glyph={{ ...glyph, optical }} />
      </span>
      <span className="flex size-12 items-center justify-center rounded-md border border-border/50">
        {draw(shape, { ...glyph, optical }, 44)}
      </span>
      <span className="w-16 text-label text-muted-foreground">{label}</span>
    </span>
  );
}

/** One alternative, in the band at real size, adoptable in a click. */
function WayOut({
  id,
  glyph,
  onPick,
}: {
  id: string;
  glyph: GlyphArgs;
  onPick(next: string): void;
}) {
  const candidate = CANDIDATES.find((entry) => entry.id === id);
  if (candidate === undefined) return null;
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className="flex w-full items-center gap-3 rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-border-strong"
    >
      <span className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-border/50 px-2">
        <span className="h-[22px] w-16 rounded-md border border-border/50 bg-foreground/10" />
        <InBand shape={candidate} glyph={glyph} size={LEGACY} />
      </span>
      <span className="min-w-0 flex-1 text-label leading-snug text-muted-foreground">
        <span className="text-foreground">{candidate.name}</span> — click to make it the shape
      </span>
    </button>
  );
}

/** A measured quantity, rounded once, so prose and drawing cannot disagree. */
function Num({ children }: { children: number }) {
  return <span className="font-mono text-foreground">{children.toFixed(1)}</span>;
}

/** Every shape at the chosen state — the comparison, one row, click to adopt. */
function ShapesView({
  glyph,
  active,
  onPick,
}: {
  glyph: GlyphArgs;
  active: Candidate;
  onPick(id: string): void;
}) {
  return (
    <Panel>
      <div data-testid="shapes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CANDIDATES.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onPick(candidate.id)}
            aria-pressed={candidate.id === active.id}
            className="flex items-center gap-3 rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-border-strong aria-pressed:border-ring"
          >
            <span className="flex size-10 shrink-0 items-center justify-center">
              {draw(candidate, glyph, 30)}
            </span>
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border/70">
              {draw(candidate, glyph, REAL)}
            </span>
            <span className="min-w-0 flex-1 text-ui">{candidate.name}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

/**
 * One shape, every state.
 *
 * The two rows to read before any other sit next to each other on purpose:
 * `Nothing read yet` against `Spent`. A thin ring means "not measured", a fat
 * empty track means "nothing left", and if those two are hard to tell apart
 * the notation is broken at its root — a cold launch would be indistinguishable
 * from a quota that has run out.
 */
function StatesView({
  shape,
  glyph,
  onPick,
}: {
  shape: Candidate;
  glyph: GlyphArgs;
  onPick(id: string): void;
}) {
  return (
    <Panel>
      <div data-testid="states" className="grid gap-2 sm:grid-cols-2">
        {STATES.map((entry) => {
          const args = at(glyph, iconReading(entry.kind, entry.accounts, NOW));
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onPick(entry.id)}
              className="flex items-start gap-3 rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-border-strong"
            >
              <span className="flex size-10 shrink-0 items-center justify-center">
                {draw(shape, args, 30)}
              </span>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border/70">
                {draw(shape, args, REAL)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-ui">{entry.name}</span>
                <span className="text-label leading-snug text-muted-foreground">{entry.note}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/**
 * The states, in motion.
 *
 * A glyph does not only have to look right in each state, it has to get
 * between them without flickering — a window appearing, an account signing
 * out, an arc crossing from primary through amber to red. The walk crosses
 * every one of those boundaries on a timer so the transitions are watched
 * rather than imagined.
 *
 * The movement is 300ms of ease-out on the arc's own length, about as much as
 * window chrome may ask for, and it is off under `prefers-reduced-motion` like
 * the rest of the app. Toggle Reduce Motion in the OS and the numbers still
 * change; only the tweening stops.
 */
function MotionView({ shape, glyph }: { shape: Candidate; glyph: GlyphArgs }) {
  const [index, setIndex] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);

  React.useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % WALK.length), 1_500);
    return () => clearInterval(timer);
  }, [playing]);

  const entry = STATE_BY_ID.get(WALK[index] ?? "");
  if (entry === undefined) return null;
  const args = at(glyph, iconReading(entry.kind, entry.accounts, NOW));

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying((current) => !current)}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <div className="flex flex-wrap gap-1">
          {WALK.map((id, position) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setPlaying(false);
                setIndex(position);
              }}
              aria-pressed={position === index}
              className="rounded-full px-2 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              {STATE_BY_ID.get(id)?.name ?? id}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-6 rounded-md border border-border bg-background p-4">
        {draw(shape, args, 72, true)}
        <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-border/70">
          {draw(shape, args, REAL, true)}
        </span>
        <span className="text-ui text-muted-foreground">{entry.name}</span>
      </div>
    </Panel>
  );
}

/**
 * WHICH WINDOW THE GLYPH REPORTS, AND HOW TO OVERRULE IT.
 *
 * With six accounts of two or three windows each there are up to fourteen
 * numbers and one arc, so the glyph must choose. Unpinned it reports whatever
 * is nearest to running out, which `accounts.ts` already computes for the
 * popover's collapsed rows — no new rule, and the glyph and the top row of the
 * popover can never disagree.
 *
 * That default is right nearly always and wrong in one specific, common case:
 * a long Session where the five-hour window is the one you are nursing, while
 * some other account's monthly meter happens to sit lower and therefore owns
 * the arc. The pin is the escape hatch — press the pin on any row and the
 * glyph reports that window until you unpin it.
 *
 * IT IS A LENS, NOT A FACT. Pinning changes which window is DRAWN, never which
 * window is binding, never the sort, never the popover's contents. A pin whose
 * account signs out or whose window the provider stops reporting falls back to
 * the default silently rather than blanking the glyph, because the pin is a
 * preference about a drawing and not a promise the provider made.
 *
 * The rows below stand in for the popover's own and are not a redesign of it —
 * the popover is explicitly out of scope, and the only thing this proposes
 * adding is the pin button at the end of each window row.
 */
function PinningView({ shape, glyph }: { shape: Candidate; glyph: GlyphArgs }) {
  const state = STATE_BY_ID.get("six-accounts");
  const [pin, setPin] = React.useState<PinnedWindow | null>(null);
  if (state === undefined) return null;
  const reading = iconReading(state.kind, state.accounts, NOW, pin);
  const args = at(glyph, reading);

  return (
    <Panel>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex w-44 flex-col items-center gap-3">
          <div className="flex h-[38px] items-center rounded-md border border-border/50 bg-background px-2">
            <InBand shape={shape} glyph={args} />
          </div>
          {draw(shape, args, LOUPE, true)}
          <p className="text-center text-label text-muted-foreground">
            {reading.pinned ? "Pinned" : "Nearest to running out"}
            {reading.reported === null ? "" : ` · ${reading.lead?.label} ${reading.reported.label}`}
          </p>
          {pin === null ? null : (
            <Button variant="ghost" size="sm" onClick={() => setPin(null)}>
              <PushPinSlashIcon />
              Unpin
            </Button>
          )}
        </div>

        <ul className="min-w-72 flex-1 divide-y divide-border/60 rounded-md border border-border">
          {state.accounts.map((account) => (
            <li key={account.providerId} className="p-2">
              <p className="pb-1 text-ui font-medium">{account.label}</p>
              <ul className="flex flex-col gap-0.5">
                {account.limits.windows.map((window) => {
                  const pinned =
                    pin?.providerId === account.providerId && pin.windowId === window.id;
                  const reported =
                    reading.lead?.providerId === account.providerId &&
                    reading.reported?.id === window.id;
                  return (
                    <li key={window.id} className="flex items-center gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-ui",
                          reported ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {window.label}
                      </span>
                      <span className="shrink-0 text-ui tabular-nums text-muted-foreground">
                        {Math.round(100 - window.usedPercent)}% left
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={pinned ? `Unpin ${window.label}` : `Pin ${window.label}`}
                        aria-pressed={pinned}
                        onClick={() =>
                          setPin(
                            pinned ? null : { providerId: account.providerId, windowId: window.id },
                          )
                        }
                      >
                        <PushPinIcon
                          weight={pinned ? "fill" : "regular"}
                          className={pinned ? "text-foreground" : "text-muted-foreground"}
                        />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ plumbing */

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      {children}
    </section>
  );
}

/**
 * A control group. A `div` and not a `label`, which is not a detail: a `label`
 * wrapping a set of buttons donates its own text to every button inside it, so
 * four segmented options all end up accessibly named "Figure weight" and
 * neither a screen reader nor a test can tell Regular from Bold. Each control
 * below carries its own name instead.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-label uppercase text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Select<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T;
  onChange(next: T): void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <select
      aria-label={name}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-6 rounded-md border border-border bg-background px-2 text-ui text-foreground"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Choice<T extends number | string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T;
  onChange(next: T): void;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <div
      role="group"
      aria-label={name}
      className="flex h-6 items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          aria-label={`${name} ${option.label}`}
          aria-pressed={option.value === value}
          className="rounded-sm px-2 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

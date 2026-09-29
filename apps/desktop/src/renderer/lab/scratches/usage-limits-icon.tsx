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
 * combination and the stage below shows only that, initially at the chosen
 * 26px size. The controls retain every comparison rung. Each view asks ONE
 * question:
 *
 *   • Shapes   — at this state, which drawing wins?
 *   • States   — this drawing, does it survive everything the button can be in?
 *   • Motion   — does it get BETWEEN those states without flickering?
 *   • Pinning  — with six accounts and one arc, who chooses what it reports?
 *
 * WHAT WAS JUDGED, in the order that decided whether this was worth building:
 *
 *  1. DOES THE NUMBER FIT? The old 14px glyph left about ten pixels inside
 *     its ring, less than two digits of the system's smallest type need. That
 *     failure justified growing the box, but did not settle the type: the
 *     chosen 26px stack gives some of that room back to a provider mark and
 *     sets its figures at 11/500. Only the band strip can answer whether this
 *     compromise reads; every loupe on this page flatters the figure.
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
 * WHAT THIS SCRATCH DELIBERATELY DOES NOT DO is fetch anything. It settled
 * the drawing before the app's data path was wired, because an icon nobody
 * would want was not worth plumbing. The picker remains a comparison of fixed
 * snapshots at one fixed `now`; `unread` and `failed` are drawn, not simulated.
 *
 * THE POPOVER IS NOT REDESIGNED HERE. It stays the full breakdown, the way the
 * phone shows three separate icons once unfolded. The Pinning view remains a
 * proposal for a pin at the end of each window row, not part of the chosen
 * glyph or a claim that the app now offers pinning.
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
  type FigureFit,
  type NumberStyle,
} from "../usage-icon/variants";

export const title = "Usage limits icon (VC-376)";
export const note = "Opens on the chosen 26px stack — compare shapes and states in the band";

/**
 * The glyph size this design is now drawn at, and why it is not 14.
 *
 * 14px was `size-3.5` inside `icon-sm` — a Phosphor default inherited from the
 * Gauge that used to sit here, never a decision. It cannot hold a figure: the
 * ring's middle is a fixed fraction of its box, so at 14px two digits of the
 * system's SMALLEST type are wider than the space that exists.
 *
 * 22px was an important comparison: a centred 12-unit figure landed exactly
 * on `--text-label`, and the ring's outer diameter met the ⌘K pill's 22px
 * height. But the chosen two-figure stack gives up 20% of its type setting to
 * make room for the mark. At 26px with an 11-unit setting and medium weight,
 * both figures get more room while a 32px target still clears the 36px band.
 */
const REAL = 26;
/** Three pixels of padding on each side, matching the app's icon button. */
const BUTTON_PADDING = 6;
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
  const [shapeId, setShapeId] = React.useState("two-figures-mark");
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

      {/* The stage is the same in every view: one shape, one state, at the
          selected glyph size in a button with the app's 3px padding, beside
          the ⌘K pill. The comparisons below preserve why this combination
          won rather than replacing the real-size judgement with a loupe. */}
      <Stage shape={shape} state={state} glyph={glyph} />

      <ViewSwitcher value={view} onChange={setView} />

      {view === "size" ? <SizeView shape={shape} glyph={glyph} onPick={setShapeId} /> : null}
      {view === "shapes" ? <ShapesView glyph={glyph} active={shape} onPick={setShapeId} /> : null}
      {view === "states" ? (
        <StatesView shape={shape} glyph={glyph} active={state.id} onPick={setStateId} />
      ) : null}
      {view === "motion" ? <MotionView shape={shape} glyph={glyph} /> : null}
      {view === "pinning" ? <PinningView shape={shape} glyph={glyph} /> : null}
    </div>
  );
}

/** What every panel needs to draw the current combination. */
interface GlyphArgs {
  reading: IconReading;
  numberStyle: NumberStyle;
  /** The selected glyph size. Panels that draw at another size pass it in. */
  glyphPx: number;
  optical: boolean;
  /** So a ladder rung can be adopted by clicking the thing itself. */
  onGlyphPx(next: number): void;
}

/**
 * `label: ""` marks the drawing decorative, which is the right default HERE:
 * almost every glyph on this page sits inside a card that already says what it
 * is, and a glyph that names itself makes those cards announce the same
 * reading two and three times over. Only the band strip — where the glyph IS
 * the control, as it will be in the app — passes a real name.
 */
function draw(shape: Candidate, args: GlyphArgs, size: number, animate = false, label = "") {
  return shape.render({
    reading: args.reading,
    size,
    label,
    animate,
    numberStyle: args.numberStyle,
    optical: args.optical,
  });
}

/** Keep the app's three pixels of padding per side at every ladder rung. */
function buttonFor(glyphPx: number): number {
  return glyphPx + BUTTON_PADDING;
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
          beside it so the larger replacement is judged against its predecessor. */}
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
        <div
          data-testid="loupe"
          className="flex size-16 shrink-0 items-center justify-center rounded-md border border-border bg-background"
        >
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
 * A `pill` candidate is not a glyph in the square icon button — it IS the
 * control, wider than that button — so wrapping it in `size-icon-sm` would hide the
 * exact thing it is here to show. It gets a ghost button sized to its content
 * instead, which is what adopting it would really mean.
 */
function InBand({
  shape,
  glyph,
  size,
  live = true,
}: {
  shape: Candidate;
  glyph: GlyphArgs;
  /** Override the chosen size, for the ladder that draws every rung. */
  size?: number;
  /**
   * False inside a card that is ITSELF a button.
   *
   * A button inside a button is invalid HTML, and browsers do not render it as
   * anything sane: the inner control steals the click and the tab stop, and a
   * screen reader reads a control whose name contains another control's name.
   * Every ladder rung and every alternative below is a clickable card holding
   * a band mock, so those get the same drawing in a plain span. At rest a
   * ghost button paints nothing anyway, so the two are pixel-identical until
   * hovered — which is why the 26px drawing can be judged against the pill.
   */
  live?: boolean;
}) {
  const label = iconLabel(glyph.reading);
  const px = size ?? glyph.glyphPx;
  const pill = shape.chrome === "pill";
  const box = pill ? undefined : { width: buttonFor(px), height: buttonFor(px) };

  if (!live) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center", pill && "h-6 px-0.5")}
        style={box}
      >
        {draw(shape, glyph, px)}
      </span>
    );
  }
  if (pill) {
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
      style={box}
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
  {
    glyph: 20,
    note: "Still 2px short of the pill; the earlier centred figure looked like a near-miss.",
  },
  {
    glyph: 22,
    note: "Earlier 12-unit centre figure reached `--text-label`; the ring matches the pill.",
  },
  { glyph: 24, note: "Over the pill now, but the stack still pays for the middle mark." },
  {
    glyph: 26,
    note: "Chosen: two figures + mark, 11/500 in the box, 32px target in a 36px band.",
  },
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
 * WHY 22 WAS A STOPPING POINT FOR THE CENTRED FIGURE, BUT NOT THE CHOICE.
 * With the earlier 12-unit setting the figure reached `--text-label` exactly,
 * while the ring's outer diameter met the ⌘K pill's 22px height. A ghost
 * button paints nothing at rest, so that pair looked deliberate rather than
 * like a 20px near-miss. But the chosen shape prints TWO windows and puts a
 * provider mark between them. Its stack takes a fifth off both figures to
 * make the mark legible, and 22px no longer gives them enough room. The 26px
 * glyph with an 11-unit dial and medium weight is the chosen compromise:
 * its figures remain below the 11px type floor after stacking, but the mark
 * survives and its 32px button still fits a 36px band. The ladder retains
 * the earlier centred-figure result as evidence, not as the verdict.
 *
 * WHAT KEEPS IT FROM LOOKING LIKE A BADGE is the other half of the work, and
 * it is not the size — see `opticalStroke`. A stroke written in box units
 * scales WITH the glyph, so growing it from 14px to 26px grows the ink by
 * 86%: the mark gets heavier exactly as it stops needing to be. Optical
 * scaling grows the stroke as the square root instead, and the Stroke control
 * switches it off so the difference is checkable rather than claimed. The
 * figure's weight drops from 700 to 500 for the same reason: weight cannot
 * buy room for two numbers and a mark.
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
  // The type this SHAPE sets, not the type the dial holds: a stacked variant
  // sets its figures smaller, and a panel that measured the dial would be
  // describing a drawing that is not on screen.
  const style: NumberStyle = {
    ...glyph.numberStyle,
    size: glyph.numberStyle.size * (shape.figureScale ?? 1),
  };
  const chosen = figureFit(glyph.glyphPx, style, glyph.optical);
  const legacy = figureFit(LEGACY, style, glyph.optical);
  const onRung = Math.abs(chosen.fromFloor) < 0.05;
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <p className="pb-2 text-ui font-medium">
          {onRung
            ? `At ${glyph.glyphPx}px the figure stands on the type ladder`
            : `At ${glyph.glyphPx}px the figure is off the type floor`}
        </p>
        {shape.stacked === true ? (
          // A stacked shape is capped by the BOX's height rather than by the
          // ring's middle, and the two facts are not interchangeable: the
          // sentence below would report a constraint this drawing does not have.
          <p className="max-w-[72ch] text-label leading-relaxed text-muted-foreground">
            This shape sets <span className="text-foreground">two</span> figures, one above the
            other, so what caps them is the box&rsquo;s height and not the ring&rsquo;s middle: two
            cap heights, plus whatever stands between them.{" "}
            {shape.figureScale === undefined ? (
              <>They keep the full setting and render at </>
            ) : (
              <>
                Room for a mark between them costs {Math.round((1 - shape.figureScale) * 100)}% off
                both, so they render at{" "}
              </>
            )}
            <Num>{chosen.px}</Num>px, which is <FromFloor fit={chosen} /> against{" "}
            <code className="text-foreground">--text-label</code> ({TYPE_FLOOR_PX}px). That is the
            price of the second number, and of the mark if it is there — paid twice, once by each
            figure.
          </p>
        ) : (
          <p className="max-w-[72ch] text-label leading-relaxed text-muted-foreground">
            The ring leaves <Num>{chosen.clear}</Num>px of clear middle here, and two digits want{" "}
            <Num>{chosen.digits}</Num>px of it — they render at <Num>{chosen.px}</Num>px, which is{" "}
            <FromFloor fit={chosen} /> against <code className="text-foreground">--text-label</code>{" "}
            ({TYPE_FLOOR_PX}px), the smallest type in the system. At the old {LEGACY}px it was{" "}
            <span className="text-destructive">{Math.round(legacy.fromFloor * 100)}%</span> — the
            app&rsquo;s smallest type did not fit inside the app&rsquo;s icon, and weight cannot buy
            space. That is the whole reason it read as a badge.
          </p>
        )}
      </Panel>

      <Panel>
        <p className="pb-1 text-ui font-medium">Why the 22px stop became 26px</p>
        <p className="max-w-[72ch] pb-3 text-label leading-relaxed text-muted-foreground">
          Every rung in a real 36px band, against a real 22px pill. At 22px, the earlier centred
          12-unit figure reached <code className="text-foreground">--text-label</code> and the ring
          matched the pill&rsquo;s height. The chosen stack instead spends room on a second figure
          and a mark: at 26px its 11-unit, medium-weight setting survives the trade, with a 32px
          button still inside the band. The figures remain below the type floor, so the band, not
          the metric alone, is the final test.
        </p>
        <div data-testid="size-ladder" className="flex flex-col gap-2">
          {LADDER.map((rung) => {
            const fit = figureFit(rung.glyph, style, glyph.optical);
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
                  <InBand shape={shape} glyph={glyph} size={rung.glyph} live={false} />
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
        <InBand shape={candidate} glyph={glyph} size={LEGACY} live={false} />
      </span>
      <span className="min-w-0 flex-1 text-label leading-snug text-muted-foreground">
        <span className="text-foreground">{candidate.name}</span> — click to compare at the old size
      </span>
    </button>
  );
}

/** A measured quantity, rounded once, so prose and drawing cannot disagree. */
function Num({ children }: { children: number }) {
  return <span className="font-mono text-foreground">{children.toFixed(1)}</span>;
}

/** How far a figure sits from the type floor, coloured by whether it is on it. */
function FromFloor({ fit }: { fit: FigureFit }) {
  return (
    <span className={Math.abs(fit.fromFloor) < 0.05 ? "text-primary" : "text-destructive"}>
      {fit.fromFloor >= 0 ? "+" : "−"}
      {Math.abs(Math.round(fit.fromFloor * 100))}%
    </span>
  );
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
            // Same reason as the state cards: the two glyphs inside each carry
            // the full reading as their own label, so without this the card is
            // named "31% left on… 31% left on… Centre + beads (windows)".
            aria-label={candidate.name}
            className="flex items-center gap-3 rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-border-strong aria-pressed:border-ring"
          >
            <span className="flex size-10 shrink-0 items-center justify-center">
              {draw(candidate, glyph, 30)}
            </span>
            <span
              className="flex shrink-0 items-center justify-center rounded-md border border-dashed border-border/70"
              style={{ width: buttonFor(glyph.glyphPx), height: buttonFor(glyph.glyphPx) }}
            >
              {draw(candidate, glyph, glyph.glyphPx)}
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
  active,
  onPick,
}: {
  shape: Candidate;
  glyph: GlyphArgs;
  active: string;
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
              // Named explicitly: without this the button's accessible name is
              // both glyph labels plus the whole note read end to end, which
              // is unusable to a screen reader and unfindable to a test.
              aria-label={entry.name}
              aria-pressed={entry.id === active}
              className="flex items-start gap-3 rounded-md border border-border bg-background p-2 text-left transition-colors hover:border-border-strong aria-pressed:border-ring"
            >
              <span className="flex size-10 shrink-0 items-center justify-center">
                {draw(shape, args, 30)}
              </span>
              <span
                className="flex shrink-0 items-center justify-center rounded-md border border-dashed border-border/70"
                style={{ width: buttonFor(glyph.glyphPx), height: buttonFor(glyph.glyphPx) }}
              >
                {draw(shape, args, glyph.glyphPx)}
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
        <span
          className="flex items-center justify-center rounded-md border border-dashed border-border/70"
          style={{ width: buttonFor(glyph.glyphPx), height: buttonFor(glyph.glyphPx) }}
        >
          {draw(shape, args, glyph.glyphPx, true)}
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

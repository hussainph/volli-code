/**
 * The canvas editor — the one authoring surface for what the window is painted
 * with, mounted at both scopes. Labels + controls only, per AGENTS.md /
 * CLAUDE.md ("UI copy: let controls talk"): no row descriptions, no tutorial
 * tooltips, no contrast lectures.
 *
 * Ported from `lab/scratches/canvas.tsx`, which is where the interaction was
 * designed: the pad is a MINIMAP (a stop's position on it is where its pool
 * lands in the window, so it carries the window's 16:10 proportions or it lies
 * about the one thing it exists to show), pressing an orb promotes it and
 * dragging it moves it, and the swatch page follows the primary rather than
 * being seeded from it once.
 *
 * What did NOT come across is the lab's two-mode `CHROME` table. That editor was
 * a translucent card floating ON the gradient and had to answer light and dark
 * itself; this one lives inside Settings' own opaque card, where the app's
 * tokens already do. Its six tuning dials did not come across either — lift,
 * card tint, surface spread, shadow, text weight and the seam are settled and
 * now live in `ARC_SETTLED`, so they are no longer settings.
 *
 * ## The two faders
 *
 * Vibrancy and grain are MATCHING VERTICAL FADERS flanking the pad — an owner
 * decision that reversed the earlier track-and-knob split, trading the grain
 * dial's textured face for a symmetric instrument (the pad wears the live
 * grain layer now, so the readout the face carried was not lost). Both are
 * the platform's own slider, stood upright ({@link WaveSlider}): a unit value
 * has a position along a line, so clicking anywhere on the track to jump
 * there is the fastest way to set it, and the native control brings that, the
 * keyboard and both modes' rendering for free.
 *
 * ## Preview
 *
 * Every edit paints before it persists, through the theme store's EXISTING
 * preview mechanism (`startPreview` / `commitPreview`) rather than a second one.
 * That mechanism was built for the dead picker's hover and does exactly this
 * job: it repaints the live DOM and writes nothing, so a drag is a continuous
 * repaint and the pointer-up is the single write. It also outranks both scopes,
 * which is what lets a workspace-scoped edit be visible while the global canvas
 * is still what is stored.
 *
 * The store paints a preview once per animation frame and tells the terminals
 * only on settle (`stores/theme.ts`, `theme/apply.ts`); the controls here are
 * NOT throttled with it. State is immediate and only the document's properties
 * wait, because a knob or an orb that lagged the pointer by a frame is the
 * thing this editor most has to get right.
 *
 * A commit that fails is surfaced by the store's own `writeThrough` and rolls
 * the paint back to what is actually stored — nothing here swallows it.
 */

import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DotsNineIcon } from "@phosphor-icons/react/dist/csr/DotsNine";
import { DropHalfIcon } from "@phosphor-icons/react/dist/csr/DropHalf";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { MoonStarsIcon } from "@phosphor-icons/react/dist/csr/MoonStars";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import {
  addStop,
  canvasBackground,
  grainLayer,
  MAX_STOPS,
  moveStop,
  removeStop,
  withPrimaryHex,
  withPrimaryIndex,
  type Appearance,
  type Canvas,
  type CanvasStop,
  type ResolvedAppearance,
} from "@volli/shared";

import {
  CANVAS_SWATCH_PAGES,
  droppedStopIndex,
  normalizeStopHex,
  padAnchor,
  swatchPageOf,
  UNIT_STEP,
  UNIT_STEP_COARSE,
} from "@renderer/components/theme/canvas-editor-model";
import {
  SLIDER_SQUIGGLE_AMPLITUDE,
  SLIDER_SQUIGGLE_WAVELENGTH,
  SLIDER_SQUIGGLE_WIDTH,
  SLIDER_THUMB_WIDTH,
  sliderSeam,
  sliderSquigglePath,
  sliderSquiggleScale,
} from "@renderer/components/theme/slider-squiggle";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";

/** 16:10 — the app's real default window (1280×800). See the module header. */
const PAD_ASPECT = "16 / 10";
const PAD_RATIO = 16 / 10;
const PAD_DOT_SPACING = 14;

/**
 * The foot of a fader column: the glyph that names it (size-3.5 → 14px) plus
 * the gap-2 above it. Part of the pad-height equation below — change the
 * icon size or the gap and this must move with it.
 */
const FADER_FOOT = 22;

/**
 * The pad's width, DERIVED from the fader column: at 16:10, a pad this wide
 * is exactly as tall as track + foot, so the two columns flanking it run
 * precisely the height of the picture they tune — matched by construction,
 * not by two numbers that happen to agree today. The FOOT is in the sum
 * because it was once left out: the track alone matched the pad, and the
 * icon shoved the whole column up past the section rule above.
 */
const PAD_WIDTH = (SLIDER_SQUIGGLE_WIDTH + FADER_FOOT) * PAD_RATIO;

/**
 * The lab's orb sizes, and a promotion that is a 1.6× jump.
 *
 * Kept at the lab's absolute numbers even though this pad is roughly twice its
 * width: an orb is a grab target and a colour sample, and neither of those wants
 * to scale with the container. The first port shrank them to 22/34 and the pad
 * read as a map of pinheads.
 */
const ORB_SIZE = 28;
const PRIMARY_ORB_SIZE = 44;

/** Travel under which a press is a click (promote, or nothing) rather than a drag. */
const CLICK_SLOP = 4;

/** The three modes, in the order the control lists them. */
const APPEARANCE_OPTIONS = [
  { key: "light", label: "Light", icon: SunIcon },
  { key: "dark", label: "Dark", icon: MoonStarsIcon },
  { key: "auto", label: "Auto", icon: MonitorIcon },
] as const satisfies readonly { key: Appearance; label: string; icon: unknown }[];

/**
 * Light / dark / follow-the-system, for either scope.
 *
 * Its own control rather than a row inside the canvas editor, because appearance
 * and canvas are scoped INDEPENDENTLY — a workspace may override one, the other,
 * both or neither — and a control nested inside the canvas editor would make
 * that impossible to express.
 */
export function AppearanceModeChoice({
  value,
  testId,
  iconOnly = false,
  onChange,
}: {
  value: Appearance;
  testId: string;
  /** Sun · moon · monitor with no words — the form it takes floating on the pad. */
  iconOnly?: boolean;
  onChange(next: Appearance): void;
}) {
  return (
    <Segmented
      ariaLabel="Appearance"
      testId={testId}
      value={value}
      options={APPEARANCE_OPTIONS}
      iconOnly={iconOnly}
      onChange={onChange}
    />
  );
}

/* -------------------------------------------------------------------------- */

interface DragHandlers {
  onPointerDown(event: React.PointerEvent<HTMLElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLElement>): void;
  onPointerCancel(event: React.PointerEvent<HTMLElement>): void;
}

/** Where inside the dragged element the pointer went down, from its centre. */
interface GrabOffset {
  dx: number;
  dy: number;
}

/**
 * Press-and-drag on one element, with pointer capture so the gesture survives
 * the cursor leaving it — an orb dragged to the pad's edge must not be dropped
 * the moment it crosses out.
 *
 * `CLICK_SLOP` is what makes a press and a drag two gestures rather than one:
 * nothing moves until the pointer has travelled that far, and a release before
 * it does is reported to `onClick` instead — an orb is PROMOTED by a press and
 * MOVED by a drag, two things one control has to be able to do. (The grain
 * dial was this hook's second user until the owner traded it for a fader;
 * `onClick` stays optional because omitting it is what "a press means nothing
 * here" looks like.)
 *
 * `onSettle` fires once at the end of any gesture that actually moved, which is
 * the editor's single write per drag — every intermediate frame is a preview.
 */
function useSlopDrag({
  onDrag,
  onClick,
  onSettle,
}: {
  onDrag(event: React.PointerEvent<HTMLElement>, grab: GrabOffset): void;
  onClick?(): void;
  onSettle(): void;
}): DragHandlers {
  const gesture = React.useRef<{
    id: number;
    x: number;
    y: number;
    grab: GrabOffset;
    dragging: boolean;
  } | null>(null);

  return {
    onPointerDown(event) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      // `preventDefault` above suppresses the native focus a press would
      // otherwise give, and the orb is keyboard-operable — without this the
      // arrow keys only work after a Tab, never after a click.
      event.currentTarget.focus();
      const rect = event.currentTarget.getBoundingClientRect();
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        grab: {
          dx: event.clientX - (rect.left + rect.width / 2),
          dy: event.clientY - (rect.top + rect.height / 2),
        },
        dragging: false,
      };
    },
    onPointerMove(event) {
      const active = gesture.current;
      if (active === null || active.id !== event.pointerId) return;
      if (!active.dragging) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < CLICK_SLOP) return;
        active.dragging = true;
      }
      onDrag(event, active.grab);
    },
    onPointerUp(event) {
      const active = gesture.current;
      if (active === null || active.id !== event.pointerId) return;
      gesture.current = null;
      if (active.dragging) onSettle();
      else onClick?.();
    },
    onPointerCancel() {
      // A cancelled gesture still leaves a preview painted, so it still has to
      // settle — the alternative is a canvas on screen that nothing stored.
      const active = gesture.current;
      gesture.current = null;
      if (active?.dragging === true) onSettle();
    },
  };
}

function PadOrb({
  stop,
  index,
  primary,
  padRef,
  onMove,
  onPromote,
  onSettle,
}: {
  stop: CanvasStop;
  index: number;
  primary: boolean;
  padRef: React.RefObject<HTMLDivElement | null>;
  onMove(index: number, x: number, y: number): void;
  onPromote(index: number): void;
  onSettle(): void;
}) {
  const move = (event: React.PointerEvent<HTMLElement>, grab: GrabOffset): void => {
    const pad = padRef.current;
    if (pad === null) return;
    const { x, y } = padAnchor({
      pointerX: event.clientX,
      pointerY: event.clientY,
      grabX: grab.dx,
      grabY: grab.dy,
      rect: pad.getBoundingClientRect(),
    });
    onMove(index, x, y);
  };

  const handlers = useSlopDrag({
    onDrag: move,
    onClick: () => onPromote(index),
    onSettle,
  });

  const nudge = (event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? UNIT_STEP_COARSE : UNIT_STEP;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    // Relative, so it reads `stop` — which is why the orb has to be rendered
    // from the previewed canvas. Fed the STORED one, every press in a held
    // repeat would start from the same anchor and the orb would sit one step
    // out however long the key was down.
    onMove(index, stop.x + delta.x, stop.y + delta.y);
  };

  const size = primary ? PRIMARY_ORB_SIZE : ORB_SIZE;
  return (
    <button
      type="button"
      {...handlers}
      onKeyDown={nudge}
      onKeyUp={onSettle}
      // The two controls below settle on blur for a reason that applies to a
      // nudged orb identically, and this was the one that had not been given it:
      // focus leaving while an arrow key is still down sends the `keyup` to
      // whatever took focus, so the moved stop stays painted and unwritten.
      onBlur={onSettle}
      data-testid={`canvas-stop-orb-${index}`}
      aria-label={`Colour ${index + 1}, ${stop.hex}${primary ? ", primary" : ""}`}
      aria-pressed={primary}
      // The orbs stay AUTHORED, never mode-transformed: they are the colours you
      // picked, and an orb that dimmed itself in dark mode would make the pad
      // disagree with the swatch row you picked it from. The ring is two-tone
      // for the same reason it cannot be one — a white ring vanishes on a pale
      // canvas and a dark one vanishes on a deep canvas.
      style={{
        left: `${stop.x * 100}%`,
        top: `${stop.y * 100}%`,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        background: stop.hex,
      }}
      className="absolute touch-none rounded-full shadow-raised ring-2 ring-white outline-1 outline-black/30 transition-[width,height,margin] duration-200 ease-out focus-visible:ring-4 focus-visible:outline-2"
    />
  );
}

function GradientPad({
  canvas,
  resolved,
  onMove,
  onPromote,
  onSettle,
}: {
  canvas: Canvas;
  resolved: ResolvedAppearance;
  onMove(index: number, x: number, y: number): void;
  onPromote(index: number): void;
  onSettle(): void;
}) {
  const padRef = React.useRef<HTMLDivElement>(null);
  // The grain rides the pad, layered over the gradient — since the dial's
  // textured face went, this is where the grain fader's value is SEEN (the
  // pad is a minimap of the window, and the window wears grain too).
  const gradient = React.useMemo(() => {
    const painted = canvasBackground(canvas, resolved);
    const grain = grainLayer(canvas.grain);
    return grain === null ? painted : `${grain}, ${painted}`;
  }, [canvas, resolved]);

  return (
    <div
      ref={padRef}
      data-testid="canvas-pad"
      role="group"
      aria-label="Colour placement"
      style={{ aspectRatio: PAD_ASPECT, background: gradient }}
      className="relative w-full overflow-hidden rounded-lg border border-border"
    >
      {/* A grid, so a pool's placement can be judged against the window rather
          than against nothing. Mid-grey at a low alpha reads on both a pale and
          a deep canvas, which no single token does. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage: "radial-gradient(circle, rgb(128 128 128 / 0.35) 1px, transparent 1px)",
          backgroundSize: `${PAD_DOT_SPACING}px ${PAD_DOT_SPACING}px`,
        }}
      />
      {canvas.stops.map((stop, index) => (
        <PadOrb
          // The index IS a stop's identity here — `primaryIndex`, `moveStop` and
          // `removeStop` all address stops by slot, and a stop carries no id of
          // its own precisely so the persisted shape stays trivial.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          stop={stop}
          index={index}
          primary={index === canvas.primaryIndex}
          padRef={padRef}
          onMove={onMove}
          onPromote={onPromote}
          onSettle={onSettle}
        />
      ))}
    </div>
  );
}

/**
 * A quiet translucent chip for a control FLOATING ON THE PAD.
 *
 * The pad paints the user's own gradient, which can be any colour at all, so
 * a floating control cannot borrow the pad as its surface — white glyphs
 * vanish on a pale canvas, dark ones on a deep canvas (the orbs' two-tone
 * ring exists for the same reason). The chip brings its own token surface at
 * partial opacity, so the controls read on anything while the canvas still
 * shows through.
 */
function PadChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-background/60 p-0.5 backdrop-blur-sm">
      {children}
    </div>
  );
}

/**
 * −/+ — how many colours the canvas carries, floating at the pad's foot.
 *
 * On the pad rather than in a row of their own (the Arc arrangement): they
 * add and remove ORBS, and the orbs are right there. The hex chips that used
 * to restate every stop are gone with the move — the orbs already show the
 * colours, promotion is a press on an orb, and the primary's hex lives in
 * the field below.
 */
function StopCountControls({
  canvas,
  onAdd,
  onRemove,
}: {
  canvas: Canvas;
  onAdd(): void;
  onRemove(): void;
}) {
  const dropped = droppedStopIndex(canvas);
  return (
    <PadChip>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        disabled={dropped === null}
        // Names which one goes: the last stop, unless the last stop is the
        // primary — then the one below it, so "−" never recolours the window.
        aria-label={dropped === null ? "Remove a colour" : `Remove colour ${dropped + 1}`}
        title={dropped === null ? "You need at least one colour" : undefined}
      >
        <MinusIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onAdd}
        disabled={canvas.stops.length >= MAX_STOPS}
        aria-label="Add a colour"
        title={
          canvas.stops.length >= MAX_STOPS
            ? `A canvas can have at most ${MAX_STOPS} colours`
            : undefined
        }
      >
        <PlusIcon />
      </Button>
    </PadChip>
  );
}

/**
 * The primary's colour: nine presets a page, plus the hex it actually is.
 *
 * Only the PRIMARY is editable, and that is the model's rule rather than a
 * simplification — every other stop's hue is derived from this one at the
 * harmony offsets for the current stop count, so a canvas stays one family
 * instead of three unrelated colours sharing a window.
 *
 * The one control fed the STORED hex rather than the previewed one, and the only
 * place the loop the editor's header describes actually closes. Typing widens
 * `#e86` into `#ee8866` and previews it; handed that back as its own `hex`, the
 * draft would sync to the widened form and rewrite the field under the cursor
 * after three characters. The swatch ring and the page follow the stored colour
 * for the same reason — they are answering "what is this canvas's colour", which
 * a half-typed field is not yet a claim about.
 */
function PrimaryColourRow({
  hex,
  onPick,
  onPreview,
  onAbandon,
}: {
  hex: string;
  onPick(next: string): void;
  onPreview(next: string): void;
  /** Escape: drop the running preview, write nothing. See `CanvasEditor`'s `abandon`. */
  onAbandon(): void;
}) {
  const normalized = hex.toLowerCase();
  const [page, setPage] = React.useState(() => Math.max(0, swatchPageOf(normalized)));
  const [shown, setShown] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState(normalized);

  // The page FOLLOWS the primary instead of being seeded from it once, adjusted
  // during render (React's documented pattern for deriving state from changed
  // props) rather than in an effect, which would paint one frame of the wrong
  // page first. Keyed on the primary having CHANGED, so paging by hand still
  // works. The draft rides along for the same reason: a swatch click has to move
  // the field it sits under.
  if (shown !== normalized) {
    setShown(normalized);
    setDraft(normalized);
    const matching = swatchPageOf(normalized);
    if (matching !== -1 && matching !== page) setPage(matching);
  }

  const turn = (step: number): void =>
    setPage(
      (current) => (current + step + CANVAS_SWATCH_PAGES.length) % CANVAS_SWATCH_PAGES.length,
    );

  const type = (value: string): void => {
    setDraft(value);
    const parsed = normalizeStopHex(value);
    if (parsed !== null && parsed !== normalized) onPreview(parsed);
  };

  const settle = (): void => {
    const parsed = normalizeStopHex(draft);
    // An unparseable field is put back rather than left standing: it was never
    // applied, and a box reading `#zzz` next to a canvas that is still ember is
    // the control disagreeing with the window.
    if (parsed === null) {
      setDraft(normalized);
      return;
    }
    setDraft(parsed);
    if (parsed === normalized) return;
    onPick(parsed);
  };

  const chevron = "text-muted-foreground";
  return (
    <div className="flex w-full items-center justify-between gap-3">
      {/* ONE TIGHT CLUSTER: chevron, swatches, chevron, no air between them —
          a pager whose arrows drift from its pages reads as two controls. The
          hex field takes the row's far end; the space lives between the two
          clusters, not inside either. */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => turn(-1)}
          aria-label="Previous swatches"
          className={chevron}
        >
          <CaretLeftIcon />
        </Button>
        {/* FIXED-SIZE chips, not a stretching grid. `flex-1` with
            `aspect-square w-full` squares meant each swatch was a ninth of
            whatever width the row was given — nine 85px discs dominating the
            pane. A colour chip is a chip at any window size. */}
        <div role="group" aria-label="Primary colour presets" className="flex gap-2">
          {CANVAS_SWATCH_PAGES[page].map((swatch) => (
            <button
              key={swatch}
              type="button"
              onClick={() => onPick(swatch)}
              aria-label={swatch}
              aria-pressed={swatch === normalized}
              style={{ background: swatch }}
              className="size-7 shrink-0 rounded-full outline-offset-2 ring-1 ring-black/10 transition-transform hover:scale-110 aria-pressed:outline-2 aria-pressed:outline-ring"
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => turn(1)}
          aria-label="More swatches"
          className={chevron}
        >
          <CaretRightIcon />
        </Button>
      </div>
      <Input
        value={draft}
        aria-label="Primary colour hex"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => type(event.target.value)}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            settle();
          }
          // Escape ABANDONS. It used to put the field back and then call the
          // COMMIT path beside it — two lines contradicting each other, with the
          // window keeping the colour the user was backing out of. Not
          // `preventDefault`ed: Escape has to keep reaching whatever surface is
          // hosting this editor.
          if (event.key === "Escape") {
            setDraft(normalized);
            onAbandon();
          }
        }}
        className="h-6 w-24 shrink-0 px-2 font-mono text-ui"
      />
    </div>
  );
}

/**
 * The band the wave is drawn in, in px: the peak either side of the centreline
 * plus room for the stroke's own width and its round caps.
 */
const WAVE_BAND = 2 * (SLIDER_SQUIGGLE_AMPLITUDE + 2);

/**
 * One pass of the fader's wave.
 *
 * Drawn twice by {@link UnitSlider} — once in the unfilled ink for the whole
 * groove, then once in the accent clipped at the seam — because a fill that
 * follows the wave's own shape has to BE the wave, not a bar behind it.
 *
 * `fill-box` makes `scaleY`'s origin the path's own centreline, so the wave
 * flattens in place instead of sagging toward an edge, and `non-scaling-stroke`
 * holds the ink's weight while it does — without it the wave would thin as it
 * lay down and vanish before it arrived.
 */
function Wave({ stand, ink, clip }: { stand: number; ink: string; clip?: string }) {
  return (
    <svg
      aria-hidden
      data-slot="slider-squiggle"
      viewBox={`0 ${-WAVE_BAND / 2} ${SLIDER_SQUIGGLE_WIDTH} ${WAVE_BAND}`}
      preserveAspectRatio="none"
      style={{ clipPath: clip }}
      className="pointer-events-none absolute inset-x-0 top-1/2 h-3.5 -translate-y-1/2 overflow-visible transition-[clip-path] duration-150 ease-out motion-reduce:transition-none!"
    >
      <path
        d={sliderSquigglePath(
          SLIDER_SQUIGGLE_WIDTH,
          SLIDER_SQUIGGLE_WAVELENGTH,
          SLIDER_SQUIGGLE_AMPLITUDE,
        )}
        fill="none"
        vectorEffect="non-scaling-stroke"
        strokeWidth={2}
        strokeLinecap="round"
        style={{
          transform: `scaleY(${stand})`,
          transformBox: "fill-box",
          transformOrigin: "center",
        }}
        className={`${ink} transition-transform duration-150 ease-out motion-reduce:transition-none!`}
      />
    </svg>
  );
}

/**
 * A unit value as a VERTICAL wave fader — one on each side of the pad.
 *
 * Vibrancy and grain flank the canvas they tune (the owner's call, trading
 * the grain dial for symmetry): two of the same control bracketing the
 * picture, rising together, instead of one track and one knob sharing a row
 * under it. The wave still earns its place on both — its amplitude ramps
 * with the value, and "how vivid" and "how grainy" are both intensities the
 * groove can say without a word of copy. What the dial's textured face used
 * to show, the PAD now shows: it wears the live grain layer, so the fader
 * previews on the picture itself.
 *
 * BUILT HORIZONTAL, STOOD UP BY ONE ROTATION. The seam arithmetic, the
 * native input's value-from-position mapping and the wave path all live on
 * one x-axis; rotating the finished control keeps every one of them true
 * (the browser inverts the transform for hit-testing), where a hand-built
 * vertical twin would be a second copy of the seam math to drift. `-rotate-90`
 * points the value UP, and the native input keeps click-to-jump, the
 * keyboard (both arrow axes work on a range) and the focus ring for free —
 * its own paint stays suppressed in globals.css for this one input.
 */
function WaveSlider({
  id,
  label,
  icon: Icon,
  value,
  onInput,
  onSettle,
}: {
  id?: string;
  label: string;
  /**
   * The fader's one glyph, at its foot — mixer-style. Two identical waves
   * flanking the pad are only tellable apart by what stands at their feet,
   * and a glyph says it without spending a word (the aria-label still names
   * it for the reader; `title` names it for whoever hovers).
   */
  icon: PhosphorIcon;
  value: number;
  onInput(next: number): void;
  onSettle(): void;
}) {
  // The thumb's centre and the fill's seam are ONE x, read from one function —
  // two objects arriving at the same pixel, not near it.
  const seam = sliderSeam(value, SLIDER_SQUIGGLE_WIDTH, SLIDER_THUMB_WIDTH);
  const stand = sliderSquiggleScale(value);
  return (
    <span className="flex w-5 shrink-0 flex-col items-center gap-2">
      {/* The upright box the layout sees: as tall as the fader is long. */}
      <span className="relative inline-block w-5" style={{ height: SLIDER_SQUIGGLE_WIDTH }}>
        {/* Length comes from the squiggle module, never a `w-*` class: the seam
          clip and the thumb's travel are computed in that constant's space,
          and a class beside it is how the two once drifted apart. */}
        <span
          className="absolute top-1/2 left-1/2 inline-flex h-5 -translate-x-1/2 -translate-y-1/2 -rotate-90 items-center"
          style={{ width: SLIDER_SQUIGGLE_WIDTH }}
        >
          <Wave stand={stand} ink="stroke-border-strong" />
          <Wave
            stand={stand}
            ink="stroke-primary"
            clip={`inset(0 ${SLIDER_SQUIGGLE_WIDTH - seam}px 0 0)`}
          />
          {/* The capsule, centred on the seam and overhanging the trough, which is
            what makes it a fader handle rather than a dot on a line. */}
          <span
            aria-hidden
            style={{ left: seam }}
            className="pointer-events-none absolute top-1/2 h-5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-raised transition-[left] duration-150 ease-out motion-reduce:transition-none!"
          />
          {/* Last, so it takes the pointer: the platform's own control with its
            paint suppressed, which keeps click-to-jump, the keyboard, and the
            focus ring while this file owns every pixel you can see. */}
          <input
            id={id}
            type="range"
            min={0}
            max={1}
            step={UNIT_STEP}
            value={value}
            aria-label={label}
            data-slot="wave-slider"
            onChange={(event) => onInput(Number(event.target.value))}
            // One write per gesture: the drag and the key repeat are previews, and
            // the release is the commit.
            onPointerUp={onSettle}
            onKeyUp={onSettle}
            onBlur={onSettle}
            className="absolute inset-0 w-full"
          />
        </span>
        {/* No percentage. The wave's own stand is the readout — a number
            beside it was the control narrating itself. The native input still
            reports its value to the reader. */}
      </span>
      {/* `title` on a wrapping span — Phosphor's icon props carry no title of
          their own, and the input above already names the fader for readers. */}
      <span title={label} className="inline-flex">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </span>
    </span>
  );
}

/**
 * The editor itself.
 *
 * `canvas` is what the SCOPE has STORED (`appliedCanvas`). What the controls
 * render from is `live` — the running preview when there is one — and the
 * difference between those two is the whole of "the colour dragging felt
 * unstable".
 *
 * Rendered from the stored canvas, an orb does not move while you drag it. The
 * window behind Settings repaints, because that goes to the DOM directly, but
 * the pad's own orb is a React `style` fed a value the drag never changes, so it
 * sits still under the pointer for the length of the gesture and then teleports
 * to the drop point when the release commits. Every relative control had the
 * same fault: a held arrow key re-applied one step to the same stored anchor
 * forever.
 *
 * The feedback loop this was guarding against is real but narrower than it
 * looks. `padAnchor` positions from where the pointer IS, minus a grab offset
 * captured once at press time, so it cannot accumulate its own output. The one
 * control that genuinely cannot read the preview is the hex field — see
 * {@link PrimaryColourRow}.
 *
 * The store is read imperatively for every write, so no handler closes over a
 * snapshot that a concurrent hydrate has already replaced.
 */
export function CanvasEditor({
  scope,
  canvas,
  resolved,
  mode,
}: {
  scope: ThemeScope;
  /** What this scope has STORED — the canvas the controls sit on. */
  canvas: Canvas;
  /** What that canvas renders as right now, `auto` already answered. */
  resolved: ResolvedAppearance;
  /**
   * A mode control to float at the pad's head (the global page passes its
   * icon-only light/dark/auto). A SLOT, not a built-in: appearance and canvas
   * are scoped independently, so which mode control belongs near this pad —
   * or whether one does at all — is the mounting page's call. Configure's
   * page keeps mode on its own overridable row and passes nothing.
   */
  mode?: React.ReactNode;
}) {
  /**
   * The canvas an edit builds on: the running preview when there is one, the
   * stored canvas otherwise.
   *
   * A drag fires several pointermoves between renders, and each one has to build
   * on the position the previous one painted rather than on the one this render
   * closed over. Reading the store's own preview is what supplies that without a
   * second copy of the canvas living in a ref beside it.
   */
  const edit = React.useCallback(
    (update: (current: Canvas) => Canvas): void => {
      const store = useThemeStore.getState();
      store.startPreview(update(store.preview ?? canvas));
    },
    [canvas],
  );

  /** End of a gesture: what is painted becomes what is stored. */
  const settle = React.useCallback((): void => {
    // Failure is surfaced and rolled back by the store's own write path; the
    // boolean is only interesting to a caller that wanted to chain, and nothing
    // here does.
    void useThemeStore.getState().commitPreview(scope);
  }, [scope]);

  /**
   * The other end of a gesture: what is painted is thrown away, and nothing is
   * written.
   *
   * `cancelPreview` is the store action for this and had NO caller anywhere,
   * which left the editor with only one way to finish an edit — commit it. Two
   * different abandonments were paying for that. Escape in the hex field called
   * `settle` while resetting the field beside it, so backing out of a colour
   * PERSISTED it. And an editor that unmounted mid-gesture (Settings closed, the
   * category switched, the workspace switched) left the window wearing a canvas
   * that is stored nowhere and that no surface is left to commit or undo.
   *
   * Cheap in the ordinary case: every completed gesture ends in `settle`, which
   * clears the preview synchronously, and the store no-ops when there is nothing
   * to cancel.
   */
  const abandon = React.useCallback((): void => {
    useThemeStore.getState().cancelPreview();
  }, []);

  /** Leaving mid-gesture is an abandonment like any other. */
  React.useEffect(() => abandon, [abandon]);

  /** A discrete edit — one click, one write. */
  const commit = React.useCallback(
    (update: (current: Canvas) => Canvas): void => {
      edit(update);
      settle();
    },
    [edit, settle],
  );

  /**
   * What is actually on screen — the preview while a gesture runs, the stored
   * canvas otherwise. Every control that is a picture of the canvas reads this;
   * the one that is a picture of the STORED canvas is the hex field.
   */
  const preview = useThemeStore((state) => state.preview);
  const live = preview ?? canvas;

  return (
    <>
      {/*
       * THE ARC ARRANGEMENT, symmetric. The pad is the whole subject and
       * everything hangs off it: the mode choice floats at its head, −/+
       * float at its foot (they add and remove the orbs right above them),
       * and the two unit values stand as VERTICAL wave faders flanking the
       * picture they tune — vibrancy on the left, grain on the right — so
       * the block fills its measure evenly instead of leaving a dead row
       * under the pad. The swatch pager runs beneath, chevrons tight against
       * the swatches, with the primary's one hex field at the row's end.
       *
       * Each fader COLUMN (track plus the glyph at its foot) and the pad are
       * the same height by construction — {@link PAD_WIDTH} is derived from
       * `SLIDER_SQUIGGLE_WIDTH + FADER_FOOT` at the pad's own 16:10 — so the
       * three columns read as one instrument and nothing rises past the
       * section rule above.
       */}
      <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-3 pt-2 pb-2">
        {/* `items-start`, so the pad's top edge and both waves' tops sit on
            one line — the icons at the faders' feet hang just below the pad,
            mixer-style, without pushing the tracks out of register. */}
        <div className="flex items-start justify-center gap-4">
          <WaveSlider
            id="canvas-vibrancy"
            label="Vibrancy"
            icon={DropHalfIcon}
            value={live.vibrancy}
            onInput={(vibrancy) => edit((current) => ({ ...current, vibrancy }))}
            onSettle={settle}
          />

          <div className="relative shrink-0" style={{ width: PAD_WIDTH }}>
            <GradientPad
              canvas={live}
              resolved={resolved}
              onMove={(index, x, y) => edit((current) => moveStop(current, index, x, y))}
              onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
              onSettle={settle}
            />
            {/* Overlays are SIBLINGS of the pad, absolutely placed, so the
                pad's own group semantics stay a group of colour stops. */}
            {mode ? (
              <div className="absolute top-2 left-1/2 -translate-x-1/2">
                <PadChip>{mode}</PadChip>
              </div>
            ) : null}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
              <StopCountControls
                canvas={live}
                onAdd={() => commit(addStop)}
                onRemove={() => commit(removeStop)}
              />
            </div>
          </div>

          <WaveSlider
            label="Grain"
            icon={DotsNineIcon}
            value={live.grain}
            onInput={(grain) => edit((current) => ({ ...current, grain }))}
            onSettle={settle}
          />
        </div>

        {/* Centred at the pad's own width, so the pager's left edge sits
            under the pad's — not under a fader. */}
        <div className="mx-auto w-full" style={{ maxWidth: PAD_WIDTH }}>
          <PrimaryColourRow
            hex={canvas.stops[canvas.primaryIndex].hex}
            onPick={(next) => commit((current) => withPrimaryHex(current, next))}
            onPreview={(next) => edit((current) => withPrimaryHex(current, next))}
            onAbandon={abandon}
          />
        </div>
      </div>
    </>
  );
}

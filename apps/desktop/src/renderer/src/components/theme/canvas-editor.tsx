/**
 * The canvas editor — the one authoring surface for what the window is painted
 * with, mounted at both scopes.
 *
 * Handoff: another agent paused you and stripped the tutorial UI copy from
 * here (row descriptions, tooltips, contrast lectures). Labels + controls only
 * from now on — AGENTS.md / CLAUDE.md ("UI copy: let controls talk").
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
 * ## Two controls, deliberately not the same control
 *
 * Vibrancy is a TRACK and grain is a KNOB, and that is a decision rather than a
 * leftover — a rushed first port flattened both into `<input type="range">` and
 * lost the reason each one has its shape.
 *
 *  - Vibrancy is the platform's own slider. It has a position along a line, so
 *    clicking anywhere on the track to jump there is the fastest way to set it,
 *    and the native control brings that, the keyboard and both modes' rendering
 *    for free.
 *  - Grain is {@link GrainDial}, and its face carries the actual grain texture
 *    at its current amount. There is no other way to judge a value this subtle
 *    at this size, and showing a texture needs a surface to show it on. A knob
 *    has only an angle around it, not a position under the pointer, so it is
 *    grabbed rather than tapped: a press that never travels does nothing at all
 *    instead of jumping the value to wherever it landed.
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
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { MoonStarsIcon } from "@phosphor-icons/react/dist/csr/MoonStars";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import {
  addStop,
  canvasBackground,
  effectiveStopHexes,
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

import { SettingsRow } from "@renderer/components/pages/settings-shell";
import {
  canvasContrastReport,
  CANVAS_SWATCH_PAGES,
  dialAngle,
  dialPoint,
  DIAL_MAX_ANGLE,
  DIAL_MIN_ANGLE,
  droppedStopIndex,
  easedVibrancy,
  grainForAngle,
  lcLabel,
  normalizeStopHex,
  padAnchor,
  percentLabel,
  pointerBearing,
  swatchPageOf,
  unitStepForKey,
  UNIT_STEP,
  UNIT_STEP_COARSE,
  type CanvasContrastReport,
  type CanvasFloorReading,
} from "@renderer/components/theme/canvas-editor-model";
import { SegmentedChoice } from "@renderer/components/theme/segmented-choice";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";

/** 16:10 — the app's real default window (1280×800). See the module header. */
const PAD_ASPECT = "16 / 10";
const PAD_DOT_SPACING = 14;

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

/**
 * Mid-grey, under both the grain dial's face and the vibrancy chip.
 *
 * A literal rather than a token, and it is the one place in this file that
 * refuses one: the grain layer is BLACK noise and the dial's notch is WHITE, so
 * the surface underneath has to be something each of them can be seen on. Every
 * neutral token is near-paper in light or near-page in dark, and both ends lose
 * one of the two.
 */
const GRAIN_BACKDROP = "#8a8a8a";

/** The dial, and the ring of scale dots around it. */
const DIAL_SIZE = 56;
const DIAL_DOTS = 16;
const DIAL_DOT_RADIUS = 25.5;
const DIAL_NOTCH_INNER = 12;
const DIAL_NOTCH_OUTER = 19;
/** The scale dots, lit and unlit — the lab's alpha pair, carried over. */
const DIAL_DOT_LIT = 0.85;
const DIAL_DOT_UNLIT = 0.25;

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
  onChange,
}: {
  value: Appearance;
  testId: string;
  onChange(next: Appearance): void;
}) {
  return (
    <SegmentedChoice
      ariaLabel="Appearance"
      testId={testId}
      value={value}
      options={APPEARANCE_OPTIONS}
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
 * it does is reported to `onClick` instead. Both users of this hook want that
 * and want it for the same reason, which is why there is one hook:
 *
 *  - an orb is PROMOTED by a press and MOVED by a drag, two things one control
 *    has to be able to do;
 *  - the dial has nothing for a press to mean, so `onClick` is omitted and a
 *    press that never travels does nothing — which is the point. A knob has an
 *    angle around it and no position under the pointer, so jumping the value to
 *    wherever a finger landed would be answering a question nobody asked.
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
      className="absolute touch-none rounded-full shadow-lg ring-2 ring-white outline-1 outline-black/30 transition-[width,height,margin] duration-200 ease-out focus-visible:ring-4 focus-visible:outline-2"
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
  const gradient = React.useMemo(() => canvasBackground(canvas, resolved), [canvas, resolved]);

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

/** The stop chips — authored colour, what it paints as, and which one leads. */
function StopRow({
  canvas,
  resolved,
  onPromote,
  onAdd,
  onRemove,
}: {
  canvas: Canvas;
  resolved: ResolvedAppearance;
  onPromote(index: number): void;
  onAdd(): void;
  onRemove(): void;
}) {
  const painted = React.useMemo(() => effectiveStopHexes(canvas, resolved), [canvas, resolved]);
  const dropped = droppedStopIndex(canvas);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canvas.stops.map((stop, index) => {
        const primary = index === canvas.primaryIndex;
        return (
          <button
            // Slot is identity — see the pad's orbs.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            type="button"
            onClick={() => onPromote(index)}
            aria-pressed={primary}
            aria-label={`Colour ${index + 1}, ${stop.hex}${primary ? ", primary" : ""}`}
            data-testid={`canvas-stop-chip-${index}`}
            className="flex items-center gap-1.5 rounded-full border border-border py-1 pr-2.5 pl-1.5 font-mono text-label transition-colors hover:bg-accent aria-pressed:border-ring aria-pressed:bg-secondary"
          >
            <span
              aria-hidden
              className="size-3 rounded-full ring-1 ring-black/20"
              style={{ background: painted[index] }}
            />
            <span className={primary ? "text-foreground" : "text-muted-foreground"}>
              {stop.hex}
            </span>
            {primary ? <span className="text-primary-text uppercase">primary</span> : null}
          </button>
        );
      })}

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onRemove}
          disabled={dropped === null}
          // Names which one goes: the last stop, unless the last stop is the
          // primary — then the one below it, so "−" never recolours the window.
          aria-label={dropped === null ? "Remove a colour" : `Remove colour ${dropped + 1}`}
          title={dropped === null ? "A canvas needs at least one colour" : undefined}
        >
          <MinusIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onAdd}
          disabled={canvas.stops.length >= MAX_STOPS}
          aria-label="Add a colour"
          title={
            canvas.stops.length >= MAX_STOPS
              ? `A canvas carries at most ${MAX_STOPS} colours`
              : undefined
          }
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
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
      <div
        role="group"
        aria-label="Primary colour presets"
        className="grid flex-1 grid-cols-9 gap-1.5"
      >
        {CANVAS_SWATCH_PAGES[page].map((swatch) => (
          <button
            key={swatch}
            type="button"
            onClick={() => onPick(swatch)}
            aria-label={swatch}
            aria-pressed={swatch === normalized}
            style={{ background: swatch }}
            className="aspect-square w-full rounded-full outline-offset-2 ring-1 ring-black/15 transition-transform hover:scale-110 aria-pressed:outline-2 aria-pressed:outline-ring"
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
 * Vibrancy, as the platform's own slider.
 *
 * A track is the right shape for it — the value has a position along a line, so
 * clicking anywhere on it to jump there is the fastest way to set it, and the
 * native control brings that, the keyboard and both modes' rendering for free.
 *
 * The chip beside it is what the lab's hand-drawn track was for: a value this
 * subtle cannot be judged from a number, so the control shows what it is
 * setting.
 *
 * `--slider-fill` is how much of the track is filled; globals.css's
 * `::-webkit-slider-runnable-track` rule reads it. The track is declared there
 * rather than left to `accent-color`, which cannot paint an unfilled half that
 * follows the appearance — see that rule.
 */
function UnitSlider({
  id,
  label,
  value,
  chip,
  onInput,
  onSettle,
}: {
  id: string;
  label: string;
  value: number;
  chip: React.ReactNode;
  onInput(next: number): void;
  onSettle(): void;
}) {
  return (
    <div className="flex items-center gap-3">
      {chip}
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={UNIT_STEP}
        value={value}
        aria-label={label}
        onChange={(event) => onInput(Number(event.target.value))}
        // One write per gesture: the drag and the key repeat are previews, and
        // the release is the commit.
        onPointerUp={onSettle}
        onKeyUp={onSettle}
        onBlur={onSettle}
        style={{ "--slider-fill": percentLabel(value) } as React.CSSProperties}
        className="w-44"
      />
      <span className="w-9 text-right text-ui text-muted-foreground tabular-nums">
        {percentLabel(value)}
      </span>
    </div>
  );
}

/**
 * Grain, as a rotary knob — ported from the lab, where it was designed.
 *
 * The face carries the grain texture at its CURRENT amount, and that is the
 * whole argument for the shape: grain at 6% and grain at 12% are not
 * distinguishable from a number or a thumb position, and the only honest readout
 * is the texture itself. A texture needs a surface, and a surface that is being
 * turned is a knob.
 *
 * The rest follows from that. The ring of dots is the progress the track would
 * otherwise show; the notch says which way the face is turned; and the gesture
 * is an ANGLE around the control rather than a position under the pointer, which
 * is why it takes the slopped press (see {@link useSlopDrag}) and the slider
 * beside it does not.
 */
function GrainDial({
  value,
  onInput,
  onSettle,
}: {
  value: number;
  onInput(next: number): void;
  onSettle(): void;
}) {
  const dialRef = React.useRef<HTMLDivElement>(null);

  const handlers = useSlopDrag({
    onDrag(event) {
      const dial = dialRef.current;
      if (dial === null) return;
      onInput(
        grainForAngle(
          pointerBearing({
            pointerX: event.clientX,
            pointerY: event.clientY,
            rect: dial.getBoundingClientRect(),
          }),
        ),
      );
    },
    onSettle,
  });

  const turn = (event: React.KeyboardEvent): void => {
    const next = unitStepForKey(event.key, value, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    onInput(next);
  };

  const centre = DIAL_SIZE / 2;
  const notchFrom = dialPoint(centre, dialAngle(value), DIAL_NOTCH_INNER);
  const notchTo = dialPoint(centre, dialAngle(value), DIAL_NOTCH_OUTER);
  const grain = grainLayer(value);

  return (
    <div
      ref={dialRef}
      {...handlers}
      onKeyDown={turn}
      onKeyUp={onSettle}
      // The slider beside this one settles on blur too, and for a reason that
      // applies here identically: focus leaving while an arrow key is still
      // down sends the `keyup` to whatever took focus, so without this the
      // grain preview stays painted and unwritten.
      onBlur={onSettle}
      role="slider"
      tabIndex={0}
      data-testid="canvas-grain-dial"
      aria-label="Grain"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      style={{ width: DIAL_SIZE, height: DIAL_SIZE }}
      className="relative shrink-0 cursor-grab touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* The face, mid-grey in BOTH modes — see GRAIN_BACKDROP. The tile is
          black noise and the notch above it is white, so this is the one
          surface both can be read on. */}
      <div
        aria-hidden
        style={{ background: grain === null ? GRAIN_BACKDROP : `${grain}, ${GRAIN_BACKDROP}` }}
        className="absolute inset-[7px] rounded-full"
      />
      <svg
        aria-hidden
        width={DIAL_SIZE}
        height={DIAL_SIZE}
        viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
        className="absolute inset-0"
      >
        {/* The dots sit on the CARD rather than on the face, so unlike the notch
            they take the card's own ink and flip with it.

            Lit and unlit are one colour at two opacities rather than two tokens.
            Measured on the shipped canvas, `--foreground` and
            `--muted-foreground` are close enough that the ring read as sixteen
            identical dots — a progress indicator showing no progress. The gap
            has to be an alpha gap, which is what the lab's own pair was. */}
        {Array.from({ length: DIAL_DOTS }, (_, index) => {
          const progress = index / (DIAL_DOTS - 1);
          const at = dialPoint(
            centre,
            DIAL_MIN_ANGLE + (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE) * progress,
            DIAL_DOT_RADIUS,
          );
          return (
            <circle
              // The dot's index IS its position on the arc; there is nothing
              // else to key on and nothing ever reorders.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              cx={at.x}
              cy={at.y}
              r={1.1}
              fill="var(--foreground)"
              fillOpacity={progress <= value ? DIAL_DOT_LIT : DIAL_DOT_UNLIT}
            />
          );
        })}
        {/* White in both modes, like Arc's. The notch is the one thing in this
            panel that reads as hardware rather than as text, and flipping it
            with the appearance would lose that — it sits on the mid-grey face,
            which gives it something to read on either way. */}
        <line
          x1={notchFrom.x}
          y1={notchFrom.y}
          x2={notchTo.x}
          y2={notchTo.y}
          stroke="white"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/** One measured floor: what it scored, and whether it had anywhere left to go. */
function FloorReading({ reading }: { reading: CanvasFloorReading }) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-xs leading-5">
      <span className="text-muted-foreground">{reading.what}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        Lc{" "}
        <span className={reading.capped ? "text-foreground" : undefined}>
          {lcLabel(reading.achieved)}
        </span>{" "}
        <span className="text-muted-foreground/70">
          {reading.capped
            ? `— at this canvas's ceiling, ${lcLabel(reading.shortfall)} under a floor of ${lcLabel(reading.floor)}`
            : `of ${lcLabel(reading.floor)}`}
        </span>
      </span>
    </li>
  );
}

/**
 * What this canvas's copy actually measures — and the one state the engine
 * cannot report for itself.
 *
 * `deriveCanvasTokens` never throws: a floor its surface cannot physically carry
 * is clamped to the best that surface allows, because the gradient is the user's
 * to author and an exception would blank the window on a swatch click. That is
 * the right call and it has a cost — the ask silently goes unmet — and this is
 * where the cost is paid back.
 *
 * Two registers, for the two sizes the miss comes in.
 *
 * The **readout is always there**, every floor and what it scored, with a
 * ceiling annotated inline. That is where the shipped canvas's own hairline
 * shortfall lives: `--sidebar` sits a couple of hundredths of an Lc under 75 at
 * several vibrancies, which is true, worth being able to look up, and not worth
 * an alarm. Three numbers that are usually fine are also what make the fourth
 * state legible when it arrives.
 *
 * The **alert** is for a floor stranded by more than the emitted hex can even
 * express, which only the user's own choice of colour and vibrancy can cause. It
 * says what is unreachable, by how much, what it costs, and — when one exists —
 * offers the slider position that recovers it.
 */
function ContrastReport({
  report,
  eased,
  onEase,
}: {
  report: CanvasContrastReport;
  eased: number | null;
  onEase(vibrancy: number): void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-label uppercase text-muted-foreground">Contrast</p>
        <ul data-testid="canvas-contrast-readout" className="mt-1.5 flex flex-col">
          {report.readings.map((reading) => (
            <FloorReading key={reading.token} reading={reading} />
          ))}
        </ul>
      </div>

      {report.stranded.length === 0 ? null : (
        <div
          role="status"
          data-testid="canvas-contrast-stranded"
          className="flex gap-2.5 rounded-md border border-border bg-secondary/60 p-3"
        >
          {/* Filled: this is the one thing on the page that went wrong, and the
              only glyph in the editor that is not a control's own noun. */}
          <WarningIcon weight="fill" className="mt-0.5 size-4 shrink-0 text-primary-text" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {report.stranded.length === 1
                ? `${report.stranded[0].what} can't reach its contrast floor on this canvas.`
                : `${report.stranded
                    .map((reading) => reading.what.toLowerCase())
                    .join(" and ")} can't reach their contrast floors on this canvas.`}
            </p>
            {eased === null ? null : (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => onEase(eased)}
                data-testid="canvas-contrast-ease"
              >
                <SlidersHorizontalIcon />
                Ease vibrancy to {percentLabel(eased)}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
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
 * looks. `padAnchor` and `pointerBearing` both position from where the pointer
 * IS, minus a grab offset captured once at press time, so neither can accumulate
 * its own output. The one control that genuinely cannot read the preview is the
 * hex field — see {@link PrimaryColourRow}.
 *
 * The store is read imperatively for every write, so no handler closes over a
 * snapshot that a concurrent hydrate has already replaced.
 */
export function CanvasEditor({
  scope,
  canvas,
  resolved,
}: {
  scope: ThemeScope;
  /** What this scope has STORED — the canvas the controls sit on. */
  canvas: Canvas;
  /** What that canvas renders as right now, `auto` already answered. */
  resolved: ResolvedAppearance;
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

  const report = React.useMemo(() => canvasContrastReport(live, resolved), [live, resolved]);
  const eased = React.useMemo(() => easedVibrancy(live, resolved), [live, resolved]);
  const vibrancyChip = React.useMemo(
    () => effectiveStopHexes(live, resolved)[live.primaryIndex],
    [live, resolved],
  );

  return (
    <>
      <div className="flex flex-col gap-3 pb-4">
        <GradientPad
          canvas={live}
          resolved={resolved}
          onMove={(index, x, y) => edit((current) => moveStop(current, index, x, y))}
          onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
          onSettle={settle}
        />
        <StopRow
          canvas={live}
          resolved={resolved}
          onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
          onAdd={() => commit(addStop)}
          onRemove={() => commit(removeStop)}
        />
        <PrimaryColourRow
          hex={canvas.stops[canvas.primaryIndex].hex}
          onPick={(next) => commit((current) => withPrimaryHex(current, next))}
          onPreview={(next) => edit((current) => withPrimaryHex(current, next))}
          onAbandon={abandon}
        />
      </div>

      <SettingsRow label="Vibrancy" htmlFor="canvas-vibrancy">
        <UnitSlider
          id="canvas-vibrancy"
          label="Vibrancy"
          value={live.vibrancy}
          chip={
            <span
              aria-hidden
              className="size-6 shrink-0 rounded-md ring-1 ring-black/15"
              style={{ background: vibrancyChip }}
            />
          }
          onInput={(vibrancy) => edit((current) => ({ ...current, vibrancy }))}
          onSettle={settle}
        />
      </SettingsRow>

      {/* No `htmlFor`: the dial is a `div[role="slider"]`, which a label cannot
          be bound to. It carries its own `aria-label` instead. */}
      <SettingsRow label="Grain">
        <GrainDial
          value={live.grain}
          onInput={(grain) => edit((current) => ({ ...current, grain }))}
          onSettle={settle}
        />
        <span className="w-9 text-right text-ui text-muted-foreground tabular-nums">
          {percentLabel(live.grain)}
        </span>
      </SettingsRow>

      <div className="border-t border-border/60 pt-4">
        <ContrastReport
          report={report}
          eased={eased}
          onEase={(vibrancy) => commit((current) => ({ ...current, vibrancy }))}
        />
      </div>
    </>
  );
}

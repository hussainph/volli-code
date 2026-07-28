/**
 * Arc's Space editor, standing up the vivid canvas model — the controls that
 * make `arc/model.ts` worth having.
 *
 * The question is not "is this gradient pretty". It is whether a canvas vivid
 * enough to be worth the trouble can still carry the app's own chrome — and
 * once the light dials arrived, whether the surfaces standing on it separate
 * from each other and from the paper card floating above. So every edit commits
 * immediately (see arc/paint.ts) rather than previewing: the canvas is on the
 * document while you tune it, not inside a preview box.
 *
 * The specimen column on the right is the reason the dials are usable at all.
 * Lift, spread and shadow are each a statement about how two surfaces sit NEXT
 * to one another, so a control whose effect you had to navigate away to see was
 * a control tuned from memory. `WindowSpecimen` puts the whole tier stack —
 * chrome, rail, sidebar, card, tab strip, copy — under the slider, and quotes
 * every color from the same `--lab-*` properties and token classes the real
 * components read.
 *
 * It still is not the verdict, and the docstring on that component says exactly
 * where the line is: geometry is mocked, values are not. Judge color, contrast
 * and separation here; judge proportion and layout on the App shell scratch,
 * which mounts the real thing.
 *
 * Dormant until you touch something. With nothing stored — or right after a
 * reset — the canvas is OFF and the app's own backdrop shows through, because
 * "reset" has to mean the seam is gone rather than "the default gradient is
 * applied". The first control you move commits.
 */
import * as React from "react";
import type { Icon } from "@phosphor-icons/react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { MoonStarsIcon } from "@phosphor-icons/react/dist/csr/MoonStars";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";

import { apcaLc, hexToOklch, type ThemeTokens } from "@volli/shared";

import {
  addStop,
  arcCanvasBackground,
  arcGrainLayer,
  arcInk,
  DEFAULT_ARC_CANVAS,
  effectiveStopHexes,
  ARC_SEAMS,
  MAX_STOPS,
  moveStop,
  removeStop,
  resolveArcMode,
  withPrimaryHex,
  withPrimaryIndex,
  type ArcCanvasState,
  type ArcInk,
  type ArcMode,
  type ArcResolvedMode,
  type ArcSeam,
  type ArcStop,
} from "../arc/model";
import { applyArcCanvas, loadArcCanvas, saveArcCanvas } from "../arc/paint";
import { arcElevation } from "../arc/surfaces";
import { deriveArcLabelInk, deriveArcTokens, lightFloors } from "../arc/tokens";
import { labTheme, setLabTheme } from "../theme-choice";

export const title = "Canvas — Arc gradient editor";
export const note = "A vivid 1–3 color canvas, and whether on-canvas nav survives it";
export const viewport = "window" as const;

/** The card is a fixed width, so the SVG controls inside it can be too — see the slider. */
const CARD_WIDTH = 340;
const CARD_PADDING = 16;
const CARD_CONTENT = CARD_WIDTH - CARD_PADDING * 2;

const DIAL_SIZE = 56;
const CONTROL_GAP = 12;
const SLIDER_WIDTH = CARD_CONTENT - DIAL_SIZE - CONTROL_GAP;
const SLIDER_HEIGHT = 44;
/** Thumb geometry — the travel is inset by half of it so the pill stays on the track. */
const THUMB_WIDTH = 24;
const WAVE_PERIODS = 8;
const WAVE_MAX_AMPLITUDE = 13;

const DIAL_DOTS = 16;
const DIAL_MIN_ANGLE = -135;
const DIAL_MAX_ANGLE = 135;

/** Travel under which a press is a click rather than a drag. */
const CLICK_SLOP = 4;

const ORB_SIZE = 28;
const PRIMARY_ORB_SIZE = 44;

/**
 * The pad is a MINIMAP: a stop's position on it is where its pool lands in the
 * window, so the pad has to have the window's proportions or it lies about the
 * one thing it exists to show. 16:10 is the app's real default (1280×800).
 */
const PAD_ASPECT = "16 / 10";
const PAD_DOT_SPACING = 14;
const PAD_DOTS = "radial-gradient(circle, rgb(255 255 255 / 0.3) 1px, transparent 1px)";

/** Arc's two swatch pages: a pastel row, then the deeper row Volli's own seeds live in. */
const SWATCH_PAGES: readonly (readonly string[])[] = [
  [
    "#f2ede4",
    "#f2a7c3",
    "#a06bb8",
    "#e05561",
    "#ef8a4b",
    "#f2d060",
    "#6fd692",
    "#74b6e8",
    "#5f6ac4",
  ],
  [
    "#e8652a",
    "#c53d43",
    "#8a5a44",
    "#4a7d5b",
    "#2e6f8e",
    "#4653a2",
    "#7d4fa0",
    "#3d3d46",
    "#97a3b4",
  ],
];

const MODES: readonly { mode: ArcMode; label: string; Icon: Icon }[] = [
  { mode: "auto", label: "Auto", Icon: SparkleIcon },
  { mode: "light", label: "Light", Icon: SunIcon },
  { mode: "dark", label: "Dark", Icon: MoonStarsIcon },
];

const NAV_ROWS: readonly { label: string; Icon: Icon }[] = [
  { label: "VLT-14 · Arc canvas", Icon: TicketIcon },
  { label: "Sessions", Icon: TerminalWindowIcon },
  { label: "Settings", Icon: GearIcon },
];

/**
 * The editor's own chrome, which follows the canvas the way Arc's popover does:
 * a pale veil with dark controls over a light Space, the inverse over a dark
 * one. The card is a translucent sheet of the surface behind it, so it cannot
 * stay one color while that surface flips — a dark card on a pastel canvas
 * reads as a foreign object rather than a layer of it.
 *
 * One table rather than a ternary at each call site, for the same reason
 * `ARC_TUNING` is one table: this is a surface that gets adjusted by eye, and
 * the adjustment should be a line here rather than a hunt through eight
 * components. Every value is a literal class string because Tailwind only
 * generates what it can see written out.
 */
interface CardChrome {
  /** The card itself: veil, hairline, and the ink everything inside inherits. */
  card: string;
  /** A subtle inset fill ON the card — the mode-row track, the readout chips. */
  well: string;
  /** One mode-row item: dim until pressed, then the pill lifts and the ink fills in. */
  segment: string;
  /** A filled round button — the +/− pair. */
  control: string;
  /** A text-only button — the swatch chevrons and Reset. */
  ghost: string;
  /** Supporting text. */
  mute: string;
  /** The dimmest text: separators, the losing Lc, the dormant notice. */
  faint: string;
  /** The active swatch's outline. */
  swatchRing: string;
  /** Focus ring color for the two 0–1 controls. */
  focus: string;
  /** The vibrancy slider's sine stroke, as a CSS color. */
  wave: string;
  /**
   * The grain dial's face, as a CSS color. A MID-tone in BOTH modes, and that is
   * the constraint that picks it: the tile is black noise and the indicator is a
   * white notch, so a face that went pale with the card would lose the notch and
   * one that went dark would lose the grain.
   */
  dialFace: string;
  /** The dial's scale dots, which sit on the card rather than on the face. */
  dialDot: string;
  dialDotOn: string;
}

const CHROME: Record<ArcResolvedMode, CardChrome> = {
  dark: {
    card: "border-white/10 bg-black/45 text-white",
    well: "bg-white/8",
    segment: "text-white/55 hover:text-white aria-pressed:bg-white/18 aria-pressed:text-white",
    control: "bg-white/10 text-white hover:bg-white/20 disabled:hover:bg-white/10",
    ghost: "text-white/50 hover:bg-white/10 hover:text-white",
    mute: "text-white/55",
    faint: "text-white/35",
    swatchRing: "aria-pressed:outline-white",
    focus: "focus-visible:ring-white/60",
    wave: "rgb(255 255 255 / 0.5)",
    dialFace: "rgb(255 255 255 / 0.45)",
    dialDot: "rgb(255 255 255 / 0.3)",
    dialDotOn: "rgb(255 255 255 / 0.85)",
  },
  light: {
    card: "border-black/10 bg-white/65 text-black",
    well: "bg-black/6",
    segment: "text-black/55 hover:text-black aria-pressed:bg-white/75 aria-pressed:text-black",
    control: "bg-black/8 text-black hover:bg-black/16 disabled:hover:bg-black/8",
    ghost: "text-black/50 hover:bg-black/8 hover:text-black",
    mute: "text-black/60",
    faint: "text-black/40",
    swatchRing: "aria-pressed:outline-black",
    focus: "focus-visible:ring-black/50",
    wave: "rgb(0 0 0 / 0.45)",
    dialFace: "rgb(0 0 0 / 0.3)",
    dialDot: "rgb(0 0 0 / 0.25)",
    dialDotOn: "rgb(0 0 0 / 0.8)",
  },
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Whether the OS is in dark mode, subscribed so an `auto` canvas re-renders with it. */
function useSystemDark(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

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
 * `slop` is what separates the pad's two gestures from the slider's one. At 0
 * the value is set on press and every move, which is what a track wants
 * (clicking anywhere on it jumps there). Above 0 nothing moves until the
 * pointer has travelled that far, and a release before it does is reported as a
 * click instead — so pressing an orb selects it and dragging it moves it.
 *
 * The grab offset handed to `onDrag` is what keeps that drag from starting with
 * a jump. A press near an orb's edge is up to its radius away from its centre,
 * so a handler that treats the pointer AS the centre teleports the orb by that
 * much on the first frame past the slop — measured at 14px for a 6px move.
 * Absolute controls (the slider's track, the dial's angle) are positioned by
 * where the pointer IS and ignore it; anything being carried subtracts it.
 */
function useDrag({
  slop = 0,
  onDrag,
  onClick,
}: {
  slop?: number;
  onDrag(event: React.PointerEvent<HTMLElement>, grab: GrabOffset): void;
  onClick?(): void;
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
      // `preventDefault` above suppresses the native focus that a press would
      // otherwise give, and these controls are keyboard-operable — without this
      // the arrow keys only work after a Tab, never after a click.
      event.currentTarget.focus();
      const rect = event.currentTarget.getBoundingClientRect();
      const grab = {
        dx: event.clientX - (rect.left + rect.width / 2),
        dy: event.clientY - (rect.top + rect.height / 2),
      };
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        grab,
        dragging: false,
      };
      if (slop === 0) {
        gesture.current.dragging = true;
        onDrag(event, grab);
      }
    },
    onPointerMove(event) {
      const active = gesture.current;
      if (active === null || active.id !== event.pointerId) return;
      if (!active.dragging) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < slop) return;
        active.dragging = true;
      }
      onDrag(event, active.grab);
    },
    onPointerUp(event) {
      const active = gesture.current;
      if (active === null || active.id !== event.pointerId) return;
      gesture.current = null;
      if (!active.dragging) onClick?.();
    },
    onPointerCancel() {
      gesture.current = null;
    },
  };
}

/** Arrow keys on a 0–1 control, so the sliders are reachable without a pointer. */
function stepOnArrow(
  event: React.KeyboardEvent,
  value: number,
  onChange: (next: number) => void,
  // The lift dial is the one control here that runs through zero, so the bounds
  // are a parameter rather than a `clamp01` baked in.
  min = 0,
  max = 1,
): void {
  const step = event.shiftKey ? 0.1 : 0.02;
  const direction =
    event.key === "ArrowLeft" || event.key === "ArrowDown"
      ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : 0;
  if (direction === 0) return;
  event.preventDefault();
  onChange(Math.min(max, Math.max(min, value + direction * step)));
}

/**
 * A plain labelled track — the shape the four light-mode dials share.
 *
 * Deliberately not another wave or another dial. The vibrancy slider and the
 * grain dial are shaped like what they do because each of them is ONE thing
 * with a memorable identity; four more sculpted controls in a 340px card would
 * be four things to learn and a column of ornament. These read as a settings
 * block, which is what they are.
 *
 * The origin is `min`, or zero when the range spans it: a signed dial that
 * filled from its left end would draw the same bar for "slightly recessed" and
 * "strongly frosted" and only the thumb would say which.
 */
function TuneSlider({
  label,
  value,
  min,
  max,
  readout,
  chrome,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** What the number means, in the units the owner is judging in. */
  readout: string;
  chrome: CardChrome;
  onChange(next: number): void;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const toFraction = (raw: number) => (raw - min) / (max - min);
  const handlers = useDrag({
    onDrag(event) {
      const track = trackRef.current;
      if (track === null) return;
      const rect = track.getBoundingClientRect();
      const fraction = clamp01((event.clientX - rect.left) / rect.width);
      onChange(min + fraction * (max - min));
    },
  });

  const origin = toFraction(Math.min(Math.max(0, min), max));
  const position = toFraction(value);
  const [from, to] = origin <= position ? [origin, position] : [position, origin];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-label ${chrome.mute}`}>{label}</span>
        <span className={`font-mono text-label tabular-nums ${chrome.faint}`}>{readout}</span>
      </div>
      <div
        ref={trackRef}
        {...handlers}
        onKeyDown={(event) => stepOnArrow(event, value, onChange, min, max)}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={readout}
        className={`relative h-4 cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-2 ${chrome.focus}`}
      >
        <div className={`absolute inset-x-0 top-1.5 h-1 rounded-full ${chrome.well}`} />
        {/* `bg-current` at partial weight: the fill inherits the card's own ink,
            which the CHROME table has already flipped for the mode, so this
            needs no entry of its own. */}
        <div
          aria-hidden
          style={{ left: `${from * 100}%`, right: `${(1 - to) * 100}%` }}
          className="absolute top-1.5 h-1 rounded-full bg-current opacity-45"
        />
        {/* White in both modes, like the vibrancy thumb — same hardware family. */}
        <div
          aria-hidden
          style={{ left: `calc(${position * 100}% - 6px)` }}
          className="absolute top-0.5 size-3 rounded-full bg-white shadow"
        />
      </div>
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** What each seam is, in the four words a segment has room for. */
const SEAM_LABELS: Record<ArcSeam, { label: string; hint: string }> = {
  continuous: {
    label: "Canvas",
    hint: "The sidebar rejoins the gradient; only the chrome band and rail lift. The gutter beside the card stops being a third material because the sidebar is the same one.",
  },
  inset: {
    label: "Inset",
    hint: "Nothing floats: the card gives up its gutter, radius and shadow and meets the sidebar at a hairline. Canvas becomes the chrome, paper becomes the work.",
  },
  shell: {
    label: "Shell",
    hint: "Slack's arrangement: the sidebar and the card become one inset unit with a colour change down the middle — a single rounded outline, no gutter between them, and the canvas running all the way around as a frame.",
  },
  float: {
    label: "Float",
    hint: "What the tiers first shipped as: a filled square sidebar beside a floating rounded card. Kept to judge the others against.",
  },
};

/**
 * How the sidebar, the canvas and the card meet.
 *
 * Above the light dials rather than inside them, because it is the only
 * structural control on the card and it applies in both appearances — the five
 * below it are all chromatic and all light-only.
 *
 * The readout under the segments is the diagnosis, not decoration. The complaint
 * that produced this control was "three background colours", and the cause is a
 * single number: how far the sidebar sits between the canvas and the paper.
 * At either end it is one of the two materials the window already has. Anywhere
 * in between — 39% at the shipped defaults — it is a third one, and that is
 * visible as soon as a strip of bare gradient runs alongside it.
 */
function SeamRow({
  seam,
  towardPaper,
  resolved,
  chrome,
  onChange,
}: {
  seam: ArcSeam;
  towardPaper: number;
  resolved: ArcResolvedMode;
  chrome: CardChrome;
  onChange(next: ArcSeam): void;
}) {
  const detail =
    resolved === "dark"
      ? "geometry only in dark — the veil already separates the tiers"
      : towardPaper === 0
        ? "sidebar sits ON the canvas — two materials"
        : `sidebar ${percent(towardPaper)} of the way from canvas to paper`;

  return (
    <div className="flex flex-col gap-2">
      <span className={`text-label uppercase ${chrome.faint}`}>Seam</span>
      <div className={`flex items-center gap-1 rounded-full p-1 ${chrome.well}`}>
        {ARC_SEAMS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => onChange(candidate)}
            aria-pressed={candidate === seam}
            title={SEAM_LABELS[candidate].hint}
            className={`flex-1 rounded-full px-2 py-1.5 text-label transition-colors ${chrome.segment}`}
          >
            {SEAM_LABELS[candidate].label}
          </button>
        ))}
      </div>
      <p className={`text-label ${chrome.faint}`}>{detail}</p>
    </div>
  );
}

/**
 * The five dials that only light mode uses, in one block.
 *
 * Shown in both modes rather than hidden in dark, and the note says why: they
 * are still the state you are editing, and a control that vanishes when you
 * flip appearance reads as a control you lost rather than one that does not
 * apply. `arc/paint.ts` neutralizes them for dark; this only has to be honest
 * about it.
 */
function LightTuning({
  state,
  resolved,
  chrome,
  onChange,
}: {
  state: ArcCanvasState;
  resolved: ArcResolvedMode;
  chrome: CardChrome;
  onChange(patch: Partial<ArcCanvasState>): void;
}) {
  const floors = lightFloors(state.textWeight);
  // Measured off the derived set rather than off the slider, so the readout is
  // the thing on screen and not a restatement of the input.
  const light = deriveArcTokens(state, "light");
  const railDrop = hexToOklch(light["--background"]).L - hexToOklch(light["--rail"]).L;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-label uppercase ${chrome.faint}`}>Light surfaces</span>
        {resolved === "dark" ? (
          <span className={`text-label ${chrome.faint}`}>inert in dark</span>
        ) : null}
      </div>
      <TuneSlider
        label="Lift"
        value={state.lift}
        min={-1}
        max={1}
        readout={
          state.lift === 0 ? "flush" : `${state.lift > 0 ? "frost" : "sink"} ${percent(state.lift)}`
        }
        chrome={chrome}
        onChange={(lift) => onChange({ lift })}
      />
      <TuneSlider
        label="Card tint"
        value={state.cardTint}
        min={0}
        max={0.25}
        readout={percent(state.cardTint)}
        chrome={chrome}
        onChange={(cardTint) => onChange({ cardTint })}
      />
      <TuneSlider
        label="Surface spread"
        value={state.surfaceSpread}
        min={0}
        max={1}
        // The rung the complaint was actually about: the tab strip under a tab,
        // which the mirrored ladder put ΔL 0.019 from the page it sits on.
        readout={`rail ΔL ${railDrop.toFixed(3)}`}
        chrome={chrome}
        onChange={(surfaceSpread) => onChange({ surfaceSpread })}
      />
      <TuneSlider
        label="Text weight"
        value={state.textWeight}
        min={0}
        max={1}
        // The floors, not the slider position: Lc is the unit the decision is
        // actually made in, and "0.50" says nothing you can check on screen.
        // Body / label / secondary, all measured on `--card`.
        readout={`Lc ${floors.body.toFixed(0)} · ${floors.secondary.toFixed(0)} · lbl ${Math.round((1 - floors.labelTowardSecondary) * 100)}%`}
        chrome={chrome}
        onChange={(textWeight) => onChange({ textWeight })}
      />
      <TuneSlider
        label="Shadow"
        value={state.shadow}
        min={0}
        max={1}
        readout={percent(state.shadow)}
        chrome={chrome}
        onChange={(shadow) => onChange({ shadow })}
      />
    </div>
  );
}

function ModeRow({
  mode,
  chrome,
  onChange,
}: {
  mode: ArcMode;
  chrome: CardChrome;
  onChange(next: ArcMode): void;
}) {
  return (
    <div className={`flex items-center gap-1 rounded-full p-1 ${chrome.well}`}>
      {MODES.map(({ mode: candidate, label, Icon: ModeIcon }) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onChange(candidate)}
          aria-pressed={candidate === mode}
          title={label}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-label transition-colors ${chrome.segment}`}
        >
          <ModeIcon weight="fill" size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

function PadOrb({
  stop,
  index,
  primary,
  padRef,
  onMove,
  onPromote,
}: {
  stop: ArcStop;
  index: number;
  primary: boolean;
  padRef: React.RefObject<HTMLDivElement | null>;
  onMove(index: number, x: number, y: number): void;
  onPromote(index: number): void;
}) {
  const handlers = useDrag({
    slop: CLICK_SLOP,
    // The orb is CARRIED, so the grab offset comes back out of the pointer
    // position — grab it near its edge and it stays gripped there.
    onDrag(event, grab) {
      const pad = padRef.current;
      if (pad === null) return;
      const rect = pad.getBoundingClientRect();
      onMove(
        index,
        (event.clientX - grab.dx - rect.left) / rect.width,
        (event.clientY - grab.dy - rect.top) / rect.height,
      );
    },
    onClick: () => onPromote(index),
  });

  const size = primary ? PRIMARY_ORB_SIZE : ORB_SIZE;
  return (
    <button
      type="button"
      {...handlers}
      aria-label={`Stop ${index + 1}, ${stop.hex}${primary ? " (primary)" : ""}`}
      aria-pressed={primary}
      // The orbs stay AUTHORED, never mode-transformed: they are the colors you
      // picked, and an orb that dimmed itself in dark mode would make the pad
      // disagree with the swatch row you picked it from.
      style={{
        left: `${stop.x * 100}%`,
        top: `${stop.y * 100}%`,
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        background: stop.hex,
      }}
      className="absolute touch-none rounded-full shadow-lg ring-2 ring-white outline-none transition-[width,height,margin] duration-200 ease-swift focus-visible:ring-4"
    />
  );
}

function GradientPad({
  state,
  gradient,
  onMove,
  onPromote,
}: {
  state: ArcCanvasState;
  gradient: string;
  onMove(index: number, x: number, y: number): void;
  onPromote(index: number): void;
}) {
  const padRef = React.useRef<HTMLDivElement>(null);
  return (
    <div
      ref={padRef}
      style={{ aspectRatio: PAD_ASPECT }}
      className="relative w-full overflow-hidden rounded-xl bg-black/40"
    >
      {/* Dimmed, because the pad is a map rather than a second preview — the
          window behind this card is the preview, and two full-strength
          gradients competing would make neither readable. */}
      <div aria-hidden className="absolute inset-0 opacity-70" style={{ background: gradient }} />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage: PAD_DOTS,
          backgroundSize: `${PAD_DOT_SPACING}px ${PAD_DOT_SPACING}px`,
        }}
      />
      {state.stops.map((stop, index) => (
        <PadOrb
          // The index IS a stop's identity here — `primaryIndex`, `moveStop`
          // and `removeStop` all address stops by slot, and a stop carries no
          // id of its own precisely so the persisted shape stays trivial.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          stop={stop}
          index={index}
          primary={index === state.primaryIndex}
          padRef={padRef}
          onMove={onMove}
          onPromote={onPromote}
        />
      ))}
    </div>
  );
}

function StopCountRow({
  count,
  chrome,
  onAdd,
  onRemove,
}: {
  count: number;
  chrome: CardChrome;
  onAdd(): void;
  onRemove(): void;
}) {
  const button = `flex size-7 items-center justify-center rounded-full transition-colors disabled:opacity-30 ${chrome.control}`;
  return (
    <div className="flex items-center justify-between">
      <span className={`text-label uppercase ${chrome.mute}`}>
        {count} {count === 1 ? "color" : "colors"}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={count <= 1}
          // Names which one goes: the last stop, unless the last stop is the
          // primary — then the one below it, so "−" never recolors the window.
          aria-label="Remove the last non-primary color"
          className={button}
        >
          <MinusIcon weight="fill" size={14} />
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={count >= MAX_STOPS}
          aria-label="Add a color"
          className={button}
        >
          <PlusIcon weight="fill" size={14} />
        </button>
      </div>
    </div>
  );
}

function SwatchRow({
  active,
  chrome,
  onPick,
}: {
  active: string;
  chrome: CardChrome;
  onPick(hex: string): void;
}) {
  const normalized = active.toLowerCase();
  const [page, setPage] = React.useState(0);
  const [shown, setShown] = React.useState<string | null>(null);

  // The page FOLLOWS the primary instead of being seeded from it once. A
  // one-shot initializer only fires on mount, so promoting a stop whose color
  // lives on the other page left nine swatches with the ring on none of them —
  // the control silently disagreeing with the canvas.
  //
  // Adjusted during render rather than in an effect (React's documented
  // pattern for deriving state from changed props): an effect would paint one
  // frame of the wrong page first. Keyed on the primary having CHANGED, so
  // paging by hand still works — the chevrons move the page and it stays there
  // until a different color becomes primary.
  if (shown !== normalized) {
    setShown(normalized);
    const matching = SWATCH_PAGES.findIndex((swatches) => swatches.includes(normalized));
    if (matching !== -1 && matching !== page) setPage(matching);
  }

  const turn = (step: number) =>
    setPage((current) => (current + step + SWATCH_PAGES.length) % SWATCH_PAGES.length);
  const chevron = `flex size-5 shrink-0 items-center justify-center rounded-full transition-colors ${chrome.ghost}`;

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => turn(-1)}
        aria-label="Previous swatches"
        className={chevron}
      >
        <CaretLeftIcon weight="fill" size={12} />
      </button>
      <div className="grid flex-1 grid-cols-9 gap-1.5">
        {SWATCH_PAGES[page].map((hex) => (
          <button
            key={hex}
            type="button"
            onClick={() => onPick(hex)}
            aria-label={hex}
            aria-pressed={hex === normalized}
            style={{ background: hex }}
            className={`aspect-square w-full rounded-full outline-offset-2 transition-transform hover:scale-110 aria-pressed:outline-2 ${chrome.swatchRing}`}
          />
        ))}
      </div>
      <button type="button" onClick={() => turn(1)} aria-label="More swatches" className={chevron}>
        <CaretRightIcon weight="fill" size={12} />
      </button>
    </div>
  );
}

/** A sine whose amplitude IS the value: flat at 0, deep at 1. */
function wavePath(amplitude: number): string {
  const steps = 120;
  const center = SLIDER_HEIGHT / 2;
  let path = "";
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const x = progress * SLIDER_WIDTH;
    const y = center + Math.sin(progress * WAVE_PERIODS * 2 * Math.PI) * amplitude;
    path += `${step === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return path;
}

function VibrancySlider({
  value,
  chrome,
  onChange,
}: {
  value: number;
  chrome: CardChrome;
  onChange(next: number): void;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const travel = SLIDER_WIDTH - THUMB_WIDTH;
  const handlers = useDrag({
    onDrag(event) {
      const track = trackRef.current;
      if (track === null) return;
      const rect = track.getBoundingClientRect();
      onChange(clamp01((event.clientX - rect.left - THUMB_WIDTH / 2) / travel));
    },
  });

  return (
    <div
      ref={trackRef}
      {...handlers}
      onKeyDown={(event) => stepOnArrow(event, value, onChange)}
      role="slider"
      tabIndex={0}
      aria-label="Vibrancy"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      style={{ width: SLIDER_WIDTH, height: SLIDER_HEIGHT }}
      className={`relative shrink-0 cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-2 ${chrome.focus}`}
    >
      <svg
        aria-hidden
        width={SLIDER_WIDTH}
        height={SLIDER_HEIGHT}
        viewBox={`0 0 ${SLIDER_WIDTH} ${SLIDER_HEIGHT}`}
        className="absolute inset-0"
      >
        <path
          d={wavePath(WAVE_MAX_AMPLITUDE * value)}
          fill="none"
          stroke={chrome.wave}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      {/* White in BOTH modes, like Arc's: the thumb and the dial's notch are the
          only two things in the card that read as hardware rather than as text,
          and flipping them with the appearance would lose that. */}
      <div
        aria-hidden
        style={{ width: THUMB_WIDTH, left: value * travel }}
        className="absolute inset-y-0 rounded-full bg-white shadow-lg"
      />
    </div>
  );
}

/** The shorter way round the circle between two bearings, in degrees. */
function angularDistance(from: number, to: number): number {
  return Math.abs(((from - to + 540) % 360) - 180);
}

/**
 * A pointer bearing (0° up, clockwise positive) → the grain it sets.
 *
 * The dial's travel is a 270° arc, which leaves a 90° dead wedge below it —
 * and `atan2`'s ±180° seam falls exactly in the MIDDLE of that wedge. Clamping
 * the raw value was therefore not "pinning": a drag sweeping across the bottom
 * crossed from +179° to −179°, and the two clamped to opposite ENDS, so grain
 * snapped 1 → 0 under a pointer that had barely moved.
 *
 * Measuring the short way round instead makes the wedge behave the way the
 * clamp was meant to: anything inside it takes whichever end of the arc it is
 * actually nearer to, so the value stops at the end you dragged past and stays
 * there.
 */
function grainForAngle(degrees: number): number {
  if (degrees >= DIAL_MIN_ANGLE && degrees <= DIAL_MAX_ANGLE) {
    return (degrees - DIAL_MIN_ANGLE) / (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE);
  }
  return angularDistance(degrees, DIAL_MAX_ANGLE) <= angularDistance(degrees, DIAL_MIN_ANGLE)
    ? 1
    : 0;
}

function GrainDial({
  value,
  chrome,
  onChange,
}: {
  value: number;
  chrome: CardChrome;
  onChange(next: number): void;
}) {
  const dialRef = React.useRef<HTMLDivElement>(null);
  const handlers = useDrag({
    // A knob is grabbed, not tapped: with slop, a press that never moves does
    // nothing at all rather than jumping the value to wherever it landed. That
    // is the opposite of the slider above, where clicking anywhere on the track
    // is the fastest way to set it — a track has a position under the pointer
    // and a dial only has an angle around it.
    slop: CLICK_SLOP,
    onDrag(event) {
      const dial = dialRef.current;
      if (dial === null) return;
      const rect = dial.getBoundingClientRect();
      // atan2(dx, -dy): 0° is straight up and clockwise is positive, matching
      // how the notch is drawn.
      const degrees =
        (Math.atan2(
          event.clientX - (rect.left + rect.width / 2),
          -(event.clientY - (rect.top + rect.height / 2)),
        ) *
          180) /
        Math.PI;
      onChange(grainForAngle(degrees));
    },
  });

  const center = DIAL_SIZE / 2;
  const angle = DIAL_MIN_ANGLE + (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE) * value;
  const radians = (angle * Math.PI) / 180;
  const grain = arcGrainLayer(value);

  return (
    <div
      ref={dialRef}
      {...handlers}
      onKeyDown={(event) => stepOnArrow(event, value, onChange)}
      role="slider"
      tabIndex={0}
      aria-label="Grain"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      style={{ width: DIAL_SIZE, height: DIAL_SIZE }}
      className={`relative shrink-0 cursor-grab touch-none rounded-full outline-none focus-visible:ring-2 ${chrome.focus}`}
    >
      {/* The knob face carries the texture at its current amount — the dial
          shows what it is setting, which is the only way to judge a value this
          subtle at this size. `dialFace` lands mid-grey in BOTH modes because
          the tile is black noise and the notch is white: it has to be something
          each of them can be seen on. */}
      <div
        aria-hidden
        style={{ background: grain === null ? chrome.dialFace : `${grain}, ${chrome.dialFace}` }}
        className="absolute inset-[7px] rounded-full"
      />
      <svg
        aria-hidden
        width={DIAL_SIZE}
        height={DIAL_SIZE}
        viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
        className="absolute inset-0"
      >
        {Array.from({ length: DIAL_DOTS }, (_, index) => {
          const progress = index / (DIAL_DOTS - 1);
          const dotRadians =
            ((DIAL_MIN_ANGLE + (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE) * progress) * Math.PI) / 180;
          return (
            <circle
              key={index}
              cx={center + Math.sin(dotRadians) * 25.5}
              cy={center - Math.cos(dotRadians) * 25.5}
              r={1.1}
              fill={progress <= value ? chrome.dialDotOn : chrome.dialDot}
            />
          );
        })}
        {/* White in both modes — see the slider's thumb. It sits on `dialFace`,
            which is mid-grey either way, so it always has something to read on. */}
        <line
          x1={center + Math.sin(radians) * 12}
          y1={center - Math.cos(radians) * 12}
          x2={center + Math.sin(radians) * 19}
          y2={center - Math.cos(radians) * 19}
          stroke="white"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/** One on-canvas tier's lift overlay, exactly as `lab.css` paints it on the real thing. */
function tier(index: 1 | 2): React.CSSProperties {
  return { backgroundImage: `linear-gradient(var(--lab-lift-${index}), var(--lab-lift-${index}))` };
}

/**
 * The window in miniature — every tier the light dials move, on one screen.
 *
 * It exists because the dials were not usable without it. Lift, spread and
 * shadow are all statements about how two surfaces sit NEXT to each other, and
 * a control you have to leave the page to evaluate is a control you tune by
 * memory: drag, navigate to App shell, look, navigate back, guess. This puts
 * the comparison under the slider.
 *
 * **Geometry is mocked; not one color is.** Every fill, ink and shadow here is
 * a `var(--lab-*)` or an app token class — the same properties `arc/paint.ts`
 * writes and the same ones `lab.css` hands the real components — so this can
 * disagree with the app about proportion and never about value. That is the
 * only trade the lab's contract allows, and it is why the seam's own selectors
 * are deliberately NOT reused here: a specimen wearing `data-slot="sidebar-
 * inset"` would be claiming to be the card rather than quoting it.
 *
 * So: judge color, contrast and separation here. Judge layout on App shell.
 */
function WindowSpecimen({ ink, seam }: { ink: ArcInk; seam: ArcSeam }) {
  // The seam's geometry, quoted from `lab.css` at the miniature's scale — the
  // one place this file deliberately restates a rule rather than reading a
  // property. It has to: the seam's real rules are keyed on `data-slot`
  // selectors this specimen must not wear (see above), so the alternative to
  // restating them is a specimen that shows the same picture for all four
  // options and settles nothing.
  //
  // The shadows stay INLINE while the geometry is classes, and that split is
  // not cosmetic: `shadow-[var(--lab-shadow-card)]` compiles, matches, and
  // paints nothing. Tailwind routes an arbitrary shadow through its own
  // `--tw-shadow` colour machinery, which cannot parse a two-layer value it
  // did not author — measured `rgba(0, 0, 0, 0) 0px 0px 0px 0px`. A specimen
  // that silently drops the property it exists to show is the lab lying.
  const shell = seam === "shell";
  const floats = seam !== "inset";
  const cardGeometry = shell
    ? "m-1 ml-0 rounded-r-lg border border-l-0 border-border"
    : floats
      ? "m-1 rounded-lg border border-border"
      : "border-l border-border";
  const sidebarGeometry = shell
    ? "m-1 mr-0 overflow-hidden rounded-l-lg border border-r-0 border-border"
    : "";
  // The seam-side clip, quoted from `lab.css` at this scale — without it the
  // two halves' shadows cross into each other and draw a bar down the middle of
  // the one thing the shell claims not to have.
  const clipRight = shell ? "inset(-60px 0 -60px -60px)" : undefined;
  const clipLeft = shell ? "inset(-60px -60px -60px 0)" : undefined;

  return (
    <div
      style={{ aspectRatio: PAD_ASPECT, boxShadow: "var(--lab-shadow-overlay)" }}
      className="flex w-full flex-col overflow-hidden rounded-xl"
    >
      {/* Chrome band — tier 1, like the app's 40px strip. */}
      <div
        style={{ ...tier(1), color: ink.inkMuted }}
        className="flex h-7 shrink-0 items-center justify-center text-label"
      >
        Search tickets and sessions
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Project rail — tier 1 as well: it is the same distance out. In the
            `continuous` seam this is the ONLY lifted surface, which is the
            whole bet: one chrome/canvas boundary instead of two. */}
        <div style={tier(1)} className="flex w-8 shrink-0 flex-col items-center gap-1.5 pt-2">
          <span className="size-5 rounded-md bg-primary" />
          <span className="size-5 rounded-md bg-background/40" />
        </div>
        {/* Primary sidebar — tier 2, one step nearer than the rail, or the bare
            canvas when the seam gives it a share of zero. */}
        <div
          style={{
            ...tier(2),
            color: ink.ink,
            boxShadow: shell ? "var(--lab-shadow-card)" : undefined,
            clipPath: clipRight,
          }}
          className={`flex w-24 shrink-0 flex-col gap-0.5 p-1.5 ${sidebarGeometry}`}
        >
          <span className="truncate px-1 text-label font-medium">Voltaic</span>
          {NAV_ROWS.map(({ label, Icon: RowIcon }, index) => (
            <span
              key={label}
              style={index === 0 ? undefined : { color: ink.inkMuted }}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-label"
            >
              <RowIcon weight="fill" size={10} />
              <span className="truncate">{label}</span>
            </span>
          ))}
        </div>
        {/* The content card: opaque paper, floating — or flush, in `inset`. */}
        <div
          style={{
            boxShadow: floats ? "var(--lab-shadow-card)" : undefined,
            clipPath: clipLeft,
          }}
          className={`flex min-w-0 flex-1 flex-col overflow-hidden bg-background ${cardGeometry}`}
        >
          {/* Tab strip — `--rail` under a `--background` tab, the pair the
              spread dial is judged on. */}
          <div className="flex shrink-0 items-end gap-0.5 border-b border-border bg-rail px-1 pt-1">
            <span
              style={{ boxShadow: "var(--lab-shadow-raised)" }}
              className="rounded-t bg-background px-1.5 py-0.5 text-label text-foreground"
            >
              VLT-12
            </span>
            <span className="px-1 py-0.5 text-label text-muted-foreground">+</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
            <span className="text-ui font-medium text-foreground">Warm-park sessions</span>
            <CopyTiers />
            {/* A board card: `--card` on `--background`, with the raised tier. */}
            <div
              style={{ boxShadow: "var(--lab-shadow-raised)" }}
              className="mt-auto rounded-md border border-border bg-card px-1.5 py-1"
            >
              <span className="text-label text-muted-foreground">VLT-13</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The three copy tiers, in the order they rank — the `textWeight` dial's
 * subject, and the one thing worth reading rather than glancing at.
 *
 * The label row wears `--lab-label-ink` directly rather than the seam's
 * `.text-label.text-muted-foreground` pair, for the reason in
 * {@link WindowSpecimen}: quoting the value is honest, impersonating the
 * selector is not.
 */
function CopyTiers() {
  return (
    <div className="flex flex-col">
      <span className="text-label text-foreground">volli/VC-12-warm-park · body</span>
      <span className="text-label uppercase" style={{ color: "var(--lab-label-ink)" }}>
        Priority · Doing
      </span>
      <span className="text-label text-muted-foreground">Secondary copy, one tier down</span>
    </div>
  );
}

/**
 * The specimens that do not fit inside a 16:10 miniature: things at their real
 * size, where a shadow and a hairline can actually be seen.
 */
function ComponentSpecimens() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-3">
      <CopyTiers />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-primary px-2 py-0.5 text-label text-primary-foreground">
          New ticket
        </span>
        <span className="rounded-full border border-border px-2 py-0.5 text-label text-muted-foreground">
          Priority
        </span>
        <span className="text-label text-primary-text">accent as text</span>
      </div>
      <div className="rounded-md border border-border bg-input/40 px-2 py-1 text-label text-muted-foreground">
        Search tickets and sessions
      </div>
      <div className="flex items-end gap-0.5 rounded-t-md border-b border-border bg-rail px-1 pt-1">
        <span
          style={{ boxShadow: "var(--lab-shadow-raised)" }}
          className="rounded-t bg-background px-2 py-1 text-label text-foreground"
        >
          VLT-12
        </span>
        <span className="px-2 py-1 text-label text-muted-foreground">Session 1</span>
      </div>
      <div
        style={{ boxShadow: "var(--lab-shadow-overlay)" }}
        className="rounded-md border border-border bg-popover p-1.5"
      >
        <span className="block rounded px-1.5 py-0.5 text-label text-popover-foreground">
          Open in terminal
        </span>
        <span className="block rounded bg-accent px-1.5 py-0.5 text-label text-accent-foreground">
          Copy branch name
        </span>
      </div>
    </div>
  );
}

/**
 * The tuned canvas as something that can be pasted back.
 *
 * Deliberately not `JSON.stringify(state)`. What has to survive the trip is the
 * DECISION, and the decision is only legible next to what it was measured
 * against — the same numbers the readout shows, plus the derived hexes, so the
 * values can be checked without re-deriving them. Every field appears whether or
 * not it moved, because "I left that alone" and "that was already right" are the
 * same keystroke and only one of them is a choice worth keeping.
 *
 * The state block stays valid JSON and keeps its exact field names, so it drops
 * straight into `DEFAULT_ARC_CANVAS` — which is where these values are headed.
 */
function settingsDigest(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
  tokens: ThemeTokens,
  ink: ArcInk,
  label: string | null,
  towardPaper: number,
): string {
  const floors = lightFloors(state.textWeight);
  const light = deriveArcTokens(state, "light");
  const railDrop = hexToOklch(light["--background"]).L - hexToOklch(light["--rail"]).L;
  const measured = [
    `seam        ${state.seam} — sidebar ${percent(towardPaper)} canvas→paper`,
    `viewed in   ${resolved}${state.mode === "auto" ? " (auto)" : ""}`,
    `background  ${tokens["--background"]}`,
    `card        ${tokens["--card"]}`,
    `rail        ${tokens["--rail"]} (ΔL ${railDrop.toFixed(3)} under background)`,
    `foreground  ${tokens["--foreground"]} · Lc ${Math.abs(apcaLc(tokens["--foreground"], tokens["--background"])).toFixed(1)} on background`,
    `muted       ${tokens["--muted-foreground"]} · Lc ${Math.abs(apcaLc(tokens["--muted-foreground"], tokens["--card"])).toFixed(1)} on card`,
    label === null
      ? `label       — (dark has no label tier)`
      : `label       ${label} · Lc ${Math.abs(apcaLc(label, tokens["--card"])).toFixed(1)} on card`,
    `canvas ink  ${ink.ink} · worst Lc ${ink.worstLc.toFixed(1)}`,
    `text floors Lc ${floors.body.toFixed(0)} body / ${floors.secondary.toFixed(0)} secondary / label ${Math.round((1 - floors.labelTowardSecondary) * 100)}% toward body`,
  ].join("\n");

  return `Arc canvas — tuned settings\n\n${JSON.stringify(state, null, 2)}\n\nMeasured at these settings:\n${measured}\n`;
}

function Readout({
  state,
  effective,
  resolved,
  ink,
  tokens,
  label,
  towardPaper,
  live,
  chrome,
  onReset,
}: {
  state: ArcCanvasState;
  effective: readonly string[];
  resolved: ArcResolvedMode;
  ink: ArcInk;
  tokens: ThemeTokens;
  /** The micro-label tier, or null in dark mode where there isn't one. */
  label: string | null;
  /** Where the sidebar landed between canvas and paper — see {@link SeamRow}. */
  towardPaper: number;
  live: boolean;
  chrome: CardChrome;
  onReset(): void;
}) {
  // Three seconds, then back to "Copy settings". Long enough to read, short
  // enough that the button is never lying about what it will do next.
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 3000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // The card's own numbers, measured off the derived set rather than claimed.
  // The ink line above answers "can the sidebar be read ON the canvas"; this
  // one answers "can the card be read on the surface the canvas derived", which
  // is the question the owner put first — it is the surface stared at all day.
  //
  // Body is scored on `--background` and the other two on `--card`, matching
  // where each is solved (arc/tokens.ts). Scoring them all on the lightest rung
  // was how secondary copy came to be 3 Lc short of its floor on every panel in
  // the app while a readout said it was passing.
  const surface = tokens["--background"];
  const panel = tokens["--card"];
  const bodyLc = Math.abs(apcaLc(tokens["--foreground"], surface));
  const mutedLc = Math.abs(apcaLc(tokens["--muted-foreground"], panel));
  const labelLc = label === null ? null : Math.abs(apcaLc(label, panel));

  return (
    <div className={`flex flex-col gap-2 rounded-2xl border p-3 backdrop-blur-xl ${chrome.card}`}>
      <div className="flex flex-wrap gap-1.5">
        {state.stops.map((stop, index) => (
          // The hexes inherit the card's own ink, so both halves of a chip stay
          // legible in either mode — they are the numbers you tune from.
          <span
            // Slot is identity — see the pad's orbs.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            className={`flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 font-mono text-label ${chrome.well}`}
          >
            <span aria-hidden className="size-3 rounded-full" style={{ background: stop.hex }} />
            {stop.hex}
            <span className={chrome.faint}>→</span>
            <span
              aria-hidden
              className="size-3 rounded-full"
              style={{ background: effective[index] }}
            />
            {effective[index]}
          </span>
        ))}
      </div>
      <p className={`flex items-center gap-1.5 font-mono text-label ${chrome.mute}`}>
        <span aria-hidden className="size-3 rounded-full" style={{ background: surface }} />
        card {surface} · body <span className="tabular-nums">{bodyLc.toFixed(1)}</span> · muted{" "}
        <span className="tabular-nums">{mutedLc.toFixed(1)}</span>
        {labelLc === null ? null : (
          <>
            {" · label "}
            <span className="tabular-nums">{labelLc.toFixed(1)}</span>
          </>
        )}
      </p>
      <div className="flex items-center justify-between gap-3">
        <p className={`font-mono text-label ${chrome.mute}`}>
          {resolved} · ink {ink.ink} · worst Lc{" "}
          <span className="tabular-nums">{ink.worstLc.toFixed(1)}</span>
          <span className={chrome.faint}>
            {" "}
            (other {Math.min(ink.lightLc, ink.darkLc).toFixed(1)})
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              // Fire-and-forget with an explicit failure state rather than a
              // silent one: the clipboard is permission-gated, and a button
              // that looked like it worked would send the owner off to paste
              // nothing.
              void navigator.clipboard
                .writeText(settingsDigest(state, resolved, tokens, ink, label, towardPaper))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
            title="The tuned state as JSON, plus the hexes and Lc it measures to — paste it back to land these values"
            className={`rounded-full px-2 py-1 text-label transition-colors ${chrome.ghost}`}
          >
            {copied ? "Copied ✓" : "Copy settings"}
          </button>
          <button
            type="button"
            onClick={onReset}
            className={`rounded-full px-2 py-1 text-label transition-colors ${chrome.ghost}`}
          >
            Reset
          </button>
        </div>
      </div>
      {live ? null : (
        <p className={`text-label ${chrome.faint}`}>
          Not applied — the app&apos;s own canvas is showing. Touch any control to commit.
        </p>
      )}
    </div>
  );
}

export default function CanvasScratch() {
  // One read at mount, two answers: what the controls open on, and whether the
  // seam is already armed.
  const [restored] = React.useState(loadArcCanvas);
  const [state, setState] = React.useState<ArcCanvasState>(restored ?? DEFAULT_ARC_CANVAS);
  // A reset takes the seam back down and LEAVES it down — "reset" has to mean
  // the app's own canvas is showing again, not that the default got re-applied.
  const [live, setLive] = React.useState(restored !== null);

  // Every edit reads from here rather than from `state`. A drag fires several
  // pointermoves between renders, and each one has to build on the position the
  // previous one committed, not on the one the last render closed over.
  const stateRef = React.useRef(state);
  const mutate = React.useCallback((update: (current: ArcCanvasState) => ArcCanvasState) => {
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
    setLive(true);
    saveArcCanvas(next);
    applyArcCanvas(next);
  }, []);

  const reset = React.useCallback(() => {
    stateRef.current = DEFAULT_ARC_CANVAS;
    setState(DEFAULT_ARC_CANVAS);
    setLive(false);
    saveArcCanvas(null);
    applyArcCanvas(null);
    // Teardown only takes the SEAM down; the derived app tokens it wrote are
    // still on the element, and paint.ts cannot put the lab's own theme back
    // without importing this module's neighbour (see its note on the cycle).
    // So the caller that genuinely turns a canvas off is the one that restores
    // — otherwise Reset leaves the window wearing the gradient's ladder with no
    // gradient behind it.
    setLabTheme(labTheme());
  }, []);

  const systemDark = useSystemDark();
  const resolved = resolveArcMode(state.mode, systemDark);
  const gradient = React.useMemo(() => arcCanvasBackground(state, resolved), [state, resolved]);
  const effective = React.useMemo(() => effectiveStopHexes(state, resolved), [state, resolved]);
  const tokens = React.useMemo(() => deriveArcTokens(state, resolved), [state, resolved]);
  // The same order `paint.ts` uses, and for the same reason: the lifted tiers
  // are surfaces the ink has to survive, so scoring without them would print a
  // worst-case number the window does not actually hold to.
  const elevation = React.useMemo(
    () => arcElevation(state, resolved, tokens),
    [state, resolved, tokens],
  );
  const ink = React.useMemo(
    () => arcInk(state, resolved, elevation.surfaces),
    [state, resolved, elevation],
  );
  const labelInk = React.useMemo(() => deriveArcLabelInk(state, resolved), [state, resolved]);
  const primary = state.stops[state.primaryIndex];
  // The card follows the canvas it is floating on, not the app's dark-only
  // theme — see CHROME. It tracks `resolved`, so `auto` moves it too.
  const chrome = CHROME[resolved];

  return (
    <div
      // `--lab-canvas` when armed, the app's own backdrop when not — so a
      // dormant editor shows what every other scratch is showing rather than a
      // preview of something that isn't applied.
      style={{ background: "var(--lab-canvas, var(--rail))" }}
      className="relative h-full w-full overflow-hidden"
    >
      {/* Scrollable for the same reason the specimen column is, and it became
          necessary at the same moment: the seam control pushed the card past a
          800px window, and a control card that silently crops its own last row
          hides whichever knob was added most recently — the one being worked
          on. The `flex-1` spacers still center it whenever it fits. */}
      <div
        style={{ width: CARD_WIDTH }}
        className="absolute inset-y-6 left-6 flex flex-col gap-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex-1" />
        <div
          style={{ padding: CARD_PADDING }}
          className={`flex flex-col gap-3 rounded-2xl border shadow-2xl backdrop-blur-xl ${chrome.card}`}
        >
          <ModeRow
            mode={state.mode}
            chrome={chrome}
            onChange={(mode) => mutate((current) => ({ ...current, mode }))}
          />

          <GradientPad
            state={state}
            gradient={gradient}
            onMove={(index, x, y) => mutate((current) => moveStop(current, index, x, y))}
            onPromote={(index) => mutate((current) => withPrimaryIndex(current, index))}
          />

          <StopCountRow
            count={state.stops.length}
            chrome={chrome}
            onAdd={() => mutate(addStop)}
            onRemove={() => mutate(removeStop)}
          />

          <SwatchRow
            active={primary.hex}
            chrome={chrome}
            onPick={(hex) => mutate((current) => withPrimaryHex(current, hex))}
          />

          <div className="flex items-center" style={{ gap: CONTROL_GAP }}>
            <VibrancySlider
              value={state.vibrancy}
              chrome={chrome}
              onChange={(vibrancy) => mutate((current) => ({ ...current, vibrancy }))}
            />
            <GrainDial
              value={state.grain}
              chrome={chrome}
              onChange={(grain) => mutate((current) => ({ ...current, grain }))}
            />
          </div>

          <div className={`h-px ${chrome.well}`} />

          <SeamRow
            seam={state.seam}
            towardPaper={elevation.sidebarTowardPaper}
            resolved={resolved}
            chrome={chrome}
            onChange={(seam) => mutate((current) => ({ ...current, seam }))}
          />

          <div className={`h-px ${chrome.well}`} />

          <LightTuning
            state={state}
            resolved={resolved}
            chrome={chrome}
            onChange={(patch) => mutate((current) => ({ ...current, ...patch }))}
          />
        </div>
        <div className="flex-1" />

        <Readout
          state={state}
          effective={effective}
          resolved={resolved}
          ink={ink}
          tokens={tokens}
          label={labelInk}
          towardPaper={elevation.sidebarTowardPaper}
          live={live}
          chrome={chrome}
          onReset={reset}
        />
      </div>

      {/* Scrollable, because the specimen stack is taller than a short window
          and the alternative is squeezing every specimen until none of them
          shows what it is for. */}
      <div className="absolute inset-y-6 right-6 flex w-[360px] flex-col gap-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <WindowSpecimen ink={ink} seam={state.seam} />
        <ComponentSpecimens />
      </div>
    </div>
  );
}

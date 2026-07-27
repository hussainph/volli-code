/**
 * Arc's Space editor, standing up the vivid canvas model — the controls that
 * make `arc/model.ts` worth having.
 *
 * The question is not "is this gradient pretty". It is whether a canvas vivid
 * enough to be worth the trouble can still carry the app's own sidebar nav, and
 * that has exactly one honest test: pick a canvas here, then open the App shell
 * scratch and read the REAL sidebar sitting transparently on it. So every edit
 * commits immediately (see arc/paint.ts) rather than previewing — a canvas that
 * unwound on the way out could only ever be judged against the mock column on
 * the right of this screen.
 *
 * The mock column is here for the tighter loop, not as the verdict: it is the
 * same two tokens the real sidebar paints its labels in, so a reading that
 * fails here fails there. The readout at the bottom left says which ink the
 * flip chose and the APCA Lc it survives the worst pool at, which is the number
 * the whole design turns on.
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
import { PaintBrushIcon } from "@phosphor-icons/react/dist/csr/PaintBrush";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TicketIcon } from "@phosphor-icons/react/dist/csr/Ticket";

import {
  addStop,
  arcCanvasBackground,
  arcGrainLayer,
  arcInk,
  ARC_TUNING,
  DEFAULT_ARC_CANVAS,
  effectiveStopHexes,
  moveStop,
  removeStop,
  resolveArcMode,
  withPrimaryHex,
  withPrimaryIndex,
  type ArcCanvasState,
  type ArcInk,
  type ArcMode,
  type ArcResolvedMode,
  type ArcStop,
} from "../arc/model";
import { applyArcCanvas, loadArcCanvas, saveArcCanvas } from "../arc/paint";

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
 * The two tokens the real sidebar paints its labels in, with the app's own as
 * the fallback — so the mock column below reads correctly while the canvas is
 * dormant instead of falling back to `currentColor`.
 */
const INK = "var(--lab-canvas-ink, var(--sidebar-foreground))";
const INK_MUTED = "var(--lab-canvas-ink-muted, var(--muted-foreground))";

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

/**
 * Press-and-drag on one element, with pointer capture so the gesture survives
 * the cursor leaving it — an orb dragged to the pad's edge must not be dropped
 * the moment it crosses out.
 *
 * `slop` is what separates the pad's two gestures from the slider's one. At 0
 * the value is set on press and every move, which is what a track wants
 * (clicking anywhere on it jumps there). Above 0 nothing moves until the
 * pointer has travelled that far, and a release before it does is reported as a
 * click instead — so pressing an orb selects it and dragging it moves it,
 * without a press ever snapping the orb's center under the cursor.
 */
function useDrag({
  slop = 0,
  onDrag,
  onClick,
}: {
  slop?: number;
  onDrag(event: React.PointerEvent<HTMLElement>): void;
  onClick?(): void;
}): DragHandlers {
  const gesture = React.useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(
    null,
  );

  return {
    onPointerDown(event) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      };
      if (slop === 0) {
        gesture.current.dragging = true;
        onDrag(event);
      }
    },
    onPointerMove(event) {
      const active = gesture.current;
      if (active === null || active.id !== event.pointerId) return;
      if (!active.dragging) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < slop) return;
        active.dragging = true;
      }
      onDrag(event);
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
  onChange(clamp01(value + direction * step));
}

function ModeRow({ mode, onChange }: { mode: ArcMode; onChange(next: ArcMode): void }) {
  return (
    <div className="flex items-center gap-1 rounded-full bg-white/8 p-1">
      {MODES.map(({ mode: candidate, label, Icon: ModeIcon }) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onChange(candidate)}
          aria-pressed={candidate === mode}
          title={label}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-label text-white/55 transition-colors hover:text-white aria-pressed:bg-white/18 aria-pressed:text-white"
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
    onDrag(event) {
      const pad = padRef.current;
      if (pad === null) return;
      const rect = pad.getBoundingClientRect();
      onMove(
        index,
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
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
  onAdd,
  onRemove,
}: {
  count: number;
  onAdd(): void;
  onRemove(): void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-label text-white/50 uppercase">
        {count} {count === 1 ? "color" : "colors"}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={count <= 1}
          aria-label="Remove a color"
          className="flex size-7 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10"
        >
          <MinusIcon weight="fill" size={14} />
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={count >= ARC_TUNING.maxStops}
          aria-label="Add a color"
          className="flex size-7 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10"
        >
          <PlusIcon weight="fill" size={14} />
        </button>
      </div>
    </div>
  );
}

function SwatchRow({ active, onPick }: { active: string; onPick(hex: string): void }) {
  const normalized = active.toLowerCase();
  const [page, setPage] = React.useState(() => {
    const found = SWATCH_PAGES.findIndex((swatches) => swatches.includes(normalized));
    return found === -1 ? 0 : found;
  });
  const turn = (step: number) =>
    setPage((current) => (current + step + SWATCH_PAGES.length) % SWATCH_PAGES.length);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => turn(-1)}
        aria-label="Previous swatches"
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white"
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
            className="aspect-square w-full rounded-full outline-offset-2 transition-transform hover:scale-110 aria-pressed:outline-2 aria-pressed:outline-white"
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => turn(1)}
        aria-label="More swatches"
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-white/50 transition-colors hover:text-white"
      >
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

function VibrancySlider({ value, onChange }: { value: number; onChange(next: number): void }) {
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
      className="relative shrink-0 cursor-ew-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/60"
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
          stroke="rgb(255 255 255 / 0.5)"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
      <div
        aria-hidden
        style={{ width: THUMB_WIDTH, left: value * travel }}
        className="absolute inset-y-0 rounded-full bg-white shadow-lg"
      />
    </div>
  );
}

function GrainDial({ value, onChange }: { value: number; onChange(next: number): void }) {
  const dialRef = React.useRef<HTMLDivElement>(null);
  const handlers = useDrag({
    slop: CLICK_SLOP,
    onDrag(event) {
      const dial = dialRef.current;
      if (dial === null) return;
      const rect = dial.getBoundingClientRect();
      // atan2(dx, -dy): 0° is straight up and clockwise is positive, matching
      // how the notch is drawn. Clamping rather than wrapping means dragging
      // past either end pins there instead of jumping to the far end.
      const degrees =
        (Math.atan2(
          event.clientX - (rect.left + rect.width / 2),
          -(event.clientY - (rect.top + rect.height / 2)),
        ) *
          180) /
        Math.PI;
      onChange(clamp01((degrees - DIAL_MIN_ANGLE) / (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE)));
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
      className="relative shrink-0 cursor-grab touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/60"
    >
      {/* The knob face carries the texture at its current amount — the dial
          shows what it is setting, which is the only way to judge a value this
          subtle at this size. Mid-grey rather than dark: the tile is black
          noise, so it needs something to be noise ON. */}
      <div
        aria-hidden
        style={{
          background:
            grain === null ? "rgb(255 255 255 / 0.45)" : `${grain}, rgb(255 255 255 / 0.45)`,
        }}
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
              fill={progress <= value ? "rgb(255 255 255 / 0.85)" : "rgb(255 255 255 / 0.3)"}
            />
          );
        })}
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

/**
 * The readability judge: the app's sidebar shape, painted in the app's sidebar
 * tokens, with NO fill of its own.
 *
 * Transparent is the entire point. The real sidebar gave up its opaque token to
 * sit on the canvas (`--sidebar-veil`, #74), so a mock with a background would
 * be testing text on a card and reporting it as text on a gradient.
 */
function SidebarPreview() {
  return (
    <div className="flex h-full w-full flex-col gap-1 rounded-2xl p-3">
      <div className="flex items-center gap-2 px-2 py-1.5" style={{ color: INK }}>
        <PaintBrushIcon weight="fill" size={16} />
        <span className="text-ui font-medium">Voltaic</span>
      </div>
      <div
        className="mt-2 flex items-center gap-2 rounded-md bg-white/10 px-2 py-1.5"
        style={{ color: INK }}
      >
        <SquaresFourIcon weight="fill" size={16} />
        <span className="text-ui font-medium">Board</span>
      </div>
      {NAV_ROWS.map(({ label, Icon: RowIcon }) => (
        <div
          key={label}
          className="flex items-center gap-2 rounded-md px-2 py-1.5"
          style={{ color: INK_MUTED }}
        >
          <RowIcon weight="fill" size={16} />
          <span className="truncate text-ui">{label}</span>
        </div>
      ))}
      <p className="mt-auto px-2 text-label" style={{ color: INK_MUTED }}>
        Transparent — this column is reading the canvas, not a card.
      </p>
    </div>
  );
}

function Readout({
  state,
  effective,
  resolved,
  ink,
  live,
  onReset,
}: {
  state: ArcCanvasState;
  effective: readonly string[];
  resolved: ArcResolvedMode;
  ink: ArcInk;
  live: boolean;
  onReset(): void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/45 p-3 text-white backdrop-blur-xl">
      <div className="flex flex-wrap gap-1.5">
        {state.stops.map((stop, index) => (
          <span
            // Slot is identity — see the pad's orbs.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            className="flex items-center gap-1.5 rounded-full bg-white/8 py-0.5 pr-2 pl-1 font-mono text-label"
          >
            <span aria-hidden className="size-3 rounded-full" style={{ background: stop.hex }} />
            {stop.hex}
            <span className="text-white/40">→</span>
            <span
              aria-hidden
              className="size-3 rounded-full"
              style={{ background: effective[index] }}
            />
            {effective[index]}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-label text-white/60">
          {resolved} · ink {ink.ink} · worst Lc{" "}
          <span className="text-white tabular-nums">{ink.worstLc.toFixed(1)}</span>
          <span className="text-white/35">
            {" "}
            (other {Math.min(ink.lightLc, ink.darkLc).toFixed(1)})
          </span>
        </p>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 rounded-full px-2 py-1 text-label text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          Reset canvas
        </button>
      </div>
      {live ? null : (
        <p className="text-label text-white/40">
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
  }, []);

  const systemDark = useSystemDark();
  const resolved = resolveArcMode(state.mode, systemDark);
  const gradient = React.useMemo(() => arcCanvasBackground(state, resolved), [state, resolved]);
  const effective = React.useMemo(() => effectiveStopHexes(state, resolved), [state, resolved]);
  const ink = React.useMemo(() => arcInk(state, resolved), [state, resolved]);
  const primary = state.stops[state.primaryIndex];

  return (
    <div
      // `--lab-canvas` when armed, the app's own backdrop when not — so a
      // dormant editor shows what every other scratch is showing rather than a
      // preview of something that isn't applied.
      style={{ background: "var(--lab-canvas, var(--rail))" }}
      className="relative h-full w-full overflow-hidden"
    >
      <div style={{ width: CARD_WIDTH }} className="absolute inset-y-6 left-6 flex flex-col gap-3">
        <div className="flex-1" />
        <div
          style={{ padding: CARD_PADDING }}
          className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/45 shadow-2xl backdrop-blur-xl"
        >
          <ModeRow
            mode={state.mode}
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
            onAdd={() => mutate(addStop)}
            onRemove={() => mutate(removeStop)}
          />

          <SwatchRow
            active={primary.hex}
            onPick={(hex) => mutate((current) => withPrimaryHex(current, hex))}
          />

          <div className="flex items-center" style={{ gap: CONTROL_GAP }}>
            <VibrancySlider
              value={state.vibrancy}
              onChange={(vibrancy) => mutate((current) => ({ ...current, vibrancy }))}
            />
            <GrainDial
              value={state.grain}
              onChange={(grain) => mutate((current) => ({ ...current, grain }))}
            />
          </div>
        </div>
        <div className="flex-1" />

        <Readout
          state={state}
          effective={effective}
          resolved={resolved}
          ink={ink}
          live={live}
          onReset={reset}
        />
      </div>

      <div className="absolute inset-y-6 right-6 w-[300px]">
        <SidebarPreview />
      </div>
    </div>
  );
}

/** Settings canvas instrument. Uses the existing store preview and commit contract. */
import * as React from "react";
import { CircleHalfIcon, CirclesThreeIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import {
  addStop,
  canvasBackground,
  grainLayer,
  MAX_STOPS,
  moveStop,
  removeStop,
  withPrimaryIndex,
  type Canvas,
  type CanvasStop,
  type ResolvedAppearance,
} from "@volli/shared";
import { padAnchor } from "@renderer/components/theme/canvas-editor-model";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";
import { harmonize, toHex, toHsl } from "./colour-model";
const PAD_ASPECT = "16 / 10";
const PAD_DOT_SPACING = 14;
const ORB_SIZE = 28;
const PRIMARY_ORB_SIZE = 44;
const CLICK_SLOP = 4;
const UNIT_STEP = 0.01;
const UNIT_STEP_COARSE = 0.05;
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
 * the editor's single settlement per drag — every intermediate frame is a
 * preview.
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
    // from the previewed canvas. Fed only the accepted one, every press in a
    // held repeat would start from the same anchor and the orb would sit one step
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

interface CanvasInstrumentBaseProps {
  /** The host's accepted canvas — stored when scoped, otherwise memory-only. */
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
}

type CanvasInstrumentProps = CanvasInstrumentBaseProps &
  (
    | {
        /** Settings' persistence target. Mutually exclusive with a memory-only host. */
        scope: ThemeScope;
        onCanvasChange?: undefined;
      }
    | {
        scope?: undefined;
        /** Adopts a finished preview without calling any persistence action. */
        onCanvasChange(canvas: Canvas): void;
      }
  );

export function CanvasInstrument({
  scope,
  canvas,
  resolved,
  mode,
  onCanvasChange,
}: CanvasInstrumentProps) {
  // The memory-only host's accepted canvas is separate from the store preview:
  // the latter may currently be a half-typed colour or an in-flight drag. Refs
  // let the unmount cleanup restore the latest accepted value without turning
  // every accepted prop update into an effect cleanup of the previous one.
  const chosenCanvas = React.useRef(canvas);
  const adoptCanvas = React.useRef(onCanvasChange);
  React.useLayoutEffect(() => {
    chosenCanvas.current = canvas;
    adoptCanvas.current = onCanvasChange;
  }, [canvas, onCanvasChange]);

  /**
   * The canvas an edit builds on: the running preview when there is one, the
   * host's accepted canvas otherwise.
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

  /** End of a gesture: what is painted becomes what the host owns. */
  const settle = React.useCallback((): void => {
    const store = useThemeStore.getState();
    const adopt = adoptCanvas.current;
    if (adopt !== undefined) {
      if (store.preview !== null) {
        // Synchronous, so closing in the same turn still restores this choice
        // even before the host has rendered the new `canvas` prop.
        chosenCanvas.current = store.preview;
        adopt(store.preview);
      }
      return;
    }
    // The prop union makes this unreachable for a typed caller, and the runtime
    // guard keeps an accidentally malformed memory-only mount non-persisting.
    if (scope === undefined) return;
    // Failure is surfaced and rolled back by the store's own write path; the
    // boolean is only interesting to a caller that wanted to chain, and nothing
    // here does.
    void store.commitPreview(scope);
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
    const store = useThemeStore.getState();
    if (adoptCanvas.current === undefined) store.cancelPreview();
    else store.startPreview(chosenCanvas.current);
  }, []);

  /** Leaving mid-gesture is an abandonment like any other. */
  React.useEffect(() => abandon, [abandon]);

  /** A discrete edit — one click, one settlement. */
  const commit = React.useCallback(
    (update: (current: Canvas) => Canvas): void => {
      edit(update);
      settle();
    },
    [edit, settle],
  );

  /**
   * What is actually on screen — the preview while a gesture runs, the accepted
   * canvas otherwise. Every control that is a picture of the canvas reads this;
   * the one that is a picture of the accepted canvas is the hex field.
   */
  const preview = useThemeStore((state) => state.preview);
  const live = preview ?? canvas;

  const [harmony, setHarmony] = React.useState<"complementary" | "analogous">("complementary");
  const primary = live.stops[live.primaryIndex].hex;
  const [hex, setHex] = React.useState(primary);
  React.useEffect(() => setHex(primary), [primary]);
  const hsl = toHsl(primary);
  const colour = (next: string) => edit((current) => harmonize(current, next, harmony));
  return (
    <div className="flex w-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start gap-6">
        <div className="relative w-80 max-w-full">
          <GradientPad
            canvas={live}
            resolved={resolved}
            onMove={(index, x, y) => edit((current) => moveStop(current, index, x, y))}
            onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
            onSettle={settle}
          />
          {mode && <div className="absolute top-2 left-2">{mode}</div>}
          <div className="absolute right-2 bottom-2 flex gap-1 rounded-control bg-card p-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove a colour"
              disabled={live.stops.length <= 1}
              onClick={() => commit(removeStop)}
            >
              <MinusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add a colour"
              disabled={live.stops.length >= MAX_STOPS}
              onClick={() =>
                commit((current) => {
                  const next = addStop(current);
                  return harmonize(next, next.stops[next.primaryIndex].hex, harmony);
                })
              }
            >
              <PlusIcon />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-6">
          <Rotary
            label="Vibrancy"
            value={live.vibrancy}
            onChange={(vibrancy) => edit((current) => ({ ...current, vibrancy }))}
            onSettle={settle}
            onCancel={abandon}
          />
          <Rotary
            label="Grain"
            value={live.grain}
            onChange={(grain) => edit((current) => ({ ...current, grain }))}
            onSettle={settle}
            onCancel={abandon}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <span className="text-ui font-medium">Primary colour</span>
        <div className="flex items-center gap-2">
          {(["complementary", "analogous"] as const).map((kind) => {
            const Icon = kind === "complementary" ? CircleHalfIcon : CirclesThreeIcon;
            const label = kind === "complementary" ? "Complementary harmony" : "Analogous harmony";
            return (
              <Button
                key={kind}
                variant={kind === harmony ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label={label}
                title={label}
                aria-pressed={kind === harmony}
                onClick={() => {
                  setHarmony(kind);
                  commit((current) => harmonize(current, primary, kind));
                }}
              >
                <Icon />
              </Button>
            );
          })}
          <Input
            aria-label="Primary colour hex"
            value={hex}
            spellCheck={false}
            className="w-24 font-mono"
            onChange={(e) => {
              setHex(e.target.value);
              if (/^#[\da-f]{6}$/i.test(e.target.value)) colour(e.target.value);
            }}
            onBlur={() => {
              settle();
              setHex(primary);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle();
              if (e.key === "Escape") {
                abandon();
                setHex(canvas.stops[canvas.primaryIndex].hex);
              }
            }}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {["Hue", "Saturation", "Lightness"].map((name, i) => (
          <label key={name} className="flex flex-col gap-2 text-ui text-muted-foreground">
            <span className="flex justify-between gap-2">
              <span>{name}</span>
              <output className="font-mono">
                {hsl[i]}
                {i === 0 ? "°" : "%"}
              </output>
            </span>
            <input
              type="range"
              aria-label={name}
              min={0}
              max={i === 0 ? 360 : 100}
              value={hsl[i]}
              className="w-full accent-primary"
              onChange={(e) => {
                const next = [...hsl];
                next[i] = Number(e.target.value);
                colour(toHex(next[0], next[1], next[2]));
              }}
              onPointerUp={settle}
              onKeyUp={settle}
              onBlur={settle}
              onKeyDown={(e) => {
                if (e.key === "Escape") abandon();
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function Rotary({
  label,
  value,
  onChange,
  onSettle,
  onCancel,
}: {
  label: string;
  value: number;
  onChange(next: number): void;
  onSettle(): void;
  onCancel(): void;
}) {
  const drag = React.useRef<{ y: number; value: number } | null>(null);
  const change = (next: number) => onChange(Math.min(1, Math.max(0, next)));
  return (
    <div className="flex w-24 flex-col items-center gap-4">
      <span className="text-ui font-medium">{label}</span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        className="grid size-20 touch-none place-items-center rounded-full border border-border-strong bg-secondary shadow-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={(e) => {
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, value };
        }}
        onPointerMove={(e) => {
          if (drag.current) change(drag.current.value + (drag.current.y - e.clientY) / 160);
        }}
        onPointerUp={() => {
          drag.current = null;
          onSettle();
        }}
        onPointerCancel={() => {
          drag.current = null;
          onCancel();
        }}
        onLostPointerCapture={() => {
          if (drag.current) {
            drag.current = null;
            onCancel();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            drag.current = null;
            onCancel();
            return;
          }
          if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          e.preventDefault();
          change(
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? 1
                : value + (["ArrowUp", "ArrowRight"].includes(e.key) ? 0.01 : -0.01),
          );
        }}
        onKeyUp={onSettle}
        onBlur={onSettle}
      >
        <span
          aria-hidden
          className="relative block size-16 rounded-full border border-border bg-card shadow-raised"
          style={{ transform: `rotate(${-135 + value * 270}deg)` }}
        >
          <span className="absolute top-2 left-1/2 h-4 w-1 -translate-x-1/2 rounded-full bg-primary" />
        </span>
      </div>
      <output className="font-mono text-ui tabular-nums">{Math.round(value * 100)}%</output>
    </div>
  );
}

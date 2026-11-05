/** Settings canvas instrument. Uses the existing store preview and commit contract. */
import * as React from "react";
import { MinusIcon, AddIcon } from "@renderer/components/ui/icon";

import {
  addStop,
  DEFAULT_CANVAS,
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
import { padAnchor, droppedStopIndex } from "@renderer/components/theme/canvas-editor-model";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useThemeStore, type ThemeScope } from "@renderer/stores/theme";
import { harmonize } from "./colour-model";
import { AccentChoice } from "./accent-choice";
import { PrefRow } from "./pref-row";
import { Segmented } from "@renderer/components/ui/segmented";
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
 * MOVED by a drag, two things one control has to be able to do.
 * `onClick` is optional for controls that respond only to dragging.
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
      className="absolute touch-none rounded-full shadow-glass-small ring-2 ring-white outline-1 outline-black/30 focus-visible:ring-4 focus-visible:outline-2"
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
  const colour = (next: string) => edit((current) => harmonize(current, next, harmony));
  const dropped = droppedStopIndex(live);
  const atMaximum = live.stops.length >= MAX_STOPS;
  return (
    <div data-slot="canvas-instrument">
      <PrefRow label="Canvas">
        {mode}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label="Edit canvas"
              className="w-24"
              style={{ background: canvasBackground(live, resolved) }}
            >
              <span className="sr-only">Canvas</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex w-80 max-w-full flex-col gap-3" align="end">
            <GradientPad
              canvas={live}
              resolved={resolved}
              onMove={(index, x, y) => edit((current) => moveStop(current, index, x, y))}
              onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
              onSettle={settle}
            />
            <div className="flex justify-end gap-1">
              <StopLimit reason={dropped === null ? "You need at least one colour" : null}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={dropped === null ? "Remove a colour" : `Remove colour ${dropped + 1}`}
                  disabled={dropped === null}
                  onClick={() => commit(removeStop)}
                >
                  <MinusIcon />
                </Button>
              </StopLimit>
              <StopLimit
                reason={atMaximum ? `A canvas can have at most ${MAX_STOPS} colours` : null}
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add a colour"
                  disabled={atMaximum}
                  onClick={() =>
                    commit((current) => {
                      const next = addStop(current);
                      return harmonize(next, next.stops[next.primaryIndex].hex, harmony);
                    })
                  }
                >
                  <AddIcon />
                </Button>
              </StopLimit>
            </div>
          </PopoverContent>
        </Popover>
      </PrefRow>
      <PrefRow label="Accent">
        <AccentChoice
          value={primary}
          canvasColour={DEFAULT_CANVAS.stops[0].hex}
          onPick={(next) => commit((current) => harmonize(current, next, harmony))}
          onPreview={colour}
          onCommit={settle}
          onCancel={abandon}
        >
          <div className="flex items-center justify-between gap-2 text-ui">
            <span>Harmony</span>
            <Segmented
              ariaLabel="Colour harmony"
              size="sm"
              value={harmony}
              options={[
                { key: "complementary", label: "Complementary" },
                { key: "analogous", label: "Analogous" },
              ]}
              onChange={(kind) => {
                setHarmony(kind);
                commit((current) => harmonize(current, primary, kind));
              }}
            />
          </div>
        </AccentChoice>
      </PrefRow>
      {(
        [
          ["Vibrancy", "vibrancy"],
          ["Grain", "grain"],
        ] as const
      ).map(([label, key]) => (
        <PrefRow key={key} label={label}>
          <input
            type="range"
            className="w-36 accent-primary"
            aria-label={label}
            min={0}
            max={1}
            step={0.01}
            value={live[key]}
            onChange={(event) =>
              edit((current) => ({ ...current, [key]: Number(event.target.value) }))
            }
            onPointerUp={settle}
            onKeyUp={settle}
            onBlur={settle}
            onKeyDown={(event) => {
              if (event.key === "Escape") abandon();
            }}
          />
          <output className="w-10 text-right text-ui tabular-nums">
            {Math.round(live[key] * 100)}%
          </output>
        </PrefRow>
      ))}
    </div>
  );
}

function StopLimit({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  if (reason === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={reason}
          className="inline-flex rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

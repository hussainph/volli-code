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
 * What did NOT come across is the lab's chrome. That editor was a translucent
 * card floating ON the gradient, so it carried its own two-mode `CHROME` table
 * and its own bespoke SVG slider and dial; this one lives inside Settings' own
 * opaque card, where the app's tokens already answer light and dark and the
 * pill/row vocabulary is the house style. Its six tuning dials did not come
 * across either — lift, card tint, surface spread, shadow, text weight and the
 * seam are settled and now live in `ARC_SETTLED`, so they are no longer
 * settings.
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
  droppedStopIndex,
  easedVibrancy,
  lcLabel,
  normalizeStopHex,
  padAnchor,
  percentLabel,
  swatchPageOf,
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

const ORB_SIZE = 22;
const PRIMARY_ORB_SIZE = 34;

/** Travel under which a press on an orb is a click (promote) rather than a drag (move). */
const CLICK_SLOP = 4;

/** One arrow press on a focused orb, and the same with Shift held. */
const NUDGE = 0.01;
const NUDGE_COARSE = 0.05;

/**
 * The grain chip's backdrop.
 *
 * A literal mid-grey rather than a token, and it is the one place in this file
 * that refuses one: the grain layer is BLACK noise, so the chip has to sit on a
 * surface each mode can show it on. Every neutral token is near-paper in light
 * or near-page in dark, and both ends hide it — the chip would be blank in one
 * mode and blank in the other for the opposite reason.
 */
const GRAIN_CHIP_BACKDROP = "#8a8a8a";

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
 * `CLICK_SLOP` is what separates the pad's two gestures: nothing moves until the
 * pointer has travelled that far, and a release before it does is reported as a
 * click instead. So pressing an orb promotes it and dragging it moves it.
 *
 * `onSettle` fires once at the end of any gesture that actually moved, which is
 * the editor's single write per drag — every intermediate frame is a preview.
 */
function useOrbDrag({
  onDrag,
  onClick,
  onSettle,
}: {
  onDrag(event: React.PointerEvent<HTMLElement>, grab: GrabOffset): void;
  onClick(): void;
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
      else onClick();
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

  const handlers = useOrbDrag({
    onDrag: move,
    onClick: () => onPromote(index),
    onSettle,
  });

  const nudge = (event: React.KeyboardEvent): void => {
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    onMove(index, stop.x + delta.x, stop.y + delta.y);
  };

  const size = primary ? PRIMARY_ORB_SIZE : ORB_SIZE;
  return (
    <button
      type="button"
      {...handlers}
      onKeyDown={nudge}
      onKeyUp={onSettle}
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
 */
function PrimaryColourRow({
  hex,
  onPick,
  onPreview,
  onSettle,
}: {
  hex: string;
  onPick(next: string): void;
  onPreview(next: string): void;
  onSettle(): void;
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
          if (event.key === "Escape") {
            setDraft(normalized);
            onSettle();
          }
        }}
        className="h-6 w-24 shrink-0 px-2 font-mono text-ui"
      />
    </div>
  );
}

/**
 * A 0–1 control as the platform's own slider.
 *
 * Deliberately a native `range` rather than the lab's hand-built sine track and
 * knob dial. Those were right for a translucent card floating on the gradient
 * and would be a foreign object in a settings row — and the native control
 * brings keyboard operation, the correct pointer semantics and its own
 * light/dark rendering for free, none of which a re-implementation gets without
 * writing them again.
 *
 * What it does keep from the lab is the reason those controls were usable: a
 * chip beside the slider showing what the value actually IS, because a value
 * this subtle cannot be judged from a number.
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
        step={0.01}
        value={value}
        aria-label={label}
        onChange={(event) => onInput(Number(event.target.value))}
        // One write per gesture: the drag and the key repeat are previews, and
        // the release is the commit.
        onPointerUp={onSettle}
        onKeyUp={onSettle}
        onBlur={onSettle}
        className="w-44 accent-primary"
      />
      <span className="w-9 text-right text-ui text-muted-foreground tabular-nums">
        {percentLabel(value)}
      </span>
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
                <SlidersHorizontalIcon weight="fill" />
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
 * `canvas` is what the SCOPE has stored (`appliedCanvas`), never what is on
 * screen: a preview is on screen, and a control fed the preview would drift a
 * pixel per frame as its own output came back round. The store is read
 * imperatively for every write, so no handler closes over a snapshot that a
 * concurrent hydrate has already replaced.
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

  /** A discrete edit — one click, one write. */
  const commit = React.useCallback(
    (update: (current: Canvas) => Canvas): void => {
      edit(update);
      settle();
    },
    [edit, settle],
  );

  const report = React.useMemo(() => canvasContrastReport(canvas, resolved), [canvas, resolved]);
  const eased = React.useMemo(() => easedVibrancy(canvas, resolved), [canvas, resolved]);
  const primary = canvas.stops[canvas.primaryIndex];
  const grain = React.useMemo(() => grainLayer(canvas.grain), [canvas.grain]);
  const vibrancyChip = React.useMemo(
    () => effectiveStopHexes(canvas, resolved)[canvas.primaryIndex],
    [canvas, resolved],
  );

  return (
    <>
      <div className="flex flex-col gap-3 pb-4">
        <GradientPad
          canvas={canvas}
          resolved={resolved}
          onMove={(index, x, y) => edit((current) => moveStop(current, index, x, y))}
          onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
          onSettle={settle}
        />
        <StopRow
          canvas={canvas}
          resolved={resolved}
          onPromote={(index) => commit((current) => withPrimaryIndex(current, index))}
          onAdd={() => commit(addStop)}
          onRemove={() => commit(removeStop)}
        />
        <PrimaryColourRow
          hex={primary.hex}
          onPick={(next) => commit((current) => withPrimaryHex(current, next))}
          onPreview={(next) => edit((current) => withPrimaryHex(current, next))}
          onSettle={settle}
        />
      </div>

      <SettingsRow label="Vibrancy" htmlFor="canvas-vibrancy">
        <UnitSlider
          id="canvas-vibrancy"
          label="Vibrancy"
          value={canvas.vibrancy}
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

      <SettingsRow label="Grain" htmlFor="canvas-grain">
        <UnitSlider
          id="canvas-grain"
          label="Grain"
          value={canvas.grain}
          chip={
            <span
              aria-hidden
              className="size-6 shrink-0 rounded-md ring-1 ring-black/15"
              style={{
                background:
                  grain === null ? GRAIN_CHIP_BACKDROP : `${grain}, ${GRAIN_CHIP_BACKDROP}`,
              }}
            />
          }
          onInput={(value) => edit((current) => ({ ...current, grain: value }))}
          onSettle={settle}
        />
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

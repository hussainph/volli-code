/**
 * Reasoning effort as a NOTCHED SLIDER, in three ways of opening it.
 *
 * The ratified shape (owner's call, overriding composer-research.md §5.2's
 * segmented-ramp recommendation): **closed, a compact composer chip showing the
 * level as a word; engaged, a notched slider** — one notch per level the model
 * actually supports, snapping, draggable, clickable, arrow/Home/End/Escape.
 * What is being judged here is not "slider or segments"; it is *how the chip
 * becomes the slider*, which is the only part a screenshot cannot settle.
 *
 * THE LEVELS ARE REAL. `REASONING_LEVELS` (`@volli/shared`) is
 * `off · minimal · low · medium · high · xhigh · max` — seven — and the per-model
 * subset is whatever `ComposerModel.reasoningLevels` carries, which is 3 to 7
 * depending on the model. That variance is the whole difficulty and it is why
 * the model switcher above the rig is not decoration: a control that is elegant
 * at four notches and unusable at seven has not been designed, it has been
 * drawn once. The four fixtures below cover 3, 4-with-`off`, 5 and all 7.
 *
 * WHAT THE CURRENT CONTROL DOES THAT ANY REPLACEMENT MUST KEEP
 * (`chat/composer-ui.tsx:769` `EffortSegment`, read before building):
 *
 *  - **The stop set is per-model and changes under the control.** Picking a
 *    model that lacks the current level rewrites it to `reasoningLevels[0]`.
 *    Every variant here re-clamps on model change rather than holding a level
 *    the model cannot run.
 *  - **Changing effort must not dismiss anything.** Effort is a smaller decision
 *    than model, so today it deliberately leaves the model popover open for a
 *    second look. Variant B keeps that property (the slider's own popover stays
 *    up while you drag); A and C keep it by never opening an overlay at all.
 *  - **It never renders a level the harness would refuse** — the list arrives
 *    filtered. Nothing here invents a stop.
 *
 * And two things it does that a replacement must NOT keep: it renders the raw
 * enum (`xhigh`), and it nests pressable buttons inside a cmdk listbox option,
 * held together by a `stopPropagation`. Labels are title-cased at the UI
 * boundary here (`xhigh → Extra high`), and the slider is one `role="slider"`
 * node with real value semantics, not N buttons.
 *
 * DRAWING LANGUAGE IS NOT INVENTED EITHER. The app already has a slider — the
 * canvas editor's vibrancy control, painted by `globals.css`'s
 * `input[type="range"]` rules: 4px track, `--border-strong` unfilled,
 * `--primary` filled, a 14px `--primary` thumb wearing `shadow-raised`. This
 * one is hand-built rather than a native `<input type="range">` because a range
 * cannot animate its thumb between stops and cannot carry a label that travels
 * with it — but it is painted in exactly those tokens, so it reads as the same
 * object as the slider the app already ships. (If the travelling label loses its
 * feel-check, the native range becomes the cheaper answer and should win.)
 *
 * MOTION is CSS: compositor-friendly where it can be, interruptible everywhere
 * (a transition retargets from its computed value; a keyframe restarts), and
 * `motion-reduce` gated. Nothing imports `motion` — the renderer does not, and
 * a lab draft is not where a library gets adopted. Durations follow the house
 * ladder: 150ms travel on `--ease-out`, dropping to 100ms *while dragging* so
 * the knob does not lag the pointer, 200ms for the chip's own open/close.
 *
 * WHAT TO WATCH
 *
 *  1. **Does it read as a control at rest?** The footer sits at 70% opacity
 *     until the composer has focus (composer-research P15) — that is the state
 *     the effort chip lives in most of the time, so judge it there first, not at
 *     full strength.
 *  2. **Does the row's reflow bother you?** A grows in place and pushes the row;
 *     B never moves a pixel. That is the entire trade between them.
 *  3. **Seven notches.** Switch to `opus-4.6` and drag. If a stop is hard to
 *     land on, the spacing is wrong, not the idea.
 *  4. **`off` as stop zero** (`haiku-4.5`). An empty track at the left end is
 *     coherent for a slider in a way it never was for a segment — check whether
 *     it reads as "thinking off" or as an unpainted control.
 *  5. **Where the level's NAME belongs.** A and C keep the word in the chip,
 *     left of the track, and preview the hovered notch there. B hangs the name
 *     under the thumb so it travels with it. Both are legible; they are not the
 *     same idea, and only one should ship.
 */
import * as React from "react";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { GaugeIcon } from "@phosphor-icons/react/dist/csr/Gauge";
import { CaretUpDownIcon } from "@phosphor-icons/react/dist/csr/CaretUpDown";

import { REASONING_LEVELS, type ReasoningLevel } from "@volli/shared";

import { COMPOSER_STACK_SHELL } from "@renderer/chat/composer-stack";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

export const title = "Effort slider · notched, three openings";
export const note = "The composer's effort chip becoming a notched slider: inline, popover, scrub";
export const viewport = "stage" as const;

/* ------------------------------------------------------------------ levels */

/**
 * The enum is a wire format; this is the copy.
 *
 * `xhigh` is what Pi calls it and what the composer renders today. A control
 * that names its own values in identifiers is a control nobody proof-read.
 */
const LEVEL_LABEL: Record<ReasoningLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * Four real stop-set shapes, because the control has to survive all of them.
 * `defaultLevel` stands in for P20's "which member is the model's own answer" —
 * it is what the model resets to, and it is deliberately NOT drawn on the track
 * yet: a second mark on a control still being judged for legibility would make
 * the feel-check answer two questions at once. See the report.
 */
interface FixtureModel {
  id: string;
  label: string;
  levels: readonly ReasoningLevel[];
  defaultLevel: ReasoningLevel;
}

const THREE: FixtureModel = {
  id: "sonnet-4.5",
  label: "sonnet-4.5",
  levels: ["low", "medium", "high"],
  defaultLevel: "medium",
};

const WITH_OFF: FixtureModel = {
  id: "haiku-4.5",
  label: "haiku-4.5",
  levels: ["off", "low", "medium", "high"],
  defaultLevel: "low",
};

const FIVE: FixtureModel = {
  id: "gpt-5.6-luna",
  label: "gpt-5.6-luna",
  levels: ["minimal", "low", "medium", "high", "xhigh"],
  defaultLevel: "medium",
};

const SEVEN: FixtureModel = {
  id: "opus-4.6",
  label: "opus-4.6",
  levels: REASONING_LEVELS,
  defaultLevel: "high",
};

const MODELS: readonly FixtureModel[] = [THREE, WITH_OFF, FIVE, SEVEN];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Where a model parks when it is selected — P20's "the model's own answer". */
const seedIndex = (model: FixtureModel): number =>
  Math.max(0, model.levels.indexOf(model.defaultLevel));

/* ------------------------------------------------------------------ slider */

/** Half the 14px thumb: the inset the thumb's CENTRE travels between. */
const THUMB = 14;
const INSET = THUMB / 2;
/** Notch pitch inside a composer row. Wide enough to land on with a mouse. */
const INLINE_PITCH = 26;
/** The popover fixes the TRACK instead, so the overlay is one size per model. */
const POPOVER_TRACK = 208;

interface NotchedSliderProps {
  levels: readonly ReasoningLevel[];
  index: number;
  onIndexChange(next: number): void;
  /** Distance between notches. The rail's width is derived from it. */
  pitch: number;
  /** Hangs the current level's name under the thumb, travelling with it. */
  travellingLabel?: boolean;
  /** Escape, so a host that opened this can close it. */
  onDismiss?(): void;
  /** Which notch the pointer is over, for a host that renders the name itself. */
  onPreviewChange?(index: number | null): void;
  /** Forced by variant C, whose gesture starts on the chip and not on the rail. */
  dragging?: boolean;
  railRef?: React.RefObject<HTMLDivElement | null>;
  autoFocus?: boolean;
}

/**
 * The control itself: one focusable node with slider semantics.
 *
 * NOT N buttons. `role="slider"` with `aria-valuenow`/`aria-valuetext` is what
 * a screen reader needs to say "Reasoning effort, High, 4 of 7" — and it is the
 * direct repair of today's arrangement, where seven `aria-pressed` buttons live
 * inside a listbox option. It is also the bigger target: the whole rail is
 * hittable and snaps to the nearest notch, where seven segments are seven small
 * ones.
 *
 * The notch marks sit BELOW the track rather than being cut into it. A gap cut
 * into a 4px bar has to be painted in the surface's own colour, which couples
 * the control to whatever it is dropped on; ticks under the track are the
 * macOS drawing (`NSSlider` with tick marks), owe nothing to the background,
 * and give the travelling label somewhere to live.
 */
function NotchedSlider({
  levels,
  index,
  onIndexChange,
  pitch,
  travellingLabel = false,
  onDismiss,
  onPreviewChange,
  dragging: draggingOverride,
  railRef,
  autoFocus = false,
}: NotchedSliderProps) {
  const ownRef = React.useRef<HTMLDivElement>(null);
  const ref = railRef ?? ownRef;
  const [selfDragging, setSelfDragging] = React.useState(false);
  const [hover, setHover] = React.useState<number | null>(null);
  const dragging = draggingOverride ?? selfDragging;

  const last = levels.length - 1;
  const trackWidth = last * pitch;
  const railWidth = trackWidth + THUMB;
  const centre = INSET + index * pitch;
  // 0 at the first stop, 1 at the last. Drives the label's self-clamping shift
  // so it tucks inside the rail at both ends instead of hanging off them.
  const travel = last === 0 ? 0 : index / last;

  React.useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, ref]);

  const preview = (next: number | null): void => {
    setHover(next);
    onPreviewChange?.(next);
  };

  const indexAt = (clientX: number): number => {
    const rail = ref.current;
    if (rail === null) return index;
    const offset = clientX - rail.getBoundingClientRect().left - INSET;
    return clamp(Math.round(offset / pitch), 0, last);
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={LEVEL_LABEL[levels[index] ?? "medium"]}
      data-dragging={dragging ? "" : undefined}
      style={{ width: railWidth }}
      className={cn(
        "group/rail relative shrink-0 cursor-pointer touch-none py-1 select-none",
        "rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        "data-[dragging]:cursor-grabbing",
      )}
      onPointerDown={(event) => {
        // Secondary buttons are a context menu, not a drag; a second pointer
        // mid-gesture is a finger swap that would teleport the thumb.
        if (event.button !== 0 || dragging) return;
        event.preventDefault();
        ref.current?.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelfDragging(true);
        // macOS: pressing the track jumps to where you pressed, and the same
        // press continues as a drag. One gesture, not two.
        onIndexChange(indexAt(event.clientX));
      }}
      onPointerMove={(event) => {
        if (selfDragging) {
          onIndexChange(indexAt(event.clientX));
          return;
        }
        if (!dragging) preview(indexAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!selfDragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setSelfDragging(false);
      }}
      onPointerCancel={() => setSelfDragging(false)}
      onPointerLeave={() => {
        if (!selfDragging) preview(null);
      }}
      onBlur={() => preview(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // The app's Esc guard reads a bare Escape as "leave the surface".
          // Closing a control you opened is not leaving anything — the composer
          // makes the same call for the `/` picker.
          event.stopPropagation();
          onDismiss?.();
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
        onIndexChange(clamp(next, 0, last));
      }}
    >
      {/* Thumb band. 14px tall, so the knob defines the row and the 4px track
          centres inside it — the native range's own geometry. */}
      <div className="relative h-3.5">
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border-strong" />
        <span
          style={{ width: centre }}
          className={cn(
            "absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-primary",
            "transition-[width] duration-150 ease-out",
            "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none",
          )}
        />
        <span
          style={{ left: centre - INSET }}
          className={cn(
            "absolute top-0 size-3.5 rounded-full bg-primary shadow-raised",
            "transition-[left,scale] duration-150 ease-out",
            "group-data-[dragging]/rail:scale-110 group-data-[dragging]/rail:duration-100",
            "motion-reduce:scale-100! motion-reduce:transition-none",
          )}
        />
      </div>

      {/* Tick rail. Hairlines, because the snap is what a notch actually feels
          like — the marks only have to say how many there are, and where the
          pointer would land. `/50` rather than `/30`: checked in the browser,
          the quiet rung disappeared at the footer's resting 70% and took the
          word "notched" with it. */}
      <div className="relative mt-0.5 h-1">
        {levels.map((level, at) => (
          <span
            key={level}
            style={{ left: INSET + at * pitch }}
            className={cn(
              "absolute top-0 h-1 w-px rounded-full transition-colors duration-150 ease-out",
              at === index || at === hover ? "bg-foreground/90" : "bg-foreground/50",
            )}
          />
        ))}
      </div>

      {travellingLabel ? (
        <div className="relative mt-1 h-4">
          <span
            style={{ left: centre, transform: `translateX(-${travel * 100}%)` }}
            className={cn(
              "absolute top-0 whitespace-nowrap text-label text-foreground uppercase",
              "transition-[left,transform] duration-150 ease-out",
              "group-data-[dragging]/rail:duration-100 motion-reduce:transition-none",
            )}
          >
            {LEVEL_LABEL[levels[index] ?? "medium"]}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- chip parts */

/**
 * The word, and the glyph that says which kind of fact it is.
 *
 * The icon exists because effort sits beside a model pill and two adjacent
 * word-pills read as one control; a glyph is what makes the second one a
 * different KIND of thing, and it gives the chip a fixed left edge while the
 * word changes width under it.
 *
 * `bold`, not `fill` and not the outline default. Checked in the browser at
 * 14px on the footer's resting 70%: regular Brain has enough interior detail
 * that it collapses into a smudge at this size, which is precisely the case
 * CLAUDE.md's icon rule names — coverage is scale-invariant, so `bold`'s flat
 * 1.50× is the only step that fixes a glyph reading too thin, and `size-*`
 * never can. `fill` would be wrong for a different reason: this chip is not the
 * exception among its neighbours, it is one of two peers in a control row.
 */
function EffortWord({ label, muted }: { label: string; muted: boolean }) {
  return (
    <>
      <GaugeIcon className="size-3.5 shrink-0" weight="bold" />
      <span
        className={cn(
          "whitespace-nowrap transition-colors duration-150 ease-out",
          muted && "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </>
  );
}

/** Closes an inline chip on a press anywhere outside it. */
function useDismissOutside(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const node = ref.current;
      if (node !== null && !node.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, ref, onDismiss]);
}

/* ----------------------------------------------------------------- variants */

interface VariantProps {
  model: FixtureModel;
  index: number;
  onIndexChange(next: number): void;
}

/**
 * A — the chip grows in place, and the row reflows around it.
 *
 * The word does NOT leave. It stays pinned at the chip's left edge and the
 * track unfurls to its right, so the value is legible through the whole
 * animation and there is nothing to cross-fade: opening reads as the chip
 * revealing the axis its word was already sitting on. Hovering a notch previews
 * that level in the same word, in muted ink — one readout, never two.
 *
 * The unfurl is `grid-template-columns: 0fr → 1fr` on a wrapper whose child is
 * `overflow-hidden`. That is the accordion trick turned sideways, and it is
 * here instead of a width animation because it needs no measurement: `1fr`
 * under intrinsic sizing resolves to the child's max-content width, so the
 * chip's open width is whatever the slider is, at any stop count, with no
 * ResizeObserver and no hard-coded number to drift.
 *
 * It IS a layout animation, and that is the honest cost of "the row reflows" —
 * which is the thing being judged. One small element in a row with 400px of
 * slack is not where a layout pass shows up.
 *
 * The chip is a container holding a trigger and the rail as SIBLINGS, never a
 * button containing a slider — the nesting defect in today's control is the one
 * thing that must not survive the redesign.
 */
function VariantInline({ model, index, onIndexChange }: VariantProps) {
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<number | null>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const close = React.useCallback((): void => {
    setOpen(false);
    setPreview(null);
  }, []);
  useDismissOutside(open, shellRef, close);

  const shown = preview ?? index;
  const label = LEVEL_LABEL[model.levels[shown] ?? "medium"];

  return (
    <div
      ref={shellRef}
      data-open={open ? "" : undefined}
      className={cn(
        "flex h-7 items-center rounded-full transition-colors duration-200 ease-out",
        "data-[open]:bg-muted motion-reduce:transition-none",
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={`Reasoning effort: ${LEVEL_LABEL[model.levels[index] ?? "medium"]}`}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-ui outline-none",
          "text-muted-foreground transition-[color,background-color,scale] duration-150 ease-out",
          "hover:text-foreground active:scale-[0.97] motion-reduce:scale-100!",
          "focus-visible:ring-2 focus-visible:ring-ring/45",
          !open && "hover:bg-accent",
          open && "text-foreground",
        )}
      >
        <EffortWord label={label} muted={preview !== null} />
      </button>

      {/* Mounted whether or not it is open, and `inert` when it is not: an
          unmount would make CLOSING instant (there would be nothing left to
          collapse), and a 0-width `role="slider"` that is still in the tab
          order is a focus stop nobody can see. */}
      <div
        inert={!open}
        style={{ gridTemplateColumns: open ? "1fr" : "0fr" }}
        className={cn(
          "grid transition-[grid-template-columns] duration-200 ease-out",
          "motion-reduce:transition-none",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="ml-2 border-l border-border/50 px-2">
            <NotchedSlider
              autoFocus={open}
              levels={model.levels}
              index={index}
              onIndexChange={onIndexChange}
              pitch={INLINE_PITCH}
              onPreviewChange={setPreview}
              onDismiss={() => {
                close();
                triggerRef.current?.focus();
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * B — the slider opens in a popover above the chip, and the row never moves.
 *
 * Radix brings what an overlay owes: Escape, outside-press, focus return, and
 * `--radix-popover-content-transform-origin`, so it scales out of the chip
 * rather than out of its own middle. No arrow — the house does not draw them.
 *
 * The track is a FIXED 208px here rather than a fixed pitch, so the overlay is
 * the same object whichever model is selected and only the notch spacing
 * changes. That is the opposite call from A, on purpose: an overlay that
 * resizes when you change models is a different thing appearing, where a chip
 * that grows a little is the same thing carrying more.
 *
 * With vertical room to spend, the name hangs UNDER THE THUMB and travels with
 * it, self-clamping at both ends so it never leaves the rail. This is the
 * variant where "labelled notch" is literal.
 */
function VariantPopover({ model, index, onIndexChange }: VariantProps) {
  const [open, setOpen] = React.useState(false);
  const railRef = React.useRef<HTMLDivElement>(null);
  const last = model.levels.length - 1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn("text-muted-foreground", open && "bg-muted text-foreground")}
        >
          <EffortWord label={LEVEL_LABEL[model.levels[index] ?? "medium"]} muted={false} />
          <CaretUpDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-auto p-3"
        onOpenAutoFocus={(event) => {
          // The rail is the reason this opened; Radix's default would park
          // focus on the content box and the first arrow key would do nothing.
          event.preventDefault();
          railRef.current?.focus();
        }}
      >
        {/* A noun, and nothing else. An `n of m` counter sat here for one round
            and came out: the ticks already say how many stops there are and the
            travelling label already says which one you are on, so it was a
            third voice saying what two were saying better. */}
        <div className="mb-1.5 text-label text-muted-foreground uppercase">Effort</div>
        <NotchedSlider
          travellingLabel
          railRef={railRef}
          levels={model.levels}
          index={index}
          onIndexChange={onIndexChange}
          pitch={last === 0 ? POPOVER_TRACK : POPOVER_TRACK / last}
          onDismiss={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * C — one gesture: press the chip, scrub, release.
 *
 * The distinct interaction, not a third skin. A and B both cost three acts
 * (open · set · close); this one costs one — press, move, let go — and the chip
 * collapses on release with the value already committed. It is the macOS
 * menu-bar-slider gesture, and for a control you touch several times an hour
 * that difference is the whole question.
 *
 * The scrub is RELATIVE, and it has to be. The chip expands to the right of the
 * finger, so mapping the pointer onto the track absolutely would snap the value
 * to `off` the instant you moved. Instead the press records where you were, and
 * movement steps from there at one notch per pitch — a jog wheel, not a
 * position. The knob is therefore not under the finger during the scrub, which
 * is normal for relative scrubbing and is the thing to feel-check.
 *
 * Press without moving falls back to A: the chip latches open, focus lands on
 * the rail, and absolute dragging and the keyboard take over. So the gesture is
 * an accelerator over a control that still works the ordinary way — a mouse
 * user who does not know it exists loses nothing.
 */
function VariantScrub({ model, index, onIndexChange }: VariantProps) {
  const [open, setOpen] = React.useState(false);
  const [scrubbing, setScrubbing] = React.useState(false);
  const [latched, setLatched] = React.useState(false);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const gesture = React.useRef<{ x: number; index: number } | null>(null);

  const close = React.useCallback((): void => {
    setOpen(false);
    setLatched(false);
    setScrubbing(false);
  }, []);
  useDismissOutside(open && latched, shellRef, close);

  return (
    <div
      ref={shellRef}
      data-open={open ? "" : undefined}
      className={cn(
        "flex h-7 items-center rounded-full transition-colors duration-200 ease-out",
        "data-[open]:bg-muted motion-reduce:transition-none",
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-label={`Reasoning effort: ${LEVEL_LABEL[model.levels[index] ?? "medium"]}`}
        className={cn(
          "inline-flex h-7 shrink-0 touch-none items-center gap-1.5 rounded-full px-3 text-ui",
          "text-muted-foreground outline-none select-none",
          "transition-[color,background-color,scale] duration-150 ease-out",
          "hover:text-foreground active:scale-[0.97] motion-reduce:scale-100!",
          "focus-visible:ring-2 focus-visible:ring-ring/45",
          !open && "hover:bg-accent",
          open && "text-foreground",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (latched) {
            close();
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = { x: event.clientX, index };
          setOpen(true);
          setScrubbing(true);
        }}
        onPointerMove={(event) => {
          const start = gesture.current;
          if (start === null) return;
          const steps = Math.round((event.clientX - start.x) / INLINE_PITCH);
          onIndexChange(clamp(start.index + steps, 0, model.levels.length - 1));
        }}
        onPointerUp={(event) => {
          const start = gesture.current;
          if (start === null) return;
          gesture.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          setScrubbing(false);
          // A press that never travelled was a click, and a click means "open
          // it and let me look" — 4px is the slop a mouse gives a deliberate
          // press, not a threshold anyone has to hit.
          if (Math.abs(event.clientX - start.x) < 4) setLatched(true);
          else setOpen(false);
        }}
        onPointerCancel={() => {
          gesture.current = null;
          setScrubbing(false);
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen(true);
          setLatched(true);
        }}
      >
        <EffortWord label={LEVEL_LABEL[model.levels[index] ?? "medium"]} muted={false} />
      </button>

      <div
        inert={!open}
        style={{ gridTemplateColumns: open ? "1fr" : "0fr" }}
        className={cn(
          "grid transition-[grid-template-columns] duration-200 ease-out",
          "motion-reduce:transition-none",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <div className="ml-2 border-l border-border/50 px-2">
            <NotchedSlider
              autoFocus={latched}
              dragging={scrubbing ? true : undefined}
              levels={model.levels}
              index={index}
              onIndexChange={onIndexChange}
              pitch={INLINE_PITCH}
              onDismiss={() => {
                close();
                triggerRef.current?.focus();
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ chrome */

/**
 * Enough composer to judge a chip in, and no more.
 *
 * The shell is the real `COMPOSER_STACK_SHELL` and the bands copy
 * `composer-ui.tsx`'s geometry verbatim (`min-h-16` textarea at `text-sm`,
 * footer `border-t border-border/70 px-3 pt-2 pb-3`), so a control that only
 * looks right in a roomier frame has nowhere to hide. The textarea is real
 * rather than a placeholder line because the resting-dim rule below is driven
 * by focus, and a fake one would make the state you look at most of the time
 * unreachable.
 *
 * THE FOOTER RESTS AT 70% (composer-research P15, Claude's production rule).
 * This is the answer to "won't an always-visible effort control add noise?" —
 * content outranks chrome while you are reading, and the row comes to full
 * strength the moment the composer has focus. Judge the chip dimmed first.
 */
function FixtureComposer({
  model,
  onModelChange,
  children,
}: {
  model: FixtureModel;
  onModelChange(next: FixtureModel): void;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(COMPOSER_STACK_SHELL, "group flex flex-col")}>
      <textarea
        aria-label="Message"
        placeholder="Ask, plan, or implement…"
        className={cn(
          "min-h-16 resize-none bg-transparent px-3 py-3 text-sm outline-none",
          "placeholder:text-muted-foreground",
        )}
      />
      <div
        className={cn(
          "flex items-center gap-1 border-t border-border/70 px-3 pt-2 pb-3",
          "opacity-70 transition-opacity duration-200 ease-out",
          "group-focus-within:opacity-100 motion-reduce:transition-none",
        )}
      >
        <ModelPill model={model} onModelChange={onModelChange} />
        {children}
        {/* 28px, not the shipped composer's 32px `InputGroupButton icon-sm`.
            The row has two control ladders in it today (audit-density §Tier 3);
            an effort chip cannot be judged against a submit button that is off
            the same ladder it has to sit on. */}
        <Button type="button" size="icon" aria-label="Send" className="ml-auto">
          <ArrowUpIcon className="size-3.5" weight="bold" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The neighbour the effort chip has to live beside — and the stop-set switcher,
 * which is the same act. Changing model here is exactly the event that rewrites
 * effort in the app, so the rig has no separate "level count" control: you
 * change models, and the sliders re-clamp the way they would in production.
 */
function ModelPill({
  model,
  onModelChange,
}: {
  model: FixtureModel;
  onModelChange(next: FixtureModel): void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" className="min-w-0 text-muted-foreground">
          <span className="min-w-0 truncate">{model.label}</span>
          <CaretUpDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 p-1">
        {MODELS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => {
              onModelChange(candidate);
              setOpen(false);
            }}
            className={cn(
              "flex h-7 w-full items-center gap-2 rounded-row px-2 text-ui outline-none",
              "transition-colors duration-150 ease-out hover:bg-accent",
              "focus-visible:bg-accent",
              candidate.id === model.id ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-left">{candidate.label}</span>
            <span className="shrink-0 text-label text-muted-foreground tabular-nums">
              {candidate.levels.length}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** One variant, its composer, and the one sentence that says what to look for. */
function VariantCase({
  name,
  claim,
  model,
  onModelChange,
  children,
}: {
  name: string;
  claim: string;
  model: FixtureModel;
  onModelChange(next: FixtureModel): void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-baseline gap-3">
        <h2 className="text-label text-foreground uppercase">{name}</h2>
        <p className="min-w-0 text-ui text-muted-foreground">{claim}</p>
      </header>
      <FixtureComposer model={model} onModelChange={onModelChange}>
        {children}
      </FixtureComposer>
    </section>
  );
}

/* -------------------------------------------------------------------- rig */

/**
 * One model across all three, three independent levels.
 *
 * Shared model because the stop set is the variable being stressed and the
 * comparison is only honest if every variant is drawing the same one.
 * Independent levels because linked ones would jerk the two composers you are
 * not touching, and where each variant left you is part of what is being judged.
 */
export default function EffortSliderScratch() {
  const [model, setModel] = React.useState<FixtureModel>(FIVE);
  const [inline, setInline] = React.useState(() => seedIndex(FIVE));
  const [popover, setPopover] = React.useState(() => seedIndex(FIVE));
  const [scrub, setScrub] = React.useState(() => seedIndex(FIVE));

  // The one thing the app does on a model change, and the reason the rig has no
  // separate "level count" control: picking a model whose set does not hold the
  // current level rewrites it (`composer-ui.tsx:731`). Seeding all three from
  // the incoming model's default is that rule, drawn.
  const selectModel = (next: FixtureModel): void => {
    setModel(next);
    setInline(seedIndex(next));
    setPopover(seedIndex(next));
    setScrub(seedIndex(next));
  };

  return (
    <div className="flex flex-col gap-8 pb-16">
      <p className="text-ui text-muted-foreground">
        Effort levels come from the model — switch it in either pill to change the stop set (3, 4
        with <span className="text-foreground">Off</span>, 5, or all 7). The footer rests at 70% and
        comes up on focus, so judge the chip dimmed first.
      </p>

      <VariantCase
        name="A · Inline"
        claim="The chip grows in place; the word stays and the track unfurls beside it. The row reflows."
        model={model}
        onModelChange={selectModel}
      >
        <VariantInline model={model} index={inline} onIndexChange={setInline} />
      </VariantCase>

      <VariantCase
        name="B · Popover"
        claim="The slider opens above the chip, name travelling under the thumb. The row never moves."
        model={model}
        onModelChange={selectModel}
      >
        <VariantPopover model={model} index={popover} onIndexChange={setPopover} />
      </VariantCase>

      <VariantCase
        name="C · Press-and-scrub"
        claim="Press the chip and drag: one gesture sets and commits. Press without moving latches it open."
        model={model}
        onModelChange={selectModel}
      >
        <VariantScrub model={model} index={scrub} onIndexChange={setScrub} />
      </VariantCase>
    </div>
  );
}

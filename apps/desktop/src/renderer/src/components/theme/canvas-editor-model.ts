/**
 * The canvas editor's logic, with no React in it — the same split the dead
 * theme picker had, for the same reason: one editor is mounted at two scopes
 * (Settings → Appearance and a workspace's Configure → Appearance), so the part
 * worth getting right is the part both mount.
 *
 * Two groups live here.
 *
 *  - **Geometry.** {@link padAnchor} is the whole of "where did that orb land",
 *    and it is a pure function of a pointer, a rect and the grab offset so the
 *    one arithmetic bug a drag pad can have (dividing by a rect that has not
 *    been laid out yet, which reaches CSS as `#NaNNaNNaN` and blanks the window)
 *    is a unit test rather than a screenshot.
 *  - **Wording.** {@link describeAppearance} says what a mode choice means
 *    right now, `auto` included. (The tri-state choice helpers that used to
 *    sit beside it retired with the per-row scope switches: an override is
 *    the ABSENCE of a stored value, and the pages now say `own ?? global`
 *    directly — the same rule `project-appearance-model.ts` states for the
 *    terminal surface.)
 *
 * A contrast report used to be the third group — a standing alert whenever the
 * authored canvas stranded a copy floor. It was removed at the owner's call:
 * a canvas is an aesthetic choice, and a persistent warning about an outcome
 * the user chose is the surface arguing with them (see CLAUDE.md's error rule).
 * The solver still clamps to the best each surface allows; git history has the
 * report if a one-time, at-the-moment-of-choice nudge is ever wanted.
 *
 * Pure: no DOM, no store, no IPC. The editor decides what to paint; this decides
 * what is true.
 */

import { isHexColor, type Appearance, type Canvas, type ResolvedAppearance } from "@volli/shared";

/**
 * Arc's two swatch pages: a pastel row, then the deeper row Volli's own seeds
 * live in. Ported verbatim from the lab's editor — these are the colors the
 * canvas was tuned against, and a fresh set would be a fresh tuning.
 */
export const CANVAS_SWATCH_PAGES: readonly (readonly string[])[] = [
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

/**
 * Which swatch page holds `hex`, or `-1`.
 *
 * The page FOLLOWS the primary rather than being seeded from it once: promoting
 * a stop whose color lives on the other page must not leave nine swatches with
 * the ring on none of them, which is the control silently disagreeing with the
 * window.
 */
export function swatchPageOf(hex: string): number {
  const normalized = hex.trim().toLowerCase();
  return CANVAS_SWATCH_PAGES.findIndex((page) => page.includes(normalized));
}

/** A pad rect, as much of `DOMRect` as the math needs. */
export interface PadRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A pointer over the pad → the fractional anchor the stop under it should take.
 *
 * The grab offset is what keeps a drag from starting with a jump: a press near
 * an orb's edge is up to its radius from the orb's centre, so a handler that
 * treats the pointer AS the centre teleports the orb by that much on the first
 * frame (measured at 14px for a 6px move in the lab). Subtracting it means the
 * orb stays gripped where it was picked up.
 *
 * A zero-sized rect answers `0.5` rather than dividing by it. That is not
 * defensive noise: a pad measured before layout yields `NaN`, `moveStop`'s clamp
 * passes `NaN` straight through (`Math.min(NaN, …)` is `NaN`), and the canvas
 * reaches CSS as an unparseable gradient with no error anywhere.
 *
 * Unclamped on purpose — `moveStop` owns the bounds, and a second clamp here
 * would be a second opinion about where a pool may sit.
 */
export function padAnchor(input: {
  pointerX: number;
  pointerY: number;
  /** Pointer offset from the orb's centre at press time. */
  grabX: number;
  grabY: number;
  rect: PadRect;
}): { x: number; y: number } {
  const { pointerX, pointerY, grabX, grabY, rect } = input;
  return {
    x: rect.width === 0 ? 0.5 : (pointerX - grabX - rect.left) / rect.width,
    y: rect.height === 0 ? 0.5 : (pointerY - grabY - rect.top) / rect.height,
  };
}

/**
 * One arrow press on a 0–1 control, and the same with Shift held.
 *
 * The fine step matches the native slider's `step`, so the pad's orbs (which
 * nudge by this pair, read as pad fractions) and the two wave faders answer
 * the keyboard at the same resolution — controls in one panel that moved by
 * different amounts per press would read as a bug.
 */
export const UNIT_STEP = 0.01;
export const UNIT_STEP_COARSE = 0.05;

/* -------------------------------------------------------------------------- */

/**
 * Which stop "−" will drop, or `null` when there is nothing to drop.
 *
 * Mirrors `removeStop`'s rule rather than restating a simpler one, so the button
 * can NAME its victim: the highest-index stop that is not the primary, because
 * taking the primary would recolor the whole window instead of removing a color.
 */
export function droppedStopIndex(canvas: Canvas): number | null {
  if (canvas.stops.length <= 1) return null;
  const last = canvas.stops.length - 1;
  return last === canvas.primaryIndex ? last - 1 : last;
}

/**
 * A typed hex → the one form everything downstream can use, or `null`.
 *
 * Generous in what it accepts (`E8652A`, `#e86`, stray spaces) and strict in
 * what it emits (`#e8652a`), which is the same widening/narrowing `parseCanvas`
 * does for stored canvases — a field that accepted what the parser accepts and
 * emitted something else would put two spellings of one color in the model.
 */
export function normalizeStopHex(value: string): string | null {
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!isHexColor(prefixed)) return null;
  const digits = prefixed.slice(1).toLowerCase();
  return digits.length === 3 ? `#${digits.replace(/./g, (digit) => digit + digit)}` : `#${digits}`;
}

/* -------------------------------------------------------------------------- */

/**
 * An appearance in words, with `auto` saying what it currently resolves to.
 *
 * "Auto" alone is not an answer to "what will this window look like?", and the
 * resolution is the only part of the pair that can change without anyone
 * touching a control.
 */
export function describeAppearance(appearance: Appearance, resolved: ResolvedAppearance): string {
  return appearance === "auto"
    ? `Auto — ${resolved} right now`
    : appearance === "light"
      ? "Light"
      : "Dark";
}

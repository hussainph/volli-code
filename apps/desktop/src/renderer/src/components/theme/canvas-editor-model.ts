/**
 * The canvas editor's logic, with no React in it — the same split the dead
 * theme picker had, for the same reason: one editor is mounted at two scopes
 * (Settings → Appearance and a workspace's Configure → Appearance), so the part
 * worth getting right is the part both mount.
 *
 * Three groups live here.
 *
 *  - **Geometry.** {@link padAnchor} is the whole of "where did that orb land",
 *    and it is a pure function of a pointer, a rect and the grab offset so the
 *    one arithmetic bug a drag pad can have (dividing by a rect that has not
 *    been laid out yet, which reaches CSS as `#NaNNaNNaN` and blanks the window)
 *    is a unit test rather than a screenshot.
 *  - **The tri-states.** A workspace can override the canvas, the appearance,
 *    either alone, or neither, and each override is the ABSENCE of a stored
 *    value rather than a stored "inherit" marker — the same rule
 *    `project-appearance-model.ts` states for the editor and terminal surfaces.
 *    Naming that here keeps both pages asking the same question.
 *  - **The contrast report.** `copyFloors` declares what copy is held to; the
 *    solver clamps to the best its surface allows rather than throwing. So the
 *    fact that an ask went unmet is *derivable and nowhere reported*, which is
 *    what {@link canvasContrastReport} exists to fix — and {@link easedVibrancy}
 *    turns it from a warning into something the user can act on.
 *
 * Pure: no DOM, no store, no IPC. The editor decides what to paint; this decides
 * what is true.
 */

import {
  apcaLc,
  copyFloors,
  deriveCanvasTokens,
  isHexColor,
  type Appearance,
  type Canvas,
  type ResolvedAppearance,
  type ThemeTokenName,
  type ThemeTokens,
} from "@volli/shared";

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
/*  Scope                                                                      */
/* -------------------------------------------------------------------------- */

/** A workspace's canvas: its own, or the app-wide one. */
export type CanvasChoice = { kind: "inherit" } | { kind: "custom"; canvas: Canvas };

/** A workspace's light/dark choice, scoped independently of its canvas. */
export type AppearanceChoice = { kind: "inherit" } | { kind: "custom"; appearance: Appearance };

/**
 * What the canvas control shows for a workspace.
 *
 * Inherit is the absence of a stored canvas, never a stored marker — a
 * workspace that has been reset must read exactly like one that was never
 * touched, or "does this workspace override its canvas?" has two answers.
 */
export function projectCanvasChoice(canvas: Canvas | null): CanvasChoice {
  return canvas === null ? { kind: "inherit" } : { kind: "custom", canvas };
}

/** The appearance twin of {@link projectCanvasChoice} — same rule, other column. */
export function projectAppearanceChoice(appearance: Appearance | null): AppearanceChoice {
  return appearance === null ? { kind: "inherit" } : { kind: "custom", appearance };
}

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

/* -------------------------------------------------------------------------- */
/*  Contrast                                                                   */
/* -------------------------------------------------------------------------- */

/** One ink `copyFloors` declares a floor for, and what a shortfall in it costs. */
export interface CanvasFloorRole {
  /** The solved foreground token. */
  token: ThemeTokenName;
  /** The surface it is solved against — the rung it is actually painted on. */
  surface: ThemeTokenName;
  /** Which member of `copyFloors` states its ask. */
  key: "body" | "secondary" | "sidebar";
  /** The tier, in the user's words. */
  what: string;
  /** Where in the running app this ink is read. */
  where: string;
}

/**
 * The three absolute floors `copyFloors` declares, each paired with the surface
 * `derive.ts` actually solves it against.
 *
 * Both halves matter and neither is guessable: body is solved on `--background`
 * and secondary on `--card`, one rung down, because secondary copy lives on
 * panels — scoring it on the page's lightest rung is exactly how it came to be
 * 3 Lc short everywhere while a readout said it passed.
 *
 * `labelTowardSecondary` is deliberately absent: it is a POSITION between two
 * already-solved inks rather than a floor, so it cannot fail to be reachable.
 */
export const CANVAS_FLOOR_ROLES: readonly CanvasFloorRole[] = [
  {
    token: "--foreground",
    surface: "--background",
    key: "body",
    what: "Body copy",
    where: "Ticket bodies, document text and every heading in the app.",
  },
  {
    token: "--muted-foreground",
    surface: "--card",
    key: "secondary",
    what: "Secondary copy",
    where: "Timestamps, branch names and helper lines on panels and cards.",
  },
  {
    token: "--sidebar-foreground",
    surface: "--sidebar",
    key: "sidebar",
    what: "Sidebar nav",
    where:
      "Nav rows and section headings. Out on the canvas these are repainted from the canvas ink, which is solved against the gradient itself — so a shortfall here reaches only sidebar text drawn inside the card.",
  },
];

/** One role, measured against the canvas being authored. */
export interface CanvasFloorReading extends CanvasFloorRole {
  /** The Lc `copyFloors` asks for at this appearance. */
  floor: number;
  /** The Lc the emitted hex actually scores on its surface. */
  achieved: number;
  /** The best Lc ANY ink could score on that surface — the physical limit. */
  ceiling: number;
  /** How far the ceiling falls short of the floor. Zero or less when it doesn't. */
  shortfall: number;
  /** True when the surface itself cannot carry the ask, at any hue. */
  capped: boolean;
  /** True when {@link capped} by more than the emitted hex can even express. */
  stranded: boolean;
}

/**
 * Every role, plus two nested subsets — and the split between them is the whole
 * design of the warning.
 *
 * `capped` is the raw physical fact and is reported ALWAYS, inline, as an
 * annotation on the readout: this ink is at the best its surface allows. It is
 * routinely true by a rounding step — the shipped ember canvas crosses in and out
 * of it as the vibrancy slider moves — so an alert keyed on it would blink on and
 * off under the user's hand and teach them to ignore it.
 *
 * `stranded` is the subset worth interrupting for, and it is the one an alert is
 * keyed on. See {@link STRANDED_LC}.
 */
export interface CanvasContrastReport {
  readings: CanvasFloorReading[];
  capped: CanvasFloorReading[];
  stranded: CanvasFloorReading[];
  /** The largest shortfall among {@link stranded}; `0` when nothing is stranded. */
  worstShortfall: number;
}

/**
 * How short a floor has to fall before it is worth saying out loud.
 *
 * Half an Lc, which is the same tolerance the engine's own sweep allows: below
 * it the miss is finer than one step of the 8-bit hex the solver actually emits,
 * so it is a number that exists in the float and not on the screen.
 *
 * It is also what makes the warning trustworthy. `--sidebar` sits a hair under
 * its floor on the shipped canvas at several vibrancies — a shortfall of 0.02 Lc
 * at one slider notch and 0.20 at the next — and a panel that raised an alarm
 * there would be raising one about the default.
 */
export const STRANDED_LC = 0.5;

/**
 * The best contrast any ink can reach on `surface`.
 *
 * Measured from the two extremes of the space rather than from a hue, so it is
 * an upper bound on every candidate: nothing at any chroma beats black or white
 * on a given surface. This is the same expression `solveLightnessOrCeiling`
 * clamps with — asking it from the outside is the only way to learn that the
 * clamp fired, because that function's contract is a color, always.
 */
function ceilingOn(surface: string): number {
  return Math.max(Math.abs(apcaLc("#000000", surface)), Math.abs(apcaLc("#ffffff", surface)));
}

/** One role measured against a derived token set. Its own function so the role's own fields are copied rather than mutated. */
function readFloor(role: CanvasFloorRole, tokens: ThemeTokens, floor: number): CanvasFloorReading {
  const surface = tokens[role.surface];
  const ceiling = ceilingOn(surface);
  const shortfall = floor - ceiling;
  return {
    ...role,
    floor,
    achieved: Math.abs(apcaLc(tokens[role.token], surface)),
    ceiling,
    shortfall,
    capped: shortfall > 0,
    stranded: shortfall > STRANDED_LC,
  };
}

/**
 * What this canvas's copy actually measures, floor by floor.
 *
 * The editor's reason for existing at all: `deriveCanvasTokens` never fails and
 * never complains, because a canvas is the user's to author and a thrown error
 * would blank the window on a swatch click. The cost of that choice is that an
 * unmeetable ask is silent — so the editor measures it back out and says so.
 *
 * A capped reading is a statement about PHYSICS, not about the solver: the
 * surface the ink is painted on is close enough to the middle of the lightness
 * scale that no ink of any hue clears the floor on it. Every reading is
 * reported, capped or not, so the panel can show its work rather than only its
 * complaints.
 */
export function canvasContrastReport(
  canvas: Canvas,
  resolved: ResolvedAppearance,
): CanvasContrastReport {
  const tokens = deriveCanvasTokens(canvas, resolved);
  const floors = copyFloors(resolved);

  const readings = CANVAS_FLOOR_ROLES.map((role) => readFloor(role, tokens, floors[role.key]));
  const stranded = readings.filter((reading) => reading.stranded);
  return {
    readings,
    capped: readings.filter((reading) => reading.capped),
    stranded,
    worstShortfall: stranded.reduce((worst, reading) => Math.max(worst, reading.shortfall), 0),
  };
}

/**
 * The step the eased-vibrancy search walks. 5% is one visible notch on the
 * slider, so the number it offers is one the user can also reach by hand.
 */
const VIBRANCY_STEP = 0.05;

/**
 * The highest vibrancy below the current one at which nothing is stranded, or
 * `null` when there is nothing to offer.
 *
 * Vibrancy is the lever because it is what decides how chromatic the ladder's
 * own neutrals are, and a more chromatic surface has a lower contrast ceiling.
 * It is NOT monotone, though — measured, a magenta at 0.5 strands less than the
 * same magenta at 0.75 and more than it at 1.0 — so this searches the grid
 * downward and takes the first clearing value rather than assuming the shortfall
 * falls with the slider. Assuming it would offer a number that does not work.
 *
 * Keyed on `stranded` rather than `capped`, and for the same reason the alert is:
 * a shortfall finer than the emitted hex is not something to move a slider for.
 *
 * `null` covers both honest ends: nothing is stranded, so there is nothing to
 * fix; or no vibrancy at all clears it, in which case the colour itself is the
 * lever and offering a slider position would be a lie.
 */
export function easedVibrancy(canvas: Canvas, resolved: ResolvedAppearance): number | null {
  if (canvasContrastReport(canvas, resolved).stranded.length === 0) return null;
  const start = Math.ceil(canvas.vibrancy / VIBRANCY_STEP) * VIBRANCY_STEP;
  for (let step = start; step >= 0; step -= VIBRANCY_STEP) {
    const vibrancy = Number(step.toFixed(2));
    if (vibrancy >= canvas.vibrancy) continue;
    if (canvasContrastReport({ ...canvas, vibrancy }, resolved).stranded.length === 0) {
      return vibrancy;
    }
  }
  return null;
}

/** A 0–1 control as a percentage, for a readout. */
export function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** An Lc, at the one decimal the floors are argued in. */
export function lcLabel(value: number): string {
  return value.toFixed(1);
}

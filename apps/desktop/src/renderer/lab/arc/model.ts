/**
 * The vivid canvas, as math: one to three authored color pools in, one CSS
 * `background` and one readable ink color out.
 *
 * This is Arc's Space gradient rather than the app's shipped canvas, and the
 * difference is the experiment. `@volli/shared`'s generator band-clamps every
 * canvas toward the near-black ladder, which is the right call for a surface
 * that has to stay readable under every seed and the wrong one for finding out
 * what a genuinely *vivid* canvas costs. Arc's arrangement is reproduced here
 * closely enough that the answer transfers: freely-placed pools, a light/dark
 * transform that is a real change of color rather than a dimming, and a
 * foreground chosen against the WORST pool on screen instead of the average
 * one.
 *
 * DOM-free on purpose. Everything with a decision in it lives here and is unit
 * tested; `paint.ts` owns the document, `scratches/canvas.tsx` owns the
 * controls. Nothing in the app imports any of it.
 */
import { apcaLc, hexToOklch, isHexColor, oklchToHex, type Oklch } from "@volli/shared";

/**
 * Every number the look depends on, in one place.
 *
 * That is this module's most important property, not a tidiness preference: a
 * gradient is judged by eye and then adjusted, so the adjustment has to be a
 * one-line edit in a table rather than a hunt through four functions. Nothing
 * below is derived from anything else — if a value appears in a formula, it
 * appears here. The one deliberate exception lives just underneath: the stop
 * ceiling is READ OFF this table rather than stated in it, because the two
 * disagreeing is a silent crash rather than a wrong color.
 */
export const ARC_TUNING = {
  /**
   * Where each stop's hue sits relative to the primary's, in degrees, indexed
   * by (stop count − 1): one color, its complement, then a triad. Rotation
   * happens in OKLCH `h`, where the wheel is perceptually even — a triad there
   * reads as three equally-spaced colors rather than three that merely have
   * equally-spaced numbers.
   */
  harmony: [[0], [0, 180], [0, 120, 240]],

  /** Light mode: the authored lightness is pulled into a pastel band. */
  lightBand: {
    /**
     * Below this a "light" canvas stops reading as light at all. Measured at
     * 0.66 with the ember seed: a saturated mid-tone wall that strands BOTH
     * inks near Lc 50 — light scored 56.9, dark 42.1, neither readable. 0.80
     * is where the band turns genuinely pastel; 0.83 buys the last few Lc the
     * worst-case ink score needs once the base fill counts as a surface.
     */
    min: 0.83,
    /** Above it the pools wash out and the ink has nothing to bite on. */
    max: 0.9,
  },

  /** Dark mode: a real drop in lightness, then the same kind of band. */
  darkBand: {
    /** Subtracted from the authored L first, so a dark canvas keeps the seed's ordering. */
    shift: -0.34,
    /** Below this the whole window collapses to one indistinguishable near-black. */
    min: 0.25,
    /** Above it the canvas competes with the content card floating on it. */
    max: 0.44,
  },

  /** Saturation, as a multiplier on the authored chroma. */
  chroma: {
    /** Vibrancy 0 — Arc's leftmost frame, a near-neutral wash that keeps only a hint of hue. */
    floor: 0.14,
    /** Vibrancy 1, light mode: slightly ABOVE the authored chroma, since the light band costs some. */
    lightGain: 1.05,
    /** Vibrancy 1, dark mode: a dark pool has far less room before it turns muddy. */
    darkGain: 0.62,
    /** <1 puts more of the slider's travel in the low half, where the useful range is. */
    vibrancyExponent: 0.75,
    /** Hard ceilings, so a neon seed cannot out-shout the app's own accent. */
    lightCap: 0.16,
    darkCap: 0.09,
  },

  /** The radial pools themselves, in percentages of the painted box. */
  pool: {
    /** Non-primary pool size — wider than tall, like a window. */
    width: 85,
    height: 70,
    /** The primary's pool is the dominant one and reaches past the edges. */
    primaryWidth: 130,
    primaryHeight: 110,
    /** Where a pool has faded to nothing, at vibrancy 0 and 1. Later = a harder edge. */
    fadeMin: 58,
    fadeMax: 74,
    /** The primary fades later still, so it stays the color the window reads as. */
    primaryFadeBonus: 8,
  },

  /** The flat color under every pool, as a drop from the primary's effective L. */
  baseFill: {
    lightDrop: 0.05,
    /** 0.03 left a one-stop dark canvas reading as a flat fill — the pool needs this much to register as shape. */
    darkDrop: 0.045,
  },

  /** The film-noise tile laid over everything. */
  grain: {
    /** Below this the layer is invisible, so it is not emitted at all. */
    threshold: 0.01,
    /** Tile edge in CSS px — pinned, so the texture reads the same on 1x and 2x. */
    tilePx: 140,
    /** feTurbulence: high frequency and few octaves is grain; low frequency is clouds. */
    baseFrequency: 0.9,
    octaves: 2,
    /** Fixed, so the same grain value always produces the same bytes. */
    seed: 7,
    /** Peak alpha at grain 1. Anything higher reads as dirt rather than film. */
    alphaScale: 0.55,
  },

  /**
   * Light-mode surface elevation — how far the surfaces sitting ON the canvas
   * move away from it.
   *
   * A signed amount rather than a mode, because the two arrangements worth
   * comparing are the same arrangement with the sign turned over. Positive
   * lifts each tier toward paper (frosted: the window reads canvas → chrome →
   * sidebar → card, each step closer); negative sinks it toward the ink
   * (recessed: the light ladder's original direction, where the sidebar is a
   * shadowed trough). Zero is neither, and is exactly today's picture.
   *
   * Light only. Dark already separates its tiers by a veil that reads clearly
   * near-black (ΔL 0.022 measured, against light's 0.015 on a far brighter
   * backdrop), which is the whole reason this exists for one mode and not both.
   */
  lift: {
    /**
     * Alpha at lift 1, for the tier furthest from the canvas.
     *
     * 0.7 rather than a gentler number because the alpha buys a share of a
     * headroom that is not fixed: the distance between the canvas and the paper
     * closes as the canvas gets lighter, and at the top of the light band
     * (a near-white seed) it is barely 0.10 of lightness for BOTH tiers to
     * divide. At 0.5 the outer tier's share of that landed at ΔL 0.022 —
     * inside the same invisible range this whole module exists to escape.
     */
    liftAlpha: 0.7,
    /**
     * The sinking counterpart, deliberately smaller. A dark overlay on a pastel
     * canvas costs lightness far faster than a paper one gains it, so matched
     * alphas would make the two halves of the slider travel at different rates.
     */
    sinkAlpha: 0.3,
    /**
     * Each on-canvas tier's share of that alpha, in the order the seam applies
     * them: the chrome band and the project rail first, the inner sidebar
     * second. Cumulative by construction — a tier's share is its DISTANCE from
     * the canvas, so the sidebar always separates from the rail as well as from
     * the gradient.
     *
     * Keyed by {@link ArcSeam} because the shares and the geometry are one
     * decision, not two. `continuous` is the whole reason this is a table: it
     * gives the sidebar a share of ZERO, which is not "a bit less lift" but a
     * different arrangement — the sidebar stops being a surface and becomes the
     * canvas, so the strip of gradient between it and the card stops being a
     * third material. The outer tier takes the entire alpha in exchange, since
     * the rail is then the only thing left to carry the chrome/canvas boundary.
     *
     * Listed most-joined to most-floating, because {@link ARC_SEAMS} reads its
     * offer order straight off these keys.
     */
    seams: {
      continuous: [1, 0],
      inset: [0.45, 1],
      shell: [0.45, 1],
      float: [0.45, 1],
    },
  },

  /**
   * Light-mode elevation shadows — the blurred halo a raised surface casts.
   *
   * Light mode only, and for a structural reason rather than a taste one: on a
   * near-black canvas a shadow has almost no luminance left to remove, so dark
   * mode signals elevation by making a surface LIGHTER and a shadow there is
   * cost without effect. That asymmetry is why the app has none today.
   *
   * The color is the canvas's own hue at low lightness, never neutral black. A
   * neutral shadow over a warm pastel reads as dirt on the canvas — the grey
   * desaturates the pixels under it instead of darkening them.
   */
  shadow: {
    color: { L: 0.32, C: 0.05 },
    /** Peak alphas at strength 1. Every layer scales linearly from here. */
    raised: [
      { y: 1, blur: 2, spread: 0, alpha: 0.12 },
      { y: 2, blur: 7, spread: -1, alpha: 0.18 },
    ],
    card: [
      { y: 1, blur: 3, spread: 0, alpha: 0.1 },
      { y: 10, blur: 30, spread: -6, alpha: 0.24 },
    ],
    overlay: [
      { y: 2, blur: 6, spread: -2, alpha: 0.14 },
      { y: 16, blur: 44, spread: -8, alpha: 0.32 },
    ],
  },

  /** The two candidate foregrounds the flip chooses between. */
  ink: {
    /** Not pure white: a trace of the primary's hue keeps the text part of the canvas. */
    lightL: 0.965,
    lightC: 0.012,
    /** Only ever chosen over a light canvas, so it can afford to sit near-black — 0.24 measured ~8 Lc short there. */
    darkL: 0.19,
    darkC: 0.02,
    /**
     * How far the muted ink slides from the chosen ink toward the base fill's
     * L. Measured against a vibrancy-1 light base fill (the binding surface):
     * 0.3 → Lc 54.3, 0.22 → 58.3, 0.15 → clears 60 with the mute still a
     * visible tier below the full ink.
     */
    mutedTowardBase: 0.15,
  },

  /** A stop dragged on the pad, as a fraction of the window. */
  dragBounds: {
    /** Never fully into a corner — a pool anchored at the very edge only shows a quarter of itself. */
    min: 0.03,
    max: 0.97,
  },

  /** Where `addStop` puts the pool it creates. */
  newStop: {
    /** Diagonal offset from the primary — far enough to read as a second color. */
    step: 0.28,
    /** Kept further inside than a dragged stop, since nobody chose this position. */
    min: 0.08,
    max: 0.92,
  },
} as const;

/**
 * The most stops a canvas can carry — the number of rows in the harmony table,
 * never a number stated beside it.
 *
 * Pools past three stop reading as a palette and start reading as a smear, so
 * the ceiling is a real design limit; it is DERIVED because the failure mode of
 * the two disagreeing is not a wrong color. `harmonyOffsets` clamps its lookup
 * to the ceiling, so a ceiling above the table's length reads past the end,
 * arrives at `undefined`, and NaNs into `#NaNNaNNaN` — a blank scratch and no
 * error. Adding a fourth harmony row is now the only edit that raises it.
 */
export const MAX_STOPS = ARC_TUNING.harmony.length;

/**
 * How the window's regions meet — the one structural choice in an otherwise
 * entirely chromatic model.
 *
 * It exists because separation and cohesion pull opposite ways and the middle
 * of that pull is the worst place to stand. Lifting the sidebar toward paper
 * fixes the rail/sidebar blend, but it also parks the sidebar at a lightness
 * that is neither the canvas nor the card — and with an 8px gutter of raw
 * gradient between it and the card, the window ends up showing three
 * backgrounds and explaining none of them. Every option here is a way of
 * getting back to two things that mean something:
 *
 *  - `continuous` — the sidebar rejoins the canvas (share 0) and only the
 *    chrome band and rail lift. The gutter stops being a band because the
 *    sidebar beside it is the same material. Arc's own arrangement.
 *  - `inset` — the card gives up its gutter, radius and shadow and meets the
 *    sidebar at a hairline. Nothing floats, so nothing needs air around it; the
 *    canvas becomes purely the chrome, and the paper purely the work.
 *  - `shell` — Slack's answer, and the only one that questions the premise. The
 *    other three all treat the sidebar and the card as two objects and argue
 *    about the space between them; this one says they are ONE object with a
 *    colour change down the middle. Sidebar and card share a single rounded,
 *    bordered outline and touch along a seam with no gutter at all, and the
 *    canvas becomes a full frame around them rather than the reverse-L that
 *    `continuous` leaves. The middle lightness stops needing an explanation
 *    because it is no longer a separate surface — it is one half of one.
 *  - `float` — what the tiers shipped as: filled square sidebar, floating
 *    rounded card. Kept so the others can be judged against it.
 *
 * Derived from the tuning table rather than declared beside it, for the same
 * reason as {@link MAX_STOPS}: a seam with no share would compute `undefined`
 * alphas and paint nothing, with no error to find it by.
 */
export type ArcSeam = keyof typeof ARC_TUNING.lift.seams;

/**
 * The seams in the order the editor offers them, READ OFF the tuning table
 * rather than restated — so a seam can never exist without a segment to reach
 * it, and the segments can never drift out of the order the table documents.
 * (String keys enumerate in insertion order, which is what makes the table's
 * own ordering the single place that decision lives.)
 */
export const ARC_SEAMS = Object.keys(ARC_TUNING.lift.seams) as readonly ArcSeam[];

/** Whether `value` names a seam this module can actually paint. */
export function isArcSeam(value: unknown): value is ArcSeam {
  return typeof value === "string" && value in ARC_TUNING.lift.seams;
}

/** One color pool: what it is, and where in the window it is anchored. */
export interface ArcStop {
  /** The AUTHORED color. The pad's orbs show this; the mode transform never touches it. */
  hex: string;
  /** Anchor as a fraction of window width. */
  x: number;
  /** Anchor as a fraction of window height. */
  y: number;
}

export type ArcMode = "auto" | "light" | "dark";

/** `auto` already answered — what the transform and the ink flip actually run against. */
export type ArcResolvedMode = "light" | "dark";

export interface ArcCanvasState {
  /** One to {@link MAX_STOPS}, in the order they were added. */
  stops: ArcStop[];
  /** The dominant pool: bigger, later-fading, and the one every other color is derived from. */
  primaryIndex: number;
  mode: ArcMode;
  /** 0 = near-neutral wash, 1 = as saturated as the caps allow. */
  vibrancy: number;
  /** 0 = no noise layer at all. */
  grain: number;
  /**
   * Light-mode surface elevation, −1 (recessed) → 0 (flush) → 1 (frosted).
   * See {@link ARC_TUNING.lift}; ignored in dark mode.
   */
  lift: number;
  /**
   * How far the paper ladder is mixed toward the canvas's own color, 0–1.
   * A fraction of the canvas mixed IN, not a chroma multiplier — see
   * `tokens.ts`, which is where the mix happens.
   */
  cardTint: number;
  /**
   * How far apart the light ladder's rungs sit, 0 (as mirrored from the dark
   * generator) → 1. Separates the surfaces INSIDE the card the way `lift`
   * separates the ones on the canvas. See `LIGHT_LADDER.spread`.
   */
  surfaceSpread: number;
  /**
   * Light-mode copy weight, 0–1: where secondary and label text sit between
   * their old floors and near-body. See `LIGHT_FLOORS` in `tokens.ts`.
   */
  textWeight: number;
  /** Light-mode elevation shadow strength, 0–1. Scales every layer's alpha. */
  shadow: number;
  /**
   * How the sidebar, the canvas and the card meet. Unlike every other field
   * here it is structural rather than chromatic, and it applies in BOTH modes —
   * whether the card floats is not a question the appearance answers.
   */
  seam: ArcSeam;
}

/** The chosen foreground plus the numbers that chose it. */
export interface ArcInk {
  /** What on-canvas text paints in. */
  ink: string;
  /** The same ink pulled toward the base fill, for secondary rows. */
  inkMuted: string;
  /** APCA Lc of {@link ink} against the pool it reads WORST on. */
  worstLc: number;
  /** The two candidates' scores, so the editor can show how close the call was. */
  lightLc: number;
  darkLc: number;
}

export const DEFAULT_ARC_CANVAS: ArcCanvasState = {
  stops: [{ hex: "#e8652a", x: 0.68, y: 0.3 }],
  primaryIndex: 0,
  mode: "auto",
  vibrancy: 0.6,
  grain: 0.15,
  lift: 0.55,
  cardTint: 0.05,
  surfaceSpread: 0.5,
  textWeight: 0.5,
  shadow: 0.6,
  // Not `float`, which is what the tiers first shipped as. A lifted sidebar
  // beside a floating card puts a strip of bare gradient between two surfaces
  // that are already different from it and from each other, and no amount of
  // tuning the fill makes a third material read as anything but a third
  // material. `continuous` spends the same lift on the rail instead.
  seam: "continuous",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function harmonyOffsets(count: number): readonly number[] {
  return ARC_TUNING.harmony[clamp(count, 1, MAX_STOPS) - 1];
}

/** Resolves `auto`. Split from the `matchMedia` read so the rule itself stays testable. */
export function resolveArcMode(mode: ArcMode, systemDark: boolean): ArcResolvedMode {
  return mode === "auto" ? (systemDark ? "dark" : "light") : mode;
}

/**
 * Re-derives every non-primary hex from the primary's, at the harmony offsets
 * for the current stop count.
 *
 * Lightness and chroma are copied from the primary rather than preserved per
 * stop, which is what makes a multi-stop canvas read as one family instead of
 * three unrelated colors that happen to share a window. Positions are never
 * touched — those are the part the user placed by hand.
 *
 * Every edit that can change the primary's color OR the stop count runs through
 * here, so the family is a property of the state rather than of the order the
 * controls were pressed.
 */
function deriveHarmony(stops: ArcStop[], primaryIndex: number): ArcStop[] {
  const { L, C, h } = hexToOklch(stops[primaryIndex].hex);
  const offsets = harmonyOffsets(stops.length);
  return stops.map((stop, index) => {
    if (index === primaryIndex) return stop;
    const rotated = (((h + offsets[index] - offsets[primaryIndex]) % 360) + 360) % 360;
    return { ...stop, hex: oklchToHex(L, C, rotated) };
  });
}

/** Sets the primary's color; every other stop follows it around the wheel. */
export function withPrimaryHex(state: ArcCanvasState, hex: string): ArcCanvasState {
  const stops = state.stops.map((stop, index) =>
    index === state.primaryIndex ? { ...stop, hex } : stop,
  );
  return { ...state, stops: deriveHarmony(stops, state.primaryIndex) };
}

/**
 * Promotes a stop to primary — the pad's click gesture. Moves the index and
 * NOTHING else.
 *
 * Re-deriving here would be worse than redundant, and the reason is a property
 * of the harmony table: every row is closed under rotation. {0, 180} and
 * {0, 120, 240} have the same multiset of pairwise hue differences seen from
 * any member, so the set of colors a family produces does not depend on which
 * of them is called the primary. Re-deriving therefore asks for the colors that
 * are already on screen — but asks for them through `oklchToHex`, which
 * gamut-maps, so a stop whose chroma had been given up to reach sRGB came back
 * quantised a little flatter every time. Promote A→B→A drifted. Doing nothing
 * is both the correct answer and a lossless one.
 */
export function withPrimaryIndex(state: ArcCanvasState, index: number): ArcCanvasState {
  if (index === state.primaryIndex || index < 0 || index >= state.stops.length) return state;
  return { ...state, primaryIndex: index };
}

/** Moves one stop's anchor, clamped away from the very edges of the window. */
export function moveStop(
  state: ArcCanvasState,
  index: number,
  x: number,
  y: number,
): ArcCanvasState {
  const { min, max } = ARC_TUNING.dragBounds;
  return {
    ...state,
    stops: state.stops.map((stop, at) =>
      at === index ? { ...stop, x: clamp(x, min, max), y: clamp(y, min, max) } : stop,
    ),
  };
}

/** The diagonal from `from` that lands furthest from every stop already placed. */
function freestDiagonal(stops: readonly ArcStop[], from: ArcStop): { x: number; y: number } {
  const { step, min, max } = ARC_TUNING.newStop;
  const candidates = [
    { x: from.x + step, y: from.y + step },
    { x: from.x - step, y: from.y - step },
    { x: from.x + step, y: from.y - step },
    { x: from.x - step, y: from.y + step },
  ].map(({ x, y }) => ({ x: clamp(x, min, max), y: clamp(y, min, max) }));

  let best = candidates[0];
  let bestClearance = -1;
  for (const candidate of candidates) {
    const clearance = Math.min(
      ...stops.map((stop) => Math.hypot(stop.x - candidate.x, stop.y - candidate.y)),
    );
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Adds a harmony stop.
 *
 * The offsets change with the COUNT, so this re-derives the whole family rather
 * than only coloring the newcomer: going from a complement to a triad moves the
 * existing second stop from 180° to 120°, and leaving it behind would produce a
 * set that no longer has a rule.
 */
export function addStop(state: ArcCanvasState): ArcCanvasState {
  if (state.stops.length >= MAX_STOPS) return state;
  const primary = state.stops[state.primaryIndex];
  const stops = [...state.stops, { ...freestDiagonal(state.stops, primary), hex: primary.hex }];
  return { ...state, stops: deriveHarmony(stops, state.primaryIndex) };
}

/**
 * Drops the highest-index stop that is not the primary.
 *
 * Never the primary itself: "−" means "one fewer color", and taking the one the
 * whole family is derived from would recolor the entire window instead. So when
 * the primary happens to BE the last stop, the one below it goes and the middle
 * of the list is what closes up — a deliberate asymmetry, and the only rule
 * that keeps "−" from changing the color you are looking at.
 */
export function removeStop(state: ArcCanvasState): ArcCanvasState {
  if (state.stops.length <= 1) return state;
  const last = state.stops.length - 1;
  const dropped = last === state.primaryIndex ? last - 1 : last;
  const stops = state.stops.filter((_, index) => index !== dropped);
  const primaryIndex = state.primaryIndex > dropped ? state.primaryIndex - 1 : state.primaryIndex;
  return { ...state, stops: deriveHarmony(stops, primaryIndex), primaryIndex };
}

/**
 * The authored color as the window will actually paint it.
 *
 * Lightness is banded rather than scaled, so "light" and "dark" are two
 * genuinely different canvases built from one authored intent — the same seed
 * cannot produce a light canvas that is merely a brightened dark one. Chroma is
 * scaled by vibrancy and then capped: the cap is what stops a neon seed from
 * out-shouting the app's own accent, and it is per-mode because a dark pool
 * turns muddy at a chroma a light one carries comfortably.
 */
function effectiveOklch(hex: string, resolved: ArcResolvedMode, vibrancy: number): Oklch {
  const { L, C, h } = hexToOklch(hex);
  const { lightBand, darkBand } = ARC_TUNING;
  const bandedL =
    resolved === "light"
      ? clamp(L, lightBand.min, lightBand.max)
      : clamp(L + darkBand.shift, darkBand.min, darkBand.max);
  return { L: bandedL, C: effectiveChroma(C, resolved, vibrancy), h };
}

/**
 * How much of an authored chroma survives into the painted canvas — the
 * vibrancy curve and the per-mode cap, on their own.
 *
 * Split out of {@link effectiveOklch} because the token derivation needs
 * exactly this number and nothing else around it: `tokens.ts` seeds the app's
 * generator with `oklch(L Ceff h)` at an arbitrary L, so it wants the canvas's
 * saturation without the canvas's lightness band. Copying the expression there
 * would put the same tuning in two files, and the whole point of `ARC_TUNING`
 * is that there is one place to turn the dial.
 */
export function effectiveChroma(
  authoredChroma: number,
  resolved: ArcResolvedMode,
  vibrancy: number,
): number {
  const { chroma } = ARC_TUNING;
  const light = resolved === "light";
  const gain = lerp(
    chroma.floor,
    light ? chroma.lightGain : chroma.darkGain,
    clamp(vibrancy, 0, 1) ** chroma.vibrancyExponent,
  );
  return Math.min(authoredChroma * gain, light ? chroma.lightCap : chroma.darkCap);
}

function toHex({ L, C, h }: Oklch): string {
  return oklchToHex(L, C, h);
}

/** Every stop's authored color as painted, in stop order. */
export function effectiveStopHexes(state: ArcCanvasState, resolved: ArcResolvedMode): string[] {
  return state.stops.map((stop) => toHex(effectiveOklch(stop.hex, resolved, state.vibrancy)));
}

/**
 * The flat fill under every pool — the primary, a touch darker.
 *
 * Derived from the primary rather than authored, because it is what the window
 * shows wherever no pool reaches, and a base that did not belong to the family
 * would put a seam around the whole canvas.
 */
export function arcBaseFillHex(state: ArcCanvasState, resolved: ArcResolvedMode): string {
  const primary = effectiveOklch(state.stops[state.primaryIndex].hex, resolved, state.vibrancy);
  const drop = resolved === "light" ? ARC_TUNING.baseFill.lightDrop : ARC_TUNING.baseFill.darkDrop;
  return toHex({ ...primary, L: primary.L - drop });
}

/**
 * The noise layer, as a complete `background` layer — image, position, size and
 * repeat in one — or null when grain is off.
 *
 * Self-contained because the alternative is a companion `background-size`
 * whose layer count has to be kept in step with a list that changes length with
 * the stop count and the grain toggle. A per-layer `position / size` in the
 * shorthand cannot fall out of step with itself.
 *
 * The amount is baked into the URI rather than applied as an element opacity so
 * the whole canvas stays ONE property: the seam in `lab.css` drives a single
 * `background`, and a second element would have to be injected into the app's
 * canvas layer to carry an opacity.
 */
export function arcGrainLayer(grain: number): string | null {
  const { threshold, tilePx, baseFrequency, octaves, seed, alphaScale } = ARC_TUNING.grain;
  if (grain <= threshold) return null;
  const alpha = (clamp(grain, 0, 1) * alphaScale).toFixed(3);
  // `stitchTiles` and the pinned filter region are what make the tile seamless;
  // without them the default -10%/120% region shows a grid of edges.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tilePx}" height="${tilePx}">` +
    `<filter id="n" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="luminanceToAlpha"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope="${alpha}"/></feComponentTransfer>` +
    `</filter>` +
    `<rect width="100%" height="100%" filter="url(#n)"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / ${tilePx}px ${tilePx}px repeat`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function pool(stop: ArcStop, hex: string, width: number, height: number, fade: number): string {
  return `radial-gradient(ellipse ${width}% ${height}% at ${percent(stop.x)} ${percent(stop.y)}, ${hex}, transparent ${fade.toFixed(1)}%)`;
}

/**
 * The whole canvas as one CSS `background` value, topmost layer first: grain,
 * then the non-primary pools, then the primary's pool beneath them, then the
 * base fill.
 *
 * The primary sits UNDER the others despite being the dominant color — its
 * pool is large enough to cover them, and painting it on top would make every
 * other stop invisible the moment its fade reached them.
 */
export function arcCanvasBackground(state: ArcCanvasState, resolved: ArcResolvedMode): string {
  const { width, height, primaryWidth, primaryHeight, fadeMin, fadeMax, primaryFadeBonus } =
    ARC_TUNING.pool;
  const effective = effectiveStopHexes(state, resolved);
  const fade = lerp(fadeMin, fadeMax, clamp(state.vibrancy, 0, 1));
  const layers: string[] = [];

  const grain = arcGrainLayer(state.grain);
  if (grain !== null) layers.push(grain);

  state.stops.forEach((stop, index) => {
    if (index === state.primaryIndex) return;
    layers.push(pool(stop, effective[index], width, height, fade));
  });

  const primary = state.stops[state.primaryIndex];
  layers.push(
    pool(
      primary,
      effective[state.primaryIndex],
      primaryWidth,
      primaryHeight,
      fade + primaryFadeBonus,
    ),
  );
  // Last, and a bare color: only the final layer of the shorthand may carry the
  // background-color.
  layers.push(arcBaseFillHex(state, resolved));

  return layers.join(", ");
}

/** The candidate's Lc against the pool it reads WORST on. */
function worstContrast(candidate: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => Math.abs(apcaLc(candidate, surface))));
}

/**
 * Picks the on-canvas foreground: Arc's two precomputed swatches, chosen by
 * measurement rather than by a lightness threshold.
 *
 * Two candidates and not a solve, because a canvas has no single background to
 * solve against — text crosses several pools, so the honest question is which
 * of the two swatches survives the worst one. Scoring is a MINIMUM across the
 * stops for exactly that reason: an average would happily pick an ink that is
 * unreadable over one pool because it is excellent over the other two, which is
 * the failure this whole flip exists to prevent.
 */
export function arcInk(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
  /**
   * What the lift veils composite the on-canvas tiers to — every tier over
   * every pool (see `surfaces.ts`). Passed in rather than derived here because
   * the veils are mixed from the app token set, and this module sits UNDER
   * that: `tokens.ts` imports it, so it cannot import back.
   *
   * Optional, and empty is the honest default: at lift 0 there are no lifted
   * surfaces, and the callers that only want the gradient's own answer (the
   * editor's readout, the model tests) should get exactly that. It matters most
   * when lift is NEGATIVE — a sunk tier is darker than every pool, so an ink
   * scored only against the pools would be scored against the surfaces it does
   * not actually have to survive.
   */
  liftedSurfaces: readonly string[] = [],
): ArcInk {
  const { lightL, lightC, darkL, darkC, mutedTowardBase } = ARC_TUNING.ink;
  const { h } = hexToOklch(state.stops[state.primaryIndex].hex);
  const lightInk = oklchToHex(lightL, lightC, h);
  const darkInk = oklchToHex(darkL, darkC, h);

  // The base fill is a surface too — it is what text sits on wherever no pool
  // reaches, and a worst-case score that exempted it would be an average with
  // extra steps.
  const surfaces = [
    ...effectiveStopHexes(state, resolved),
    arcBaseFillHex(state, resolved),
    ...liftedSurfaces,
  ];
  const lightLc = worstContrast(lightInk, surfaces);
  const darkLc = worstContrast(darkInk, surfaces);
  const chooseLight = lightLc >= darkLc;
  const ink = chooseLight ? lightInk : darkInk;

  const chosen = hexToOklch(ink);
  const base = hexToOklch(arcBaseFillHex(state, resolved));
  return {
    ink,
    inkMuted: toHex({ ...chosen, L: lerp(chosen.L, base.L, mutedTowardBase) }),
    worstLc: chooseLight ? lightLc : darkLc,
    lightLc,
    darkLc,
  };
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `#RGB`, `rrggbb`, stray whitespace → the one form everything downstream can
 * actually use: trimmed, `#`-prefixed, lowercase, six digits. Null when the
 * input is not a color at all.
 *
 * Normalizing rather than merely accepting, because {@link isHexColor} is
 * generous — it takes all of those — while the things that consume a stop's hex
 * are not. ` #E8652A ` reaches CSS as an invalid `background` (the space breaks
 * the value), the swatch row's `===` match against its lowercase presets fails,
 * and the chips print it back at you in whatever shape it arrived. Widening the
 * guard and narrowing the output is what makes the accepted set and the
 * paintable set the same set.
 */
function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (!isHexColor(trimmed)) return null;
  const digits = trimmed.replace("#", "").toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits}`;
}

function clampStop(value: unknown): ArcStop | null {
  if (typeof value !== "object" || value === null) return null;
  const { hex, x, y } = value as Record<string, unknown>;
  if (typeof hex !== "string") return null;
  const normalized = normalizeHex(hex);
  if (normalized === null) return null;
  if (!isUnit(x) || !isUnit(y)) return null;
  return { hex: normalized, x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

/**
 * The persistence guard: anything at all in, a canvas this module can actually
 * paint or null.
 *
 * Ranges are CLAMPED and shapes are REJECTED, which is the distinction that
 * matters. A vibrancy of 4 is a stale value from an earlier tuning pass and
 * still says what the user meant; a missing `stops` array says nothing, and
 * guessing at it would silently resurrect a canvas nobody authored.
 */
export function clampArcCanvasState(value: unknown): ArcCanvasState | null {
  if (typeof value !== "object" || value === null) return null;
  const { stops, primaryIndex, mode, vibrancy, grain } = value as Record<string, unknown>;

  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS) return null;
  const parsed: ArcStop[] = [];
  for (const raw of stops) {
    const stop = clampStop(raw);
    if (stop === null) return null;
    parsed.push(stop);
  }

  if (mode !== "auto" && mode !== "light" && mode !== "dark") return null;
  if (!isUnit(primaryIndex) || !Number.isInteger(primaryIndex)) return null;
  if (primaryIndex < 0 || primaryIndex >= parsed.length) return null;
  if (!isUnit(vibrancy) || !isUnit(grain)) return null;

  return {
    stops: parsed,
    primaryIndex,
    mode,
    vibrancy: clamp(vibrancy, 0, 1),
    grain: clamp(grain, 0, 1),
    ...tuning(value as Record<string, unknown>),
  };
}

/**
 * The tuning fields — the five light dials and the seam — DEFAULTED rather than
 * required, the one place this guard reads an absent field as an answer instead
 * of a question.
 *
 * The distinction it draws is the same one the guard draws everywhere else,
 * just landing the other way. A missing `stops` says nothing and guessing at it
 * resurrects a canvas nobody authored; a missing `lift` says "this was stored
 * before the dial existed", and the honest reading of that is the default the
 * dial ships with. Rejecting instead would throw away a canvas the owner tuned,
 * every time a knob is added — which would make the editor's own persistence
 * the thing that punishes iterating on it.
 */
function tuning(
  value: Record<string, unknown>,
): Pick<ArcCanvasState, "lift" | "cardTint" | "surfaceSpread" | "textWeight" | "shadow" | "seam"> {
  const unit = (raw: unknown, fallback: number, min = 0): number =>
    isUnit(raw) ? clamp(raw, min, 1) : fallback;
  return {
    lift: unit(value.lift, DEFAULT_ARC_CANVAS.lift, -1),
    cardTint: unit(value.cardTint, DEFAULT_ARC_CANVAS.cardTint),
    surfaceSpread: unit(value.surfaceSpread, DEFAULT_ARC_CANVAS.surfaceSpread),
    textWeight: unit(value.textWeight, DEFAULT_ARC_CANVAS.textWeight),
    shadow: unit(value.shadow, DEFAULT_ARC_CANVAS.shadow),
    // Membership-checked rather than clamped, since a seam has no range to fall
    // back into — but still defaulted rather than rejected, exactly like the
    // dials, so a canvas stored before the seam existed survives the upgrade.
    seam: isArcSeam(value.seam) ? value.seam : DEFAULT_ARC_CANVAS.seam,
  };
}

/** One `#rrggbb` channel, 0–255. */
function channel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

/**
 * `over` at `alpha` composited on `under`, as a hex.
 *
 * In 8-bit sRGB rather than OKLCH for the same reason `veil.ts` solves there:
 * what has to match is the byte the compositor produces, and the compositor
 * works in gamma-encoded channels. A perceptual mix would predict a pixel the
 * browser never paints, and every measurement taken against it — every ink
 * score, every reported Lc — would be measuring a surface that isn't on screen.
 */
export function compositeHex(over: string, alpha: number, under: string): string {
  const bytes = [0, 1, 2].map((index) => {
    const mixed = channel(over, index) * alpha + channel(under, index) * (1 - alpha);
    return clamp(Math.round(mixed), 0, 255).toString(16).padStart(2, "0");
  });
  return `#${bytes.join("")}`;
}

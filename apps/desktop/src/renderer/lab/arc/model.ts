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
   * Surface elevation — how far the surfaces sitting ON the canvas move away
   * from it.
   *
   * A signed amount rather than a mode, because the two arrangements worth
   * comparing are the same arrangement with the sign turned over. Positive
   * walks each tier toward paper (frosted: the window reads canvas → chrome →
   * sidebar → card, each step closer); negative walks it away from paper
   * (recessed). Zero is neither: every tier is the bare canvas. Where the
   * settled canvas sits on that axis is {@link ARC_SETTLED.lift}; what a step
   * along it COSTS is here.
   *
   * **Both modes**, and the reason it reads as one mechanism rather than two is
   * that "toward paper" is a direction on the ladder, not a direction on the
   * lightness axis. Measured across seeds at vibrancy 1, `--background` sits
   * ABOVE the canvas in light (ember 0.78 → 0.949) and BELOW it in dark (0.276
   * → 0.176): the dark card is a well cut into a bright wash, not a panel
   * raised off a dim one. So the same target produces the frosted reading in
   * both, and it is the SIGN of the lightness step that flips, not the model.
   *
   * That is also why the sink target is derived rather than declared — see
   * `liftTarget` in surfaces.ts. Hardcoding "sink means darker" would send both
   * signs the same way in dark, where paper is already the darker end.
   */
  lift: {
    /**
     * Alpha at lift 1, for the tier furthest from the canvas.
     *
     * Light is 0.7 rather than a gentler number because the alpha buys a share
     * of a headroom that is not fixed: the distance between the canvas and the
     * paper closes as the canvas gets lighter, and at the top of the light band
     * (a near-white seed) it is barely 0.10 of lightness for BOTH tiers to
     * divide. At 0.5 the outer tier's share of that landed at ΔL 0.022 —
     * inside the same invisible range this whole module exists to escape.
     *
     * Dark is LOWER for the opposite reason, and the number comes from matching
     * what light actually delivers rather than from taste. The overlay
     * composites in sRGB bytes, where the curve is far steeper near black, so
     * the same alpha buys much more lightness down there. Measured at 0.7 in
     * dark: ember −0.072, a white seed −0.146 — against light's own 0.070–0.119
     * band across the same seeds. 0.5 brings dark's top end (−0.101 on white)
     * back inside it.
     *
     * What no alpha fixes is the SPREAD across seeds in dark: a dark blue seed
     * puts the canvas at L 0.205 with paper at 0.176, so the entire distance
     * this arm can travel is 0.029 and every setting is invisible. That is a
     * property of that canvas rather than of this number — the fix is Vibrancy
     * or a lighter seed, and the honest behaviour here is a mechanism that runs
     * out of room rather than one that invents some.
     *
     * At {@link ARC_SETTLED.lift} it is the LIGHT row that gets read: light's
     * paper is the lighter end of the ladder, so reaching it is a positive lift.
     * Dark's row stays measured rather than deleted because which arm a mode
     * takes is a consequence of where its paper sits, and that is a property of
     * the ladder rather than of the appearance — see `liftTarget`.
     */
    liftAlpha: { light: 0.7, dark: 0.5 },
    /**
     * The sinking counterpart, smaller in both modes and by a wider margin in
     * dark — and, at the settled lift, the row DARK reads.
     *
     * Same asymmetry, same cause, seen from each end: sink walks toward whatever
     * ink is on the FAR side of the canvas from the paper, so in light it is a
     * dark overlay on a pastel wash and in dark it is a near-white one on a dim
     * wash. Both of those move lightness faster than their lifting counterpart
     * does — a dark overlay drains a pastel quickly, and a light overlay near
     * black gains even quicker — so matched alphas would make the two signs
     * travel at different rates.
     *
     * Which is why dark ends up here rather than on the row above: its paper is
     * the DARKER end of the ladder, so a sidebar that reads as lifted has to
     * walk away from it, and 0.12 against light's 0.7 is what makes those two
     * walks the same length (+0.022 and +0.023 on the ember default).
     */
    sinkAlpha: { light: 0.3, dark: 0.12 },
    /**
     * Each on-canvas tier's share of that alpha, outward from the gradient: the
     * chrome band and the project rail first, the inner sidebar second.
     * Cumulative by construction — a tier's share is its DISTANCE from the
     * canvas, so the sidebar always separates from the rail as well as from the
     * gradient.
     *
     * The zero is the whole statement, and it is the settled seam's. The window
     * insets the sidebar+card unit and runs bare gradient all the way around
     * it, so an outer tier with ANY share would draw a hard edge along every
     * wall of that frame — chrome band against the 8px above the unit, project
     * rail against the 8px beside it. That edge is the sharp chrome the
     * arrangement exists to remove: the frame is meant to read as one
     * uninterrupted background with a single object floating in it, and a
     * lifted band across its top says the frame has two parts. Pinning the
     * outer tier to the canvas is what Slack's arrangement actually rests on —
     * its search bar, workspace rail and the margin around the channel list are
     * all one flat colour, and the only thing that moves is the inner sidebar.
     *
     * So the chrome band and rail ARE the canvas, and the sidebar takes the
     * entire alpha. Three other arrangements were tried against this one
     * (`continuous`, `inset`, `float`) and each spent some of the alpha out
     * here; the frame is what survived, and this row is what it costs.
     */
    shares: [0, 1],
  },

  /**
   * Elevation shadows — the blurred halo a raised surface casts.
   *
   * This was light-only, on the argument that a near-black canvas has almost no
   * luminance left for a shadow to remove. The argument is sound and it was
   * about the wrong backdrop: it describes the APP's dark theme, whose page sits
   * at L 0.18, not this canvas, which is a vivid wash measuring L 0.21–0.44
   * across the seeds. There is real luminance there to take away, so a shadow
   * buys something in both modes.
   *
   * The color is the canvas's own hue at low lightness, never neutral black. A
   * neutral shadow over a warm pastel reads as dirt on the canvas — the grey
   * desaturates the pixels under it instead of darkening them.
   *
   * Both rungs sit BELOW every canvas their mode can produce, which is the one
   * thing this pair has to get right: light's 0.32 clears the light band's floor
   * (0.78 on the darkest seed) comfortably, but reusing it in dark would put the
   * shadow ABOVE a dim canvas (0.205 on a dark blue seed) and the halo would
   * glow instead of fall. 0.06 sits under the darkest canvas and under the paper
   * besides, so it darkens whatever it lands on.
   *
   * Where it BITES is uneven in dark, and that is honest rather than fixable
   * here: `card` and `overlay` fall on the canvas and read clearly, while
   * `raised` falls on `--card` (L 0.20) where there genuinely is little left to
   * remove. Dark signals in-card elevation by making a surface lighter, which is
   * the token ladder's job and not this table's.
   */
  shadow: {
    color: { light: { L: 0.32, C: 0.05 }, dark: { L: 0.06, C: 0.03 } },
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

  /**
   * The two candidate foregrounds the flip chooses between, and the ladder
   * under whichever one wins.
   *
   * Three tiers rather than two, mirroring what the card already has
   * (`LIGHT_FLOORS` in `tokens.ts`): a head, a section/label tier, and a mute.
   * The canvas needs its own copy because the card's is solved against `--card`
   * and this text does not sit on `--card` — but it needs the same SHAPE, or
   * the sidebar and the paper beside it would rank their copy differently and
   * the window would read as two design languages.
   */
  ink: {
    /** Not pure white: a trace of the primary's hue keeps the text part of the canvas. */
    lightL: 0.965,
    lightC: 0.012,
    /** Only ever chosen over a light canvas, so it can afford to sit near-black — 0.24 measured ~8 Lc short there. */
    darkL: 0.19,
    darkC: 0.02,
    /**
     * How far the muted ink slides from the chosen ink toward the base fill's
     * L, at `textWeight` 0 → 1.
     *
     * A LIGHTNESS slide rather than a solved Lc floor, and that is the one real
     * decision in this block. Lc is the wrong unit for tier SEPARATION here,
     * because the ink sits at whichever end of the scale APCA's curve is
     * compressed at: measured on the ember default, a slide of 0.15 costs 3.7 Lc
     * in light mode (62.4 → 58.7) and 21.3 in dark (94.1 → 72.8) — the same
     * perceptual step, two wildly different numbers. Sliding gives one ladder
     * that LOOKS the same in both modes; solving to matched Lc drops would give
     * two that measure the same and look nothing alike. Lc is still what guards
     * the bottom of the ladder — see {@link mutedFloor}.
     *
     * Backwards against the weight, exactly like
     * `LIGHT_FLOORS.labelTowardSecondary`: turning copy weight UP means the
     * tiers move toward the full ink, which is a smaller slide rather than a
     * larger one.
     *
     * Centred on 0.27 rather than on the 0.15 this replaced, and that is a
     * correction rather than a preference. 0.15 was tuned when this was the
     * ONLY step under the ink; asking it to hold two tiers left both of them
     * inside the range where a ladder measures as a ladder and does not read as
     * one. Swept on the running sidebar at 0.20 / 0.25 / 0.30 / 0.35 / 0.40:
     * 0.20 still crowds the title above it, 0.35 goes soft, 0.40 is faint. This
     * range spans that verdict, and {@link ARC_SETTLED.textWeight} sits near its
     * open end in both modes — 0.32 in light, 0.31 in dark.
     */
    mutedTowardBase: { min: 0.34, max: 0.2 },
    /**
     * Where the section/label tier sits between the full ink and the mute, at
     * `textWeight` 0 → 1 — a POSITION between two tiers, never a slide of its
     * own.
     *
     * Stated relatively for the same reason `LIGHT_FLOORS.labelTowardSecondary`
     * is: a third independent slide could cross either neighbour once the floor
     * below starts clamping, while a fraction of the mute's own slide cannot —
     * it is bounded by construction at every weight, every canvas and every
     * mode. It also inherits the clamp for free: if the mute compresses because
     * the canvas ran out of contrast, the label tier compresses with it instead
     * of jumping past.
     *
     * Never reaches 0. At the top of the range every tier is asked to move
     * toward the head, but a label that arrived exactly ON it would leave the
     * sidebar with two tiers again — which is the defect this ladder exists to
     * remove.
     */
    labelTowardMuted: { min: 0.65, max: 0.35 },
    /**
     * The worst-surface Lc the muted tier may never fall under, whatever the
     * slide asks for.
     *
     * The canvas has nothing like the card's headroom — full ink measures Lc
     * 62.4 on the ember default against body copy's 90 on paper — so a slide
     * that is comfortable on one gradient can strand the bottom tier on the
     * next. Swept across every swatch the editor offers, both modes, three
     * vibrancies and one/three stops: the head never drops under Lc 61.9, and 48
     * is the floor that still leaves the hardest of those canvases 0.30 of slide
     * to spend — enough for the full three rungs. It sits above APCA's 45 for
     * large or bold text, which is the relevant line for an 11px meta row that
     * the sidebar also promotes to full ink on hover.
     *
     * Binding it is not a failure — it is the degradation. The ladder
     * COMPRESSES toward the head (see {@link maxReadableSlide}), so a canvas
     * with no room left shows two tiers or one rather than three unreadable
     * ones, and no tier can ever cross another on the way. What used to exercise
     * it hardest was a strongly sunk canvas, where the veil darkened the chrome
     * until the head ink itself measured 37.6 and every rung collapsed onto it;
     * {@link ARC_SETTLED.lift} no longer travels anywhere near that far, but the
     * floor stays because the seed does not have to be one of the editor's.
     */
    mutedFloor: 48,
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
 * The five settings that used to be dials on {@link ArcCanvasState}, at the
 * values the tuning pass ended on.
 *
 * A separate table from {@link ARC_TUNING} because the two answer different
 * questions, and keeping that distinction is the point rather than tidiness.
 * Everything up there is a constant of the MODEL — a band edge, a cap, an alpha
 * — true of every canvas the owner might author. Everything here is a CHOICE,
 * made on screen against the app's own chrome, that stopped changing. A later
 * disagreement with one of these is an argument about taste and belongs in this
 * block; a disagreement with the other table is an argument about the math.
 *
 * Three of the five are per-mode, and none of the three is a branch bolted on
 * afterwards: each targets a quantity that measures differently at the two ends
 * of the lightness axis, so one intent needed solving twice. The two that are
 * NOT per-mode are the ones whose intent is already stated in mode-independent
 * units, and they were checked in both rather than assumed.
 *
 * Every number below was solved against the ember default at vibrancy 0.6 — the
 * canvas the app ships with — and then measured across the editor's other seeds
 * to confirm it does not fall apart on them.
 */
export const ARC_SETTLED = {
  /**
   * Surface elevation: where the on-canvas tiers sit on {@link ARC_TUNING.lift}'s
   * signed axis.
   *
   * Opposite signs, one result. Measured on the ember default, the sidebar
   * lands ΔL +0.023 above the canvas in light and +0.022 above it in dark — the
   * same pane, lit the same way, in both appearances. It takes a POSITIVE lift
   * to get there in light (paper is the lighter end, 0.780 → 0.923) and a
   * negative one in dark (paper is the darker end, 0.278 → 0.197), because the
   * dark card is a well cut into a bright wash rather than a panel raised off a
   * dim one. Reading the pair as "frosted in light, recessed in dark" gets the
   * mechanism right and the picture backwards.
   *
   * A quarter rather than the half the dial opened on: at 0.5 the sidebar
   * cleared the canvas by twice as much and started reading as a second card
   * rather than as a pane of the window, which is the failure at the far end of
   * the same axis the tiny shipped veil failed at the near end of.
   */
  lift: { light: 0.25, dark: -0.25 },

  /**
   * How far the paper ladder is mixed toward the canvas's own colour, 0–1 — a
   * fraction of the canvas mixed IN, not a chroma multiplier (see `tokens.ts`,
   * where the mix happens).
   *
   * The same in both modes, and that is a measurement rather than a
   * convenience: the mix is stated as a fraction of the distance between two
   * surfaces, so it already means the same thing on a pastel and on a
   * near-black. The dark path scales it by `DARK_LADDER.tintScale` for the one
   * asymmetry that IS real — the distance being crossed there is longer.
   *
   * 0.25 is the top of the range the editor offered, which is the honest place
   * for it to have landed: the owner's directive was that the card belong to
   * the canvas's family, and every value under it read as a card that merely
   * had a tint applied.
   */
  cardTint: 0.25,

  /**
   * How far apart the ladder's rungs sit inside the card — solved, in each
   * mode, for the ONE rung pair the complaint was actually about: `--rail`
   * under `--background`, the tab strip beneath a tab.
   *
   * Two numbers because the target is |ΔL| and perceptual step size is not
   * symmetric about mid-grey. The light ladder is a mirror of the dark
   * generator's and inherited a spacing that does not survive the mirror, so it
   * needs a much bigger correction to reach a gap that reads: 0.042 near paper
   * against 0.020 near black. Solving one number for both would be picking
   * which mode to leave broken.
   *
   * Measured at {@link cardTint} 0.25 and nowhere else, because the gap is
   * tint-dependent — the mix pulls every rung toward one target, so the gaps
   * scale by (1 − mix) and a spread solved at a lower tint lands short here.
   *
   *  - light `0.943` → rail ΔL 0.0420. Band that rounds to 0.042: 0.921–0.964.
   *  - dark `0.627` → rail ΔL 0.0197, the closest the 8-bit rungs come to
   *    0.020. Band: 0.571–0.683, and the ceiling at spread 1 is only 0.0242 —
   *    dark has far less room here, which is the other half of why the two
   *    numbers cannot be one.
   */
  surfaceSpread: { light: 0.943, dark: 0.627 },

  /**
   * Copy weight: where secondary and label text sit between their old floors
   * and near-body (see `LIGHT_FLOORS` / `DARK_FLOORS` in `tokens.ts`, and
   * `ARC_TUNING.ink` for the canvas's own ladder).
   *
   * Per-mode because the ranges it indexes are, and they are per-mode because
   * each starts at its own generator's floor — 68 in light, 60 in dark. The
   * same dial position would therefore mean two different Lc, so the number
   * that was frozen is the Lc and the weight is read back off it.
   *
   *  - light `0.133` → secondary Lc 69.9 on `--card`, label 51% of the way from
   *    secondary to body. Band satisfying both: 0.122–0.144.
   *  - dark `0.222` → secondary Lc 64.0, label 55%. Band: 0.211–0.233.
   */
  textWeight: { light: 0.133, dark: 0.222 },

  /**
   * Elevation shadow strength, 0–1 — a scale on every layer's alpha in
   * {@link ARC_TUNING.shadow}.
   *
   * One number for both modes because the per-mode part of a shadow is its
   * COLOUR, which that table already carries: light's rung sits under the light
   * band and dark's under the darkest canvas, so the same strength removes a
   * comparable share of whatever luminance is there. What 0.75 buys over the
   * 0.6 the dial opened on is the contact edge on the tab — the tier the
   * owner's screenshot was of — without the wide layer turning into a smudge.
   */
  shadow: 0.75,
} as const;

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

/**
 * A canvas, as the user authors it — and ONLY as the user authors it.
 *
 * Five fields, where there were eleven. The six that left were dials the owner
 * tuned and then settled; they now live in {@link ARC_SETTLED}, which is what
 * makes this interface the shape of the feature rather than the shape of the
 * editor. What is left is exactly what a Settings pane would offer: the
 * gradient, its saturation, its texture, and the appearance to resolve against.
 */
export interface ArcCanvasState {
  /** One to {@link MAX_STOPS}, in the order they were added. */
  stops: ArcStop[];
  /** The dominant pool: bigger, later-fading, and the one every other color is derived from. */
  primaryIndex: number;
  /** Light, dark, or follow the system — resolved at paint time by {@link resolveArcMode}. */
  mode: ArcMode;
  /** 0 = near-neutral wash, 1 = as saturated as the caps allow. */
  vibrancy: number;
  /** 0 = no noise layer at all. */
  grain: number;
}

/** The chosen foreground, the ladder under it, and the numbers that chose it. */
export interface ArcInk {
  /** What on-canvas text paints in. */
  ink: string;
  /**
   * One step down: section headings and group labels — the canvas's mirror of
   * the card's `--lab-label-ink` tier.
   */
  inkLabel: string;
  /** The same ink pulled toward the base fill, for secondary rows. */
  inkMuted: string;
  /** APCA Lc of {@link ink} against the pool it reads WORST on. */
  worstLc: number;
  /** The tiers under it, on the same worst-case surface list. */
  labelLc: number;
  mutedLc: number;
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

/** A tuning range at a copy weight, clamped to the range's own travel. */
function atWeight({ min, max }: { min: number; max: number }, textWeight: number): number {
  return lerp(min, max, clamp(textWeight, 0, 1));
}

/**
 * Halvings in the readable-slide search: 1/1024 of the slide, comfortably finer
 * than one step of the 8-bit hex it ends up as.
 */
const SLIDE_SEARCH_STEPS = 10;

/**
 * The furthest a tier may slide toward the base fill before it stops clearing
 * `floor` on the surface it reads worst on.
 *
 * Searched rather than solved, and searched rather than merely clamped
 * afterwards, for three reasons that all point the same way. There is no closed
 * form: the score is a MINIMUM over several surfaces, so the binding one can
 * change partway along the slide and any inverse would have to know which. A
 * solver would have to be handed one background and would therefore answer for
 * a surface the text does not only sit on — the exact averaging this module
 * exists to refuse. And a search cannot throw, where
 * `solveLightnessForContrast` does when the target is unreachable: the gradient
 * is still the owner's to author, and a canvas vivid enough to strand the
 * bottom tier is a canvas the stop editor is allowed to reach.
 *
 * Monotone, which is what makes bisection valid here rather than merely
 * convenient. Every surface lies between the base fill's lightness and the
 * pools', and the ink sits outside that span on whichever side its flip put it
 * — so walking toward the base fill walks toward every surface at once, and the
 * worst score only ever falls.
 *
 * Both ends are answers, not errors. `1` means the floor never binds and the
 * full slide is spent; `0` means this canvas has no room for a ladder at all, and the
 * honest response is a flat one — every tier on the head ink — rather than
 * three tiers nobody can read.
 */
function maxReadableSlide(
  slide: (t: number) => string,
  surfaces: readonly string[],
  floor: number,
): number {
  const reaches = (t: number) => worstContrast(slide(t), surfaces) >= floor;
  if (!reaches(0)) return 0;
  if (reaches(1)) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < SLIDE_SEARCH_STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (reaches(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Picks the on-canvas foreground: Arc's two precomputed swatches, chosen by
 * measurement rather than by a lightness threshold — then builds the two tiers
 * that rank under it.
 *
 * Two candidates and not a solve, because a canvas has no single background to
 * solve against — text crosses several pools, so the honest question is which
 * of the two swatches survives the worst one. Scoring is a MINIMUM across the
 * stops for exactly that reason: an average would happily pick an ink that is
 * unreadable over one pool because it is excellent over the other two, which is
 * the failure this whole flip exists to prevent.
 *
 * The ladder under the winner walks toward the BASE FILL, which is what keeps
 * it correct in both appearances without a branch: the base fill is the far
 * side of the canvas from whichever ink won, so "toward the base fill" is
 * "toward the surface" whether the ink is near-black on a pastel or near-white
 * on a near-black. A ladder stated as "lighter" or "darker" would invert the
 * moment the flip did.
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
   * Optional, and empty is the honest default: the callers that only want the
   * gradient's own answer (the model tests) should get exactly that. What it
   * buys the real caller is the sink arm — dark's settled lift walks the sidebar
   * to a tier LIGHTER than every pool, so an ink scored on the pools alone would
   * be scored against surfaces it does not actually have to survive.
   */
  liftedSurfaces: readonly string[] = [],
): ArcInk {
  const { lightL, lightC, darkL, darkC, mutedTowardBase, labelTowardMuted, mutedFloor } =
    ARC_TUNING.ink;
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
  const slide = (t: number) => toHex({ ...chosen, L: lerp(chosen.L, base.L, t) });

  // The same copy weight the card's own tiers are solved at, so the sidebar out
  // on the gradient and the paper beside it rank their text by one decision
  // rather than two.
  const textWeight = ARC_SETTLED.textWeight[resolved];
  // The ask, capped by what the canvas can actually carry. Taking the minimum
  // rather than reporting a failure is the whole degradation story: the ladder
  // gets shorter on a canvas with no headroom, and never unreadable.
  const mutedSlide = Math.min(
    atWeight(mutedTowardBase, textWeight),
    maxReadableSlide(slide, surfaces, mutedFloor),
  );
  // A FRACTION of the slide above, so the label tier is bounded by its two
  // neighbours by construction — it inherits the cap without being told about
  // it, and cannot cross either of them at any weight.
  const inkLabel = slide(mutedSlide * atWeight(labelTowardMuted, textWeight));
  const inkMuted = slide(mutedSlide);

  return {
    ink,
    inkLabel,
    inkMuted,
    worstLc: chooseLight ? lightLc : darkLc,
    labelLc: worstContrast(inkLabel, surfaces),
    mutedLc: worstContrast(inkMuted, surfaces),
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
 *
 * Extra keys are IGNORED, which is the third case and the one the freeze
 * created. Every canvas stored while `lift`, `cardTint`, `surfaceSpread`,
 * `textWeight`, `shadow` and `seam` were still dials carries all six, and the
 * settings they name are no longer the user's to state — so reading them back
 * would resurrect a tuning pass that has already been decided, and rejecting
 * the entry would throw away the gradient the owner actually authored. Reading
 * only the fields this shape still has does both right things at once, and it
 * is why the destructure below names them one by one instead of spreading.
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

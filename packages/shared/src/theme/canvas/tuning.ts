/**
 * Every number the look depends on, in one place.
 *
 * That is this module's most important property, not a tidiness preference: a
 * gradient is judged by eye and then adjusted, so the adjustment has to be a
 * one-line edit in a table rather than a hunt through four functions. Nothing
 * elsewhere in this directory is a magic number — if a value appears in a
 * formula, it appears here. The one deliberate exception lives at the bottom:
 * the stop ceiling is READ OFF this table rather than stated in it, because the
 * two disagreeing is a silent crash rather than a wrong color.
 *
 * These are constants of the MODEL — band edges, caps, alphas, true of every
 * canvas anyone might author. The CHOICES made against them live next door in
 * `settled.ts`. A disagreement with this table is an argument about the math; a
 * disagreement with that one is an argument about taste.
 *
 * Each value's own comment says what it is and what it costs. The measurement
 * runs — the alpha sweeps, the band probes, the arrangements that were tried and
 * dropped — live in `docs/plans/arc-theming-migration.md` § Appendix — measured
 * derivations, and every entry below that had one points at its heading.
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
     * Below this a "light" canvas stops reading as light at all — at 0.66 a
     * saturated mid-tone wall strands BOTH inks near Lc 50. 0.80 is where the
     * band turns genuinely pastel; the last 0.03 is what the worst-case ink
     * score needs once the base fill counts as a surface. Appendix § Light band.
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
   * comparing are the same arrangement with the sign turned over. Positive walks
   * each tier toward paper (frosted), negative walks it away (recessed), zero is
   * the bare canvas. Where the settled canvas sits on that axis is
   * `ARC_SETTLED.lift`; what a step along it COSTS is here.
   *
   * "Toward paper" is a direction on the LADDER, not on the lightness axis:
   * `--background` sits above the canvas in light and below it in dark, so one
   * target produces the frosted reading in both and it is the sign of the
   * lightness step that flips, not the model. That is also why the sink target
   * is derived rather than declared — see `liftTarget` in elevation.ts.
   * Appendix § Lift: one mechanism, two signs.
   */
  lift: {
    /**
     * Alpha at lift 1, for the tier furthest from the canvas.
     *
     * Per-mode because the overlay composites in sRGB bytes, where the curve is
     * far steeper near black, so the same alpha buys much more lightness down
     * there. Dark's 0.5 is what brings its ΔL back inside the 0.070–0.119 band
     * light delivers across the same seeds. Appendix § Lift alphas.
     */
    liftAlpha: { light: 0.7, dark: 0.5 },
    /**
     * The sinking counterpart, smaller in both modes and by a wider margin in
     * dark — and, at the settled lift, the row DARK reads.
     *
     * Same asymmetry seen from the other end: sink walks toward whatever ink is
     * on the FAR side of the canvas from the paper, and both of those move
     * lightness faster than their lifting counterpart does. 0.12 against light's
     * 0.7 is what makes the two walks the same length (+0.022 and +0.023 on the
     * ember default). Appendix § Lift alphas.
     */
    sinkAlpha: { light: 0.3, dark: 0.12 },
    /**
     * Each on-canvas tier's share of that alpha, outward from the gradient: the
     * chrome band and the project rail first, the inner sidebar second.
     * Cumulative by construction — a tier's share is its DISTANCE from the
     * canvas, so the sidebar always separates from the rail as well as from the
     * gradient.
     *
     * The zero is the whole statement. The window insets the sidebar+card unit
     * and runs bare gradient all the way around it, so an outer tier with ANY
     * share would draw a hard edge along every wall of that frame — and that
     * edge is the sharp chrome the arrangement exists to remove. So the chrome
     * band and rail ARE the canvas, and the sidebar takes the entire alpha.
     * Appendix § The frame, and the three arrangements it beat.
     */
    shares: [0, 1],
  },

  /**
   * Elevation shadows — the blurred halo a raised surface casts.
   *
   * In BOTH modes, because a shadow works by removing luminance and this canvas
   * has some to remove even in dark (L 0.21–0.44 across the seeds, against the
   * app's own L 0.18 page, which is what the light-only argument was really
   * about).
   *
   * The color is the canvas's own hue at low lightness, never neutral black: a
   * neutral shadow over a warm pastel desaturates the pixels under it, which
   * reads as dirt on the canvas rather than as an absence of light. Both rungs
   * sit BELOW every canvas their mode can produce — reusing light's 0.32 in dark
   * would put the halo ABOVE a dim canvas and make it glow. Appendix § Shadow
   * rungs.
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
   * (`LIGHT_FLOORS` in `floors.ts`): a head, a section/label tier, and a mute.
   * The canvas needs its own copy because the card's is solved against `--card`
   * and this text does not sit on `--card` — but it needs the same SHAPE, or the
   * sidebar and the paper beside it would rank their copy differently and the
   * window would read as two design languages.
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
     * decision in this block: the ink sits at whichever end of the scale APCA's
     * curve is compressed at, so one perceptual step measures 3.7 Lc in light
     * and 21.3 in dark. Sliding gives one ladder that LOOKS the same in both
     * modes; solving to matched Lc drops would give two that measure the same
     * and look nothing alike. Lc still guards the bottom — see {@link mutedFloor}.
     *
     * Backwards against the weight, exactly like
     * `LIGHT_FLOORS.labelTowardSecondary`: turning copy weight UP means the
     * tiers move toward the full ink, which is a smaller slide rather than a
     * larger one. Appendix § The canvas ink ladder.
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
     * mode. It also inherits the clamp for free.
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
     * next. 48 is the floor that still leaves the hardest canvas in the sweep
     * 0.30 of slide to spend, and it sits above APCA's 45 for large or bold
     * text, which is the relevant line for an 11px meta row.
     *
     * Binding it is not a failure — it is the degradation. The ladder COMPRESSES
     * toward the head (see {@link maxReadableSlide}), so a canvas with no room
     * left shows two tiers or one rather than three unreadable ones, and no tier
     * can ever cross another on the way. Appendix § The canvas ink ladder.
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
 * arrives at `undefined`, and NaNs into `#NaNNaNNaN` — a blank window and no
 * error. Adding a fourth harmony row is now the only edit that raises it.
 */
export const MAX_STOPS = ARC_TUNING.harmony.length;

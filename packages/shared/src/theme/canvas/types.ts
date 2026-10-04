/**
 * What a user authors, and what the appearance resolves to — the two things
 * every other module in this directory is a function of.
 *
 * These are deliberately separate. A {@link Canvas} is a gradient; an
 * {@link Appearance} is light, dark, or follow-the-system. The lab kept the
 * two together (`ArcCanvasState.mode`) because one editor pane owned both, but
 * they are scoped independently in the app — a workspace can override the
 * canvas, the appearance, or either alone — and a type that carries both makes
 * that impossible to express. The per-mode dials in `settled.ts` exist exactly
 * so ONE canvas renders correctly in BOTH modes; a canvas that named a mode
 * would be claiming the opposite.
 */

/** One color pool: what it is, and where in the window it is anchored. */
export interface CanvasStop {
  /**
   * The AUTHORED color. The editor's orbs show this; the per-mode transform
   * that pulls it into a light band or a dark one never writes back to it, so
   * flipping appearance twice returns the exact hex the user picked.
   */
  hex: string;
  /** Anchor as a fraction of window width, 0 (left) to 1 (right). */
  x: number;
  /** Anchor as a fraction of window height, 0 (top) to 1 (bottom). */
  y: number;
}

/**
 * A canvas, as the user authors it — and only as the user authors it.
 *
 * Four fields, where the lab's editor had eleven. Six were dials that were
 * tuned and then settled, and now live in `ARC_SETTLED`; the seventh was
 * `mode`, which left for the reason in this module's docstring. What remains
 * is exactly what a Settings pane offers: the gradient, its saturation, and
 * its texture.
 */
export interface Canvas {
  /** One to `MAX_STOPS`, in the order they were added. */
  stops: CanvasStop[];
  /**
   * The dominant pool: bigger, later-fading, and the one every other color —
   * the token ladder included — is derived from.
   */
  primaryIndex: number;
  /** 0 = near-neutral wash, 1 = as saturated as the per-mode caps allow. */
  vibrancy: number;
  /** 0 = no noise layer at all. */
  grain: number;
}

/** What a user picks. `auto` follows the system. */
export type Appearance = "light" | "dark" | "auto";

/**
 * `auto` already answered — what the gradient transform, the token ladder and
 * the ink flip actually run against.
 *
 * Every function downstream of appearance takes this rather than
 * {@link Appearance}, so "did someone forget to resolve `auto`?" is a
 * compile-time question rather than a rendering bug.
 */
export type ResolvedAppearance = "light" | "dark";

/**
 * The first-paint HINT: the mode the renderer resolved to, and the canvas
 * background it painted.
 *
 * This is a cache, not an authority. `{canvas, appearance}` remains the only
 * authoritative pair — this row exists solely because main has to answer "what
 * color is this window's edge, and is it light or dark?" *synchronously, at
 * window construction*, before any renderer exists to ask. Whenever the two
 * disagree, the pair wins and this row is overwritten on the next paint.
 *
 * It is NOT a violation of "never persist the resolved token set" (`apply.ts`):
 * what is stored is one enum and one hex — the two values main physically
 * cannot derive without the renderer — not the 31-token ladder. Persisting the
 * ladder would let a stale copy of it out-vote the authored canvas, which is the
 * bug that rule is about; one background color cannot, because nothing reads it
 * after first paint.
 */
export interface FirstPaintHint {
  /** `auto` already resolved — main stamps this mode before the renderer boots. */
  appearance: ResolvedAppearance;
  /** The canvas background as a hex color; `BrowserWindow`'s `backgroundColor`. */
  background: string;
}

/** The chosen on-canvas foreground, the ladder under it, and the numbers that chose it. */
export interface CanvasInk {
  /** What text drawn directly on the canvas paints in. */
  ink: string;
  /** One step down: section headings and group labels. */
  inkLabel: string;
  /** The head ink pulled toward the base fill, for secondary rows. */
  inkMuted: string;
  /** APCA Lc of {@link ink} against the pool it reads WORST on. */
  worstLc: number;
  /** The tiers under it, on the same worst-case surface list. */
  labelLc: number;
  mutedLc: number;
  /** Both candidates' scores, so the editor can show how close the call was. */
  lightLc: number;
  darkLc: number;
}

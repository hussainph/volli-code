/**
 * The vivid canvas — one to three authored color pools in, and everything the
 * window needs to paint itself out: the gradient, the app token set the card is
 * built from, the on-canvas ink ladder, the lift overlays and the shadows.
 *
 * What this barrel exports is what a CONSUMER needs, which is deliberately
 * smaller than what the directory contains. The tuning tables, the settled dials,
 * the ink ranges and every internal helper stay unexported:
 * they are the argument behind the numbers, not an interface, and a table that
 * anything in the app could reach for would become one anything in the app could
 * disagree with. Tests import them by path.
 *
 * Three groups:
 *
 *  - **Paint** — `deriveCanvasTokens`, `deriveLabelInk`, `canvasBackground`,
 *    `canvasInk`, `canvasElevation`, `grainLayer`, `windowBackground`, and the
 *    shared contrast constraints the renderer completes (`readingBackings`,
 *    `focusRing`, `SECONDARY_FILL_ALPHA`). Order
 *    matters at one joint: elevation before ink, because a lifted tier is a new
 *    surface the on-canvas text sits on and can be the worst case the ink has to
 *    clear.
 *  - **Storage** — `parseCanvas`, `DEFAULT_CANVAS`, `resolveAppearance`.
 *  - **Editing** — the stop operations, plus the readout an editor needs to
 *    show its work (`effectiveStopHexes`).
 */

export * from "./types";
export { MAX_STOPS } from "./tuning";
export { isAppearance, resolveAppearance } from "./appearance";
export { DEFAULT_CANVAS, parseCanvas } from "./parse";
export { canvasBackground, effectiveStopHexes, grainLayer } from "./gradient";
export { addStop, moveStop, removeStop, withPrimaryHex, withPrimaryIndex } from "./edit";
export { canvasInk } from "./ink";
export {
  SECONDARY_FILL_ALPHA,
  readingInk,
  regularGlassBackdrop,
  regularGlassTone,
  writingGlass,
} from "./glass";
export {
  deriveCanvasTokens,
  deriveLabelInk,
  focusRing,
  readingBackings,
  deriveSettingsTokens,
  SETTINGS_ACCENT_CANVAS,
  SETTINGS_CANVAS,
  settingsWindowBackground,
  tintCanvasNeutral,
  windowBackground,
} from "./derive";
export {
  canvasElevation,
  type CanvasElevation,
  type CanvasLiftTier,
  type CanvasShadows,
} from "./elevation";

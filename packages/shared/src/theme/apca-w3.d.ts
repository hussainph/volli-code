/**
 * Ambient types for `apca-w3`, which ships untyped JavaScript.
 *
 * `apca-w3` is a **devDependency used only by color.test.ts**, as the second
 * implementation the APCA math is cross-verified against — the design doc is
 * explicit that the generator must never be verified against its own math.
 * Nothing under `src/*.ts` imports it, and this file declares types only, so
 * `@volli/shared` stays runtime-dependency-free.
 *
 * Only the two functions the test uses are declared; the package exports
 * more (reverseAPCA, fontLookupAPCA, the P3/AdobeRGB variants) and they can
 * be added here if a test ever needs them.
 */
declare module "apca-w3" {
  /** sRGB 8-bit triple → APCA screen luminance Y. */
  export function sRGBtoY(rgb: readonly [number, number, number]): number;

  /**
   * Signed Lc for text on background. Negative means light-on-dark; the
   * polarity is deliberate and must not be swapped.
   */
  export function APCAcontrast(textY: number, backgroundY: number): number;
  export function APCAcontrast(textY: number, backgroundY: number, places: number): number | string;
}

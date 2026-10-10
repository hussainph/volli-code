/** Reference-informed CSS study, not Apple's native material or calibrated optical model.
 * The OS appearance continuum is separate from SwiftUI's regular/clear variants.
 * Coefficients are authored research values; native side-by-side calibration is pending.
 */
import type { SurfaceValues } from "./model";

export const MACOS27_STOPS = [
  { key: "clear", label: "Clear", balance: 0 },
  { key: "balanced", label: "Balanced", balance: 0.5 },
  { key: "tinted", label: "Tinted", balance: 1 },
] as const;

export function resolveStudyValues(values: SurfaceValues): SurfaceValues {
  if (values.reference.treatment !== "macos27") return values;
  const balance = Math.min(1, Math.max(0, values.reference.balance));
  const active = values.reference.active;
  const mix = (from: number, to: number) => Number((from + (to - from) * balance).toFixed(4));
  // Continuous coordinated diffusion + transmission + neutral tint. The material
  // becomes more opaque, not the content. Source position/theme remain authored.
  return {
    ...values,
    lens: {
      material: "glass",
      opacity: mix(0.24, 0.9),
      blur: mix(6, 22),
      tint: mix(0.025, 0.1),
      // Reference CSS supplies fixed 1px catches, not the generic Aqua bevel.
      bevel: 0,
      sheen: active ? 0.1 : 0.045,
      lift: active ? 14 : 8,
      shadow: active ? 0.64 : 0.3,
      radius: 14,
    },
    workPane: {
      material: "matte",
      opacity: 1,
      blur: 0,
      tint: 0,
      lift: 0,
      shadow: 0,
      bevel: 0,
      sheen: 0,
      rim: 0,
      radius: 0,
    },
    lighting: { ...values.lighting, rim: active ? 0.6 : 0.26, thickness: 0.75 },
    controls: { crown: active ? 0.055 : 0.025, colour: 0.08 },
    opticalExperiment: { ...values.opticalExperiment, displacement: 0 },
  };
}

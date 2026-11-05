/** Canonical JS clocks are milliseconds. Only Motion's API receives seconds. */
const clocks = {
  menuIn: 160,
  menuOut: 110,
  sheet: 220,
  snappy: 225,
  peekIn: 170,
  peekOut: 110,
  pin: 270,
  pointerDrop: 240,
  tabCloseHold: 1000,
  disclosureIn: 200,
  disclosureOut: 160,
} as const;
export const GLASS_MOTION = {
  ...clocks,
  menuInSeconds: clocks.menuIn / 1000,
  menuOutSeconds: clocks.menuOut / 1000,
  sheetSeconds: clocks.sheet / 1000,
  snappySeconds: clocks.snappy / 1000,
  // The inspector page pill retains main's explicitly approved spring.
  inspectorSpringSeconds: 0.32,
  inspectorSpringBounce: 0.1,
  inspectorLabelSeconds: 0.14,
  inspectorHoverSeconds: 0.15,
  easeOut: [0.23, 1, 0.32, 1],
  linear: "linear",
  easeOutCss: "cubic-bezier(0.23, 1, 0.32, 1)",
} as const;

/** Optimizers serialize 380ms as .38s. A CSS time is never a bare JS number. */
export function cssTimeMs(value: string): number | null {
  const match = /^([0-9]*\.?[0-9]+)(ms|s)$/.exec(value.trim());
  if (!match) return null;
  const result = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  return Number.isFinite(result) ? result : null;
}

/** Finite normalized samples, not an assertion about Apple's private spring. */
export function springSamples(kind: "pin" | "drop"): readonly number[] {
  const omega = (2 * Math.PI) / 0.2;
  const zeta = kind === "pin" ? 1 : 0.8;
  const end = kind === "pin" ? 8.5 / omega : GLASS_MOTION.pointerDrop / 1000;
  const step = (time: number) =>
    zeta === 1
      ? 1 - (1 + omega * time) * Math.exp(-omega * time)
      : 1 -
        (Math.exp(-zeta * omega * time) / Math.sqrt(1 - zeta * zeta)) *
          Math.sin(omega * Math.sqrt(1 - zeta * zeta) * time + Math.acos(zeta));
  const terminal = step(end);
  return Array.from({ length: 65 }, (_, index) =>
    index === 64 ? 1 : step((end * index) / 64) / terminal,
  );
}
export function springEasing(kind: "pin" | "drop"): string {
  return `linear(${springSamples(kind)
    .map((value) => Number(value.toFixed(6)))
    .join(", ")})`;
}

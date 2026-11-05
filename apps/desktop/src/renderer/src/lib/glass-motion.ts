/** JS clocks for the Glass CSS recipes in globals.css (milliseconds unless named Seconds). */
export const GLASS_MOTION = {
  menuIn: 160,
  menuOut: 110,
  sheet: 220,
  menuInSeconds: 0.16,
  menuOutSeconds: 0.11,
  sheetSeconds: 0.22,
  snappySeconds: 0.24,
  // Inspector page pill: the main-floor spring, retained by explicit design.
  inspectorSpringSeconds: 0.32,
  inspectorSpringBounce: 0.1,
  inspectorLabelSeconds: 0.14,
  inspectorHoverSeconds: 0.15,
  easeOut: [0.23, 1, 0.32, 1],
  easeOutCss: "cubic-bezier(0.23, 1, 0.32, 1)",
} as const;

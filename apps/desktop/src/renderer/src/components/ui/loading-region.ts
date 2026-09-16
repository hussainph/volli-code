/**
 * The fixed accessibility contract for every async loading region (VC-383).
 *
 * Skeleton bars reserve visual geometry, but they do not say that the content
 * is delayed. These are props rather than a wrapper because each caller already
 * owns the meaningful list, column, or section element; adding a wrapper just
 * to repeat this contract would alter that element's layout and semantics.
 */
export function loadingRegionProps(label: string) {
  return {
    role: "status",
    "aria-label": `Loading ${label}`,
    "aria-busy": true,
  } as const;
}

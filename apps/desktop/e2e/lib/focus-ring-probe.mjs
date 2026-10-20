/** Sub-millipixel interpolation/serialization drift, not a thinner-ring allowance. */
const PIXEL_EPSILON = 0.001;
const near = (actual, expected) => Math.abs(actual - expected) <= PIXEL_EPSILON;

const pixelLength = (value) => {
  if (value === "0") return 0;
  return /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value) ? Number.parseFloat(value) : NaN;
};

/** The emitted ring is a zero-offset, zero-blur outer shadow, not any incidental `2px`. */
function hasSpread(shadow, expected) {
  const geometry = shadow
    .replace(/(?:rgba?|hsla?|oklab|oklch|lab|lch|color)\([^)]*\)|#[\da-f]{3,8}\b/gi, "")
    // The declared Tailwind ring retains calc(offset + width); the computed
    // box-shadow resolves that sum and may still be finishing its transition.
    .replace(
      /calc\(\s*([\d.]+)px\s*\+\s*([\d.]+)px\s*\)/g,
      (_, a, b) => `${Number(a) + Number(b)}px`,
    );
  return geometry.split(",").some((part) => {
    const lengths = part.trim().split(/\s+/).map(pixelLength);
    return (
      lengths.length === 4 &&
      lengths.slice(0, 3).every((length) => near(length, 0)) &&
      near(lengths[3], expected)
    );
  });
}

/** Focus and opacity stay mandatory; prove the actual 2px offset + 2px ring geometry. */
export function focusRingIsReady(focus) {
  return (
    focus.focusVisible &&
    focus.opacity === "1" &&
    near(pixelLength(focus.css.offsetWidth.trim()), 2) &&
    hasSpread(focus.css.boxShadow, 2) &&
    hasSpread(focus.css.boxShadow, 4) &&
    hasSpread(focus.css.ringShadow, 4)
  );
}

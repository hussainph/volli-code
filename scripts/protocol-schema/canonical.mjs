/** Keep generated union spelling stable across Zod versions; never alter assertions. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  // JSON Schema's type array is exactly the union of its individual types.
  // Keep the existing anyOf spelling so a generator upgrade is not mistaken
  // for a wire-contract change. Leave schemas with an existing anyOf alone.
  if (Array.isArray(value.type) && value.anyOf === undefined) {
    const { type: types, ...rest } = value;
    value = { ...rest, anyOf: types.map((type) => ({ type })) };
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, stable(value[key])]),
  );
}

/** Optimistic presentation snapshots merge only fields this renderer changed. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function patch(current: unknown, base: unknown, next: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(next)) return current;
  if (!record(base) || !record(next)) return next;
  const merged: Record<string, unknown> = record(current) ? { ...current } : {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (!Object.hasOwn(next, key)) {
      delete merged[key];
      continue;
    }
    const value = Object.hasOwn(base, key) ? patch(merged[key], base[key], next[key]) : next[key];
    // JSON keys are data, including __proto__; never invoke a prototype setter.
    Object.defineProperty(merged, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return merged;
}

export function mergePreferenceSnapshot(
  current: string | undefined,
  base: string | undefined,
  next: string,
): string {
  if (current === undefined || base === undefined || base === "" || next === "") return next;
  try {
    return JSON.stringify(patch(JSON.parse(current), JSON.parse(base), JSON.parse(next))) ?? next;
  } catch {
    // Preserve the existing string-store behavior for corrupt or legacy payloads.
    return next;
  }
}
export const isSharedPreferenceKey = (key: string): boolean =>
  key === "volli:ui" || key === "volli:style";

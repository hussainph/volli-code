/**
 * Milliseconds per named step of one database open (VC-1105), so an upgrade's
 * log line says where its time went: the integrity checks, the safety copy,
 * the migrations themselves, the post-migration ANALYZE and compaction, and
 * retention of older copies. A repeated step accumulates.
 */
export type UpgradeTimings = Record<string, number>;

/** Runs `step`, adding its wall time to `timings[name]` when timings are being kept. */
export function timeStep<T>(timings: UpgradeTimings | undefined, name: string, step: () => T): T {
  if (timings === undefined) return step();
  const started = performance.now();
  try {
    return step();
  } finally {
    timings[name] = (timings[name] ?? 0) + Math.round(performance.now() - started);
  }
}

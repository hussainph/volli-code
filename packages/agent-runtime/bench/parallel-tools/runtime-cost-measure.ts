/**
 * Batch timing for operations far too short to time one at a time.
 *
 * Every measured call here costs single-digit microseconds or less, which is
 * the same order as `performance.now()` itself. So nothing is timed alone: a
 * batch of `operationsPerSample` runs is timed and divided, and the batch size
 * is part of the published arm rather than an implementation detail — see
 * `RUNTIME_COST_ARMS`. p50 and p95 come from repeating that batch, and the
 * relative standard deviation is reported beside them so a reader can see when
 * a figure is too noisy to rank.
 */

import { performance } from "node:perf_hooks";

export interface TimingSummary {
  name: string;
  waiting: "user" | "background";
  fixture: string;
  operationsPerSample: number;
  samples: number;
  p50Us: number;
  p95Us: number;
  meanUs: number;
  standardDeviationUs: number;
  relativeStandardDeviation: number;
}

export interface MeasureSpec {
  name: string;
  waiting: TimingSummary["waiting"];
  fixture: string;
  operationsPerSample: number;
  samples: number;
  warmupSamples?: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function summarize(spec: MeasureSpec, elapsedUs: readonly number[]): TimingSummary {
  const sorted = elapsedUs.toSorted((left, right) => left - right);
  const meanUs = elapsedUs.reduce((total, value) => total + value, 0) / elapsedUs.length;
  const variance =
    elapsedUs.reduce((total, value) => total + (value - meanUs) ** 2, 0) / elapsedUs.length;
  const standardDeviationUs = Math.sqrt(variance);
  return {
    name: spec.name,
    waiting: spec.waiting,
    fixture: spec.fixture,
    operationsPerSample: spec.operationsPerSample,
    samples: spec.samples,
    p50Us: percentile(sorted, 0.5),
    p95Us: percentile(sorted, 0.95),
    meanUs,
    standardDeviationUs,
    relativeStandardDeviation: meanUs === 0 ? 0 : standardDeviationUs / meanUs,
  };
}

/**
 * Keeps a measured result observable so V8 cannot prove the calls dead and
 * delete the very work being timed. The comparison never holds, so nothing is
 * ever printed; what matters is that the optimizer cannot know that.
 */
function keepAlive(checksum: number): void {
  if (checksum === Number.MIN_SAFE_INTEGER) console.log(checksum);
}

/** Measure a synchronous operation in batches large enough to rise above timer noise. */
export function measureSync(spec: MeasureSpec, operation: () => number): TimingSummary {
  let checksum = 0;
  const run = (): number => {
    const startedAt = performance.now();
    for (let index = 0; index < spec.operationsPerSample; index += 1) checksum ^= operation();
    return ((performance.now() - startedAt) * 1_000) / spec.operationsPerSample;
  };
  for (let index = 0; index < (spec.warmupSamples ?? 3); index += 1) run();
  const elapsedUs = Array.from({ length: spec.samples }, run);
  keepAlive(checksum);
  return summarize(spec, elapsedUs);
}

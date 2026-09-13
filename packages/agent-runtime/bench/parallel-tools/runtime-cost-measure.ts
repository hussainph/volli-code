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
  // Keep results observable so V8 cannot prove the measured calls dead.
  if (checksum === Number.MIN_SAFE_INTEGER) console.log(checksum);
  return summarize(spec, elapsedUs);
}

/** Measure an async operation whose promise settlement is part of the path. */
export async function measureAsync(
  spec: MeasureSpec,
  operation: () => Promise<number>,
): Promise<TimingSummary> {
  let checksum = 0;
  const run = async (): Promise<number> => {
    const startedAt = performance.now();
    for (let index = 0; index < spec.operationsPerSample; index += 1) {
      checksum ^= await operation();
    }
    return ((performance.now() - startedAt) * 1_000) / spec.operationsPerSample;
  };
  for (let index = 0; index < (spec.warmupSamples ?? 3); index += 1) await run();
  const elapsedUs: number[] = [];
  for (let index = 0; index < spec.samples; index += 1) elapsedUs.push(await run());
  if (checksum === Number.MIN_SAFE_INTEGER) console.log(checksum);
  return summarize(spec, elapsedUs);
}

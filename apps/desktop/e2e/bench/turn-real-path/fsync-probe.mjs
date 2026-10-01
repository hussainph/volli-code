#!/usr/bin/env node
/**
 * VC-456's file-sync probe: how long one `FileHandle.sync()` takes on the
 * volume the bench's disposable profile lives on, one at a time and 40 at once.
 *
 * The transcript-artifact store syncs a file and its directory for every
 * artifact it publishes, so this is the unit that cost is made of. On macOS,
 * libuv implements `sync()` with `F_FULLFSYNC`.
 *
 * The runner starts it twice, under the default four-thread libuv pool and
 * under 64 threads. `parallelism` is the time the syncs take one after another
 * divided by the wall time of all of them at once: how many ran side by side.
 * If they only overlap as far as the pool lets them, 64 threads raise it far
 * above 4's. If they queue below the pool, at the device, 64 threads barely
 * move it. It prints one JSON object and touches nothing outside a fresh
 * temporary directory.
 */
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUNT = 40;
const directory = await mkdtemp(join(tmpdir(), "volli-vc456-fsync-"));
let sequence = 0;

async function once() {
  sequence += 1;
  const handle = await open(join(directory, `probe-${sequence}`), "wx", 0o600);
  try {
    await handle.writeFile("x".repeat(600));
    const startedAt = performance.now();
    await handle.sync();
    return performance.now() - startedAt;
  } finally {
    await handle.close();
  }
}

function percentile(values, q) {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}

const round = (value) => Number(value.toFixed(3));

try {
  const sequential = [];
  for (let index = 0; index < COUNT; index += 1) sequential.push(await once());
  const sequentialSyncMs = sequential.reduce((sum, value) => sum + value, 0);
  const concurrentStartedAt = performance.now();
  await Promise.all(Array.from({ length: COUNT }, () => once()));
  const concurrentWallMs = performance.now() - concurrentStartedAt;
  process.stdout.write(
    `${JSON.stringify({
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "4 (default)",
      count: COUNT,
      oneAtATimeP50Ms: round(percentile(sequential, 0.5)),
      oneAtATimeP95Ms: round(percentile(sequential, 0.95)),
      oneAtATimeSyncTotalMs: round(sequentialSyncMs),
      concurrentWallMs: round(concurrentWallMs),
      concurrentSyncsPerSecond: round((COUNT / concurrentWallMs) * 1_000),
      parallelism: round(sequentialSyncMs / concurrentWallMs),
    })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

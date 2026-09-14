import { parentPort, workerData } from "node:worker_threads";

// A fixed integer-mixing loop: no allocation, no I/O, no timer sleeps. One
// worker is one continuously busy scheduler thread; the parent names the arm
// `N-busy-core` and keeps N of these alive for its whole measurement run.
let value = (0x9e3779b9 ^ Number(workerData.index)) >>> 0;
let iterations = 0;
const readyAt = 1_000_000;
const reportEvery = 50_000_000;
for (;;) {
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  iterations += 1;
  if (iterations === readyAt) {
    // Ready means this worker has executed the actual load loop, not merely
    // that its module started. The parent can therefore synchronize without
    // treating a slow 50M-iteration progress report as a failed worker.
    parentPort?.postMessage({ ready: true, iterations, checksum: value }, []);
  } else if (iterations % reportEvery === 0) {
    parentPort?.postMessage({ iterations, checksum: value }, []);
  }
}

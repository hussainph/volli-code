import { parentPort, workerData } from "node:worker_threads";

// The parent writes one common monotonic deadline after every worker has
// warmed up. Zero means "warming", and -1 asks an early-stop path to exit.
const deadline = new BigInt64Array(workerData.deadlineBuffer);
let value = (0x9e3779b9 ^ Number(workerData.index)) >>> 0;
let iterations = 0;
const readyAt = 1_000_000;
const reportEvery = 50_000_000;
const checkEvery = 100_000;

for (;;) {
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  iterations += 1;

  if (iterations === readyAt) {
    parentPort?.postMessage({ ready: true, iterations, checksum: value }, []);
  } else if (iterations % reportEvery === 0) {
    parentPort?.postMessage({ iterations, checksum: value }, []);
  }

  if (iterations % checkEvery !== 0) continue;
  const target = Atomics.load(deadline, 0);
  if (target < 0n) {
    parentPort?.postMessage({ stopped: true, iterations, checksum: value }, []);
    break;
  }
  if (target > 0n && process.hrtime.bigint() >= target) {
    parentPort?.postMessage({ expired: true, iterations, checksum: value }, []);
    break;
  }
}

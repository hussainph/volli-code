import { parentPort, workerData } from "node:worker_threads";

await import("../../secrets/test-support/ts-hooks.mjs");
const { serveRestoreWorker } = await import("../restore-worker.ts");

// Test-only rendezvous: hold a real production checkpoint until the parent
// kills this worker, so a loaded CI host cannot race past the crash point.
const crash = workerData.crashAtCheckpoint;
if (crash && parentPort) {
  const word = new Int32Array(crash.word);
  const send = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (message, ...transfer) => {
    if (message.checkpoints === crash.at) {
      Atomics.store(word, 0, 1);
      send(message, ...transfer);
      Atomics.wait(word, 0, 1);
    } else send(message, ...transfer);
  };
}
serveRestoreWorker();

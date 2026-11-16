// A backup worker that asks main to hold its automatic checkpoint and never
// releases it (VC-1201). `appVersion` picks how it ends: "exit" dies at once,
// "wait" stays until main cancels it.
import { parentPort, workerData } from "node:worker_threads";

parentPort.on("message", (message) => {
  if (message.type === "checkpoints-held" && workerData.appVersion === "exit") process.exit(3);
  if (message.type === "cancel") process.exit(0);
});
// A worker thread's port, not a window: there is no target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage({ type: "hold-checkpoints" });

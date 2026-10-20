// A pre-handle worker's wire output: host-side byte emissions remain omitted.
import { parentPort } from "node:worker_threads";
parentPort.postMessage(
  {
    type: "output",
    item: { type: "image", data: "AAAA", mimeType: "image/png" },
  },
  [],
);
parentPort.postMessage({ type: "done", ok: true, value: undefined, writes: "[]" }, []);

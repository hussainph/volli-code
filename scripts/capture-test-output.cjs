// CI's bounded replacement for tee. Always drain stdin, including after a
// capture failure; never close the producer's pipe early or handle its signals.
const { createBoundedCapture } = require("./bounded-test-capture.cjs");
const { writeSync } = require("node:fs");

let append;
let warned = false;
function unavailable() {
  if (!warned) {
    try {
      writeSync(2, "[test-diagnostics] capture unavailable; input still drained.\n");
    } catch {
      // Failure to report an observer failure must not terminate the producer.
    }
  }
  warned = true;
  append = undefined;
}
try {
  append = createBoundedCapture(process.argv[2], {
    maxBytes: process.argv[3] === undefined ? 8 * 1024 * 1024 : Number(process.argv[3]),
    marker:
      "\n[test-diagnostics] CAPTURE TRUNCATED: bounded tail; older output omitted or in .previous.\n",
  });
} catch {
  unavailable();
}
let forward = true;
process.stdout.on("error", () => {
  forward = false;
  process.stdin.resume();
});
process.stdout.on("drain", () => process.stdin.resume());
process.stdin.on("data", (bytes) => {
  if (append) {
    try {
      append(bytes);
    } catch {
      unavailable();
    }
  }
  // Forward with backpressure, not an unbounded stdout buffer. If CI's console
  // closes, its EPIPE belongs to this sink: keep draining/capturing the input.
  if (forward && !process.stdout.write(bytes)) process.stdin.pause();
});
process.stdin.on("error", unavailable);

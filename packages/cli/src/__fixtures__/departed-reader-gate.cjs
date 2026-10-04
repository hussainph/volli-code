const { readFileSync } = require("node:fs");

// A --require preload runs before the CLI entrypoint, in the CLI's own process.
// The child's stdin descriptor is blocking: EOF arrives only after the parent
// has closed the doomed reader and sent the go-ahead. Do not touch either output
// stream or install an error handler here; the CLI must own its EPIPE and status.
if (readFileSync(0, "utf8") !== "go\n") {
  throw new Error("Departed-reader fixture did not receive its go-ahead");
}

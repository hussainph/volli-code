// Proves node-pty loads and runs a shell under THIS Node (VC-560): the load
// probe CI's `Test (packages)` lane runs after building node-pty for Node,
// before host-core's terminal supervisor tests drive real shells through it.
//
//   node packages/host-core/scripts/probe-node-pty.mjs
//
// Resolved from host-core, which declares node-pty, so it loads the build this
// package's tests will load. Exits non-zero, naming the failure, otherwise.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const where = require.resolve("node-pty");
const pty = require("node-pty");

const term = pty.spawn("/bin/sh", ["-c", "printf node-pty-ok"], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
let output = "";
term.onData((data) => {
  output += data;
});
term.onExit(({ exitCode }) => {
  if (exitCode !== 0 || !output.includes("node-pty-ok")) {
    console.error(
      `node-pty ran a shell but it answered ${JSON.stringify(output)} (exit ${exitCode})`,
    );
    process.exit(1);
  }
  console.log(
    `node-pty runs under Node ${process.versions.node} (ABI ${process.versions.modules}): ${where}`,
  );
});

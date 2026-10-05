#!/usr/bin/env node
/** Run from the unpacked artifact, with no checkout or system Node. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

const require = createRequire(import.meta.url);
const sandbox = new CodemodeSandbox({
  workerUrl: new URL(
    "./node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js",
    import.meta.url,
  ),
  wasm: loadQuickJSWasm(require.resolve("quickjs-wasi/quickjs.wasm")),
  tools: [{ name: "proof", execute: async ({ value }) => ({ doubled: value * 2 }) }],
  timeoutMs: 5_000,
});
try {
  const result = await sandbox.execute("return await tools.proof({ value: 21 });");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, { doubled: 42 });
  assert.equal(result.calls.length, 1);
  console.log("Code Mode artifact proof: shipped worker + QuickJS wasm execute a real host call");
} finally {
  await sandbox.close();
}

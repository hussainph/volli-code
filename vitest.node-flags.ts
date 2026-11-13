/**
 * Node flags for the vitest worker processes, spread into a test config beside
 * `SHARED_MACHINE_TEST_WORKERS` (VC-1209).
 *
 * Today the only flag is `--no-wasm-code-gc` on Node 24. Every Node 24 release
 * ships V8 13.6, in which WebAssembly import wrappers are shared across a
 * process's isolates, and V8's Wasm code GC can free a wrapper that another
 * thread is still adding to its `WasmCodeRefScope`. The scope then frees it a
 * second time and the process aborts with `Check failed: jit_page.has_value()`
 * (SIGTRAP), through `Runtime_TierUpWasmToJSWrapper` →
 * `WasmImportWrapperCache::Free` → `ThreadIsolation::UnregisterWasmAllocation`.
 * That is nodejs/node#66366, fixed in V8 by 9b8ca54d5a and 68210d500a. The
 * backport, nodejs/node#66376, is not in any 24.x release yet.
 *
 * In CI it killed a vitest fork in the middle of a shard: "Worker exited
 * unexpectedly" while every reported test passed. It hit desktop shards and
 * host-core shards on tests that start and stop worker threads. Every retained
 * native stack from those exits has the same frames 1–10, matching the upstream
 * report; `docs/development/ci.md` lists the evidence the shards keep.
 *
 * Without Wasm code GC, no wrapper is ever marked dying, so this race cannot
 * start. The report's own measurement went from 11 CHECKs and 5 SIGSEGVs to
 * none. What it costs: Wasm code stays allocated until its module dies, which
 * for one test file's fork is nothing that matters.
 *
 * Decided by major version, because V8's version is what carries the bug.
 * Node 22 predates per-process wrappers and Node 26 has the fix, so neither
 * gets the flag. Remove it once `.nvmrc` names a Node 24 release with
 * nodejs/node#66376, or leaves 24.
 */

/** The flags a vitest worker on this Node takes. */
export function testWorkerExecArgv(nodeVersion: string = process.versions.node): string[] {
  return nodeVersion.split(".")[0] === "24" ? ["--no-wasm-code-gc"] : [];
}

/** Spread into a vitest `test` block, or into a project that does not extend one. */
export const TEST_WORKER_NODE_FLAGS = { execArgv: testWorkerExecArgv() } as const;

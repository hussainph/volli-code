/**
 * `--no-wasm-code-gc`: the one workaround for nodejs/node#66366, shared by
 * every Node 24 process Volli runs that starts worker threads with
 * WebAssembly in them (VC-1209, VC-1218).
 *
 * Every Node 24 release ships V8 13.6, in which WebAssembly import wrappers
 * are shared across a process's isolates (V8 a5999be590), and V8's Wasm code
 * GC can free a wrapper that another thread is still adding to its
 * `WasmCodeRefScope`. The scope then frees it a second time and the process
 * aborts with `Check failed: jit_page.has_value()` (SIGTRAP) or a SIGSEGV,
 * through `Runtime_TierUpWasmToJSWrapper` → `WasmImportWrapperCache::Free` →
 * `ThreadIsolation::UnregisterWasmAllocation`. V8 fixed it in 9b8ca54d5a
 * (with 68210d500a), which is in V8 13.7 and later but on no 13.6 branch; the
 * Node 24 backport is nodejs/node#66376. Electron's V8 already has the fix.
 *
 * It needs Wasm calling JS imports on worker threads that start and stop:
 * - vitest forks (`vitest.node-flags.ts`): workers loading `.ts` through
 *   Node's type stripping, whose amaro transformer is Wasm;
 * - the packaged `volli-runner` and `volli-hostd` launchers
 *   (`apps/{runner,hostd}/scripts/package.mjs`): Code Mode starts one worker
 *   with a QuickJS Wasm instance per program and terminates it afterwards.
 *
 * Without Wasm code GC, no wrapper is ever marked dying, so the race cannot
 * start. V8 still frees a whole module once nothing references it; what it
 * keeps is code replaced inside a live module and dead import wrappers, both
 * bounded. 1,500 Code Mode runs held RSS flat with the flag.
 *
 * Remove when the packaged Node's V8 contains 9b8ca54d5a: a Node 24 release
 * with nodejs/node#66376, or Node 26 (V8 14.6).
 */
export const NO_WASM_CODE_GC = "--no-wasm-code-gc";

/**
 * Where Code Mode's sandbox lives on disk, for a host that runs this package
 * bundled (VC-471).
 *
 * The sandbox starts a worker thread from a file beside its own module and
 * compiles QuickJS from the `quickjs-wasi` package. Bundled into Electron
 * main, neither path resolves from the bundle, so the host names them. This
 * answers both from any directory whose `node_modules` holds the sandbox
 * package, without importing anything: the worker file is the sandbox
 * package's published `dist/runtime/worker.js`, and the WebAssembly is
 * resolved from it exactly as the sandbox resolves it itself.
 *
 * The desktop app passes an installed copy of this package in an unpackaged
 * build (the workspace's own), and the app's `app.asar.unpacked` directory in
 * a packaged one, where electron-builder ships both packages outside the
 * archive (packages/host-core/src/codemode/sandbox-assets.ts).
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodeModeSandboxAssets } from "./tool";

export function codeModeSandboxAssetsFrom(agentRuntimeDirectory: string): CodeModeSandboxAssets {
  const sandbox = realpathSync(
    join(agentRuntimeDirectory, "node_modules", "@earendil-works", "pi-codemode"),
  );
  const worker = join(sandbox, "dist", "runtime", "worker.js");
  return {
    workerUrl: pathToFileURL(worker),
    wasmPath: createRequire(worker).resolve("quickjs-wasi/quickjs.wasm"),
  };
}

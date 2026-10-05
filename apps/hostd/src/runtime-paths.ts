/** The packaged host names executable sandbox assets; bundling cannot relocate a worker. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeModeSandboxAssetsFrom } from "@volli/agent-runtime";
import type { HeadlessRuntimeOptions } from "./session-runtime";

export function headlessRuntimePaths(
  bundleDir: string,
  socketPath: string,
): HeadlessRuntimeOptions {
  const assets = codeModeSandboxAssetsFrom(resolve(bundleDir, ".."));
  if (
    assets.workerUrl === undefined ||
    assets.wasmPath === undefined ||
    !existsSync(fileURLToPath(assets.workerUrl)) ||
    !existsSync(assets.wasmPath)
  ) {
    throw new Error("The hostd artifact is missing Code Mode's worker or quickjs.wasm.");
  }
  return {
    binDir: resolve(bundleDir, "../../bin"),
    venue: { id: socketPath, kind: "remote" },
    codeModeSandbox: assets,
  };
}

/**
 * Where a running hostd finds what its Sessions need, from the directory its
 * bundle runs in. The packaged host names executable sandbox assets; bundling
 * cannot relocate a worker.
 *
 * Two layouts, told apart by what sits above the bundle (VC-563):
 *
 * - **The artifact**: `<root>/lib/hostd/hostd.cjs`. Code Mode's worker and wasm
 *   are copied into `lib/node_modules`, and `<root>/bin` holds the shipped
 *   Node and `volli` launcher.
 * - **A source boot**: the workspace's `apps/hostd/dist/hostd.cjs`, after
 *   `pnpm --filter @volli/hostd --filter @volli/cli run build`. The sandbox is
 *   the workspace's installed `@volli/agent-runtime` (as desktop's unpackaged
 *   build finds it), and `apps/hostd/dev-bin` holds a `volli` launcher for the
 *   workspace's CLI bundle.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeModeSandboxAssetsFrom } from "@volli/agent-runtime";
import type { HeadlessRuntimeOptions } from "./session-runtime";

/** True when `bundleDir` is this package's own build output inside the workspace. */
function isWorkspaceBuild(bundleDir: string): boolean {
  const manifest = resolve(bundleDir, "../package.json");
  if (!existsSync(manifest)) return false;
  return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === "@volli/hostd";
}

export function headlessRuntimePaths(
  bundleDir: string,
  socketPath: string,
): HeadlessRuntimeOptions {
  const source = isWorkspaceBuild(bundleDir);
  const assets = codeModeSandboxAssetsFrom(
    source ? resolve(bundleDir, "../node_modules/@volli/agent-runtime") : resolve(bundleDir, ".."),
  );
  if (
    assets.workerUrl === undefined ||
    assets.wasmPath === undefined ||
    !existsSync(fileURLToPath(assets.workerUrl)) ||
    !existsSync(assets.wasmPath)
  ) {
    throw new Error(
      source
        ? "This workspace build is missing Code Mode's worker or quickjs.wasm; run pnpm install."
        : "The hostd artifact is missing Code Mode's worker or quickjs.wasm.",
    );
  }
  return {
    binDir: source ? resolve(bundleDir, "../dev-bin") : resolve(bundleDir, "../../bin"),
    venue: { id: socketPath, kind: "remote" },
    codeModeSandbox: assets,
  };
}

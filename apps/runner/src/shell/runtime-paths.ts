/**
 * Where a running runner finds what its Sessions need, from the directory its
 * bundle runs in. The packaged runner names executable sandbox assets;
 * bundling cannot relocate a worker. Copied from hostd's `runtime-paths.ts`.
 *
 * Two layouts, told apart by what sits above the bundle:
 *
 * - **The artifact**: `<root>/lib/runner/runner.cjs`. Code Mode's worker and
 *   wasm are copied into `lib/node_modules`, and `<root>/bin` holds the
 *   shipped Node and `volli` launcher.
 * - **A source boot**: the workspace's `apps/runner/dist/runner.cjs`, after
 *   `pnpm --filter @volli/runner --filter @volli/cli run build`. The sandbox
 *   is the workspace's installed `@volli/agent-runtime`, and
 *   `apps/runner/dev-bin` holds a `volli` launcher for the workspace's CLI
 *   bundle.
 *
 * Receiving wiring: `volli-runner run` hands these to the headless Session
 * composition.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeModeSandboxAssetsFrom, type CodeModeSandboxAssets } from "@volli/agent-runtime";

export interface RunnerRuntimePaths {
  /** First on every Session's PATH: the `volli` CLI (and, packaged, Node). */
  readonly binDir: string;
  readonly codeModeSandbox: CodeModeSandboxAssets;
}

/** True when `bundleDir` is this package's own build output inside the workspace. */
function isWorkspaceBuild(bundleDir: string): boolean {
  const manifest = resolve(bundleDir, "../package.json");
  if (!existsSync(manifest)) return false;
  return (
    (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === "@volli/runner"
  );
}

export function runnerRuntimePaths(bundleDir: string): RunnerRuntimePaths {
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
        : "The runner artifact is missing Code Mode's worker or quickjs.wasm.",
    );
  }
  return {
    binDir: source ? resolve(bundleDir, "../dev-bin") : resolve(bundleDir, "../../bin"),
    codeModeSandbox: assets,
  };
}

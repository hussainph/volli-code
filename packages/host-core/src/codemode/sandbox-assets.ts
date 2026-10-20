/**
 * Where Code Mode's sandbox finds its worker and its WebAssembly (VC-471), in
 * an unpackaged build and in the packaged app alike.
 *
 * Each run starts a worker thread from `@earendil-works/pi-codemode`'s own
 * `dist/runtime/worker.js` and compiles QuickJS from `quickjs-wasi`'s
 * `quickjs.wasm`. Bundled into `dist-electron/main.cjs`, the sandbox's host
 * half finds neither beside itself, so main names both — from a directory
 * whose `node_modules` holds the sandbox package, through
 * `codeModeSandboxAssetsFrom`, which resolves the WebAssembly from the worker
 * the way the worker's own `import "quickjs-wasi"` resolves its JavaScript:
 *
 * - **Unpackaged** (`pnpm dev`, `pnpm start`): the workspace's installed
 *   `@volli/agent-runtime`, reached through the app directory — the copy the
 *   bundle was built from.
 * - **Packaged**: `<resources>/app.asar.unpacked`. electron-builder.yml ships
 *   pi-codemode and quickjs-wasi in the app's `node_modules` and unpacks both
 *   beside the archive, because a worker's ES module loader and that bare
 *   import walk the real filesystem, which `app.asar` is not. Nothing here
 *   asks Node to resolve a package inside the archive, so no `app.asar` ->
 *   `app.asar.unpacked` rewrite is involved (compare `unpackedBinaryPath` in
 *   `packages/host-core/src/file-search.ts`).
 *
 * Answered whether or not any Session has Code Mode, so a Session born with it
 * keeps a working sandbox. When the files are not there it logs why and
 * answers nothing; a Session that reaches Code Mode then gets a failed run
 * (`error: "sandbox"`) rather than a crashed main process.
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codeModeSandboxAssetsFrom, type CodeModeSandboxAssets } from "@volli/agent-runtime";

export interface CodeModeSandboxLocation {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `app.getAppPath()`; read only by an unpackaged build. */
  appPath: () => string;
  /** `process.resourcesPath`; read only by a packaged build. */
  resourcesPath: () => string;
  log: (message: string) => void;
}

/** The directory whose `node_modules` holds this build's copy of the sandbox. */
function sandboxPackageRoot(location: CodeModeSandboxLocation): string {
  return location.packaged
    ? join(location.resourcesPath(), "app.asar.unpacked")
    : join(location.appPath(), "node_modules", "@volli", "agent-runtime");
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && !isAbsolute(path) && path.split(sep)[0] !== "..";
}

/** Why `assets` cannot run a sandbox, or nothing when they can. */
function problemWith(
  assets: CodeModeSandboxAssets,
  location: CodeModeSandboxLocation,
  root: string,
): string | undefined {
  const files = [
    assets.workerUrl === undefined ? undefined : fileURLToPath(assets.workerUrl),
    assets.wasmPath,
  ];
  for (const file of files) {
    if (file === undefined) return "a sandbox file was not named";
    if (!existsSync(file)) return `${file} does not exist`;
    // CommonJS resolution falls back to NODE_PATH and the global folders; the
    // worker's ES module import never does. A packaged sandbox whose
    // WebAssembly was found that way would load a QuickJS its worker cannot.
    if (location.packaged && !isInside(realpathSync(root), file)) {
      return `${file} is not in the unpacked app, where the sandbox's worker resolves its imports`;
    }
  }
  return undefined;
}

export function codeModeSandboxAssets(location: CodeModeSandboxLocation): {
  codeModeSandbox?: CodeModeSandboxAssets;
} {
  const build = location.packaged ? "packaged" : "unpackaged";
  let root: string | undefined;
  let reason: string;
  try {
    root = sandboxPackageRoot(location);
    const assets = codeModeSandboxAssetsFrom(root);
    const problem = problemWith(assets, location, root);
    if (problem === undefined) return { codeModeSandbox: assets };
    reason = problem;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  location.log(
    `Code Mode's sandbox could not be located in this ${build} build${root === undefined ? "" : ` (looked under ${root})`}: ${reason}`,
  );
  return {};
}

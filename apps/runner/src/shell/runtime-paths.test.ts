import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { CodeModeSandboxAssets } from "@volli/agent-runtime";

const assets = vi.hoisted(() => vi.fn<() => CodeModeSandboxAssets>());
vi.mock("@volli/agent-runtime", () => ({ codeModeSandboxAssetsFrom: assets }));
import { runnerRuntimePaths } from "./runtime-paths";
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-assets-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it("requires executable worker/wasm assets and resolves the bundled CLI", () => {
  const worker = pathToFileURL(join(root, "worker.js"));
  const wasmPath = join(root, "quickjs.wasm");
  for (const missing of [{}, { workerUrl: worker }, { workerUrl: worker, wasmPath }]) {
    assets.mockReturnValue(missing);
    expect(() => runnerRuntimePaths(join(root, "runner"))).toThrow("missing Code Mode");
  }
  writeFileSync(worker, "");
  expect(() => runnerRuntimePaths(join(root, "runner"))).toThrow("missing Code Mode");
  writeFileSync(wasmPath, "");
  expect(runnerRuntimePaths(join(root, "runner"))).toEqual({
    binDir: resolve(root, "../bin"),
    codeModeSandbox: { workerUrl: worker, wasmPath },
  });
  expect(assets).toHaveBeenLastCalledWith(root);
});
it("boots from the workspace build with the installed sandbox and the dev launcher", () => {
  const worker = pathToFileURL(join(root, "worker.js"));
  const wasmPath = join(root, "quickjs.wasm");
  writeFileSync(worker, "");
  writeFileSync(wasmPath, "");
  assets.mockReturnValue({ workerUrl: worker, wasmPath });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@volli/runner" }));
  expect(runnerRuntimePaths(join(root, "dist"))).toEqual({
    binDir: join(root, "dev-bin"),
    codeModeSandbox: { workerUrl: worker, wasmPath },
  });
  expect(assets).toHaveBeenLastCalledWith(join(root, "node_modules/@volli/agent-runtime"));
  assets.mockReturnValue({});
  expect(() => runnerRuntimePaths(join(root, "dist"))).toThrow("run pnpm install");
  // Another package's manifest above the bundle is not this workspace build.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "elsewhere" }));
  assets.mockReturnValue({ workerUrl: worker, wasmPath });
  expect(runnerRuntimePaths(join(root, "dist")).binDir).toBe(resolve(root, "../bin"));
});

it("ships a dev launcher for the workspace CLI bundle", () => {
  const launcher = openSync(resolve(import.meta.dirname, "../../dev-bin/volli"), "r");
  try {
    expect(fstatSync(launcher).mode & 0o111).toBe(0o111);
    expect(readFileSync(launcher, "utf8")).toContain("packages/cli/dist/volli.cjs");
  } finally {
    closeSync(launcher);
  }
});

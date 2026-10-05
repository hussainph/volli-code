import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { CodeModeSandboxAssets } from "@volli/agent-runtime";

const assets = vi.hoisted(() => vi.fn<() => CodeModeSandboxAssets>());
vi.mock("@volli/agent-runtime", () => ({ codeModeSandboxAssetsFrom: assets }));
import { headlessRuntimePaths } from "./runtime-paths";
const root = mkdtempSync(join(tmpdir(), "hostd-assets-"));
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it("requires executable worker/wasm assets and resolves the bundled CLI and venue", () => {
  const worker = pathToFileURL(join(root, "worker.js"));
  const wasmPath = join(root, "quickjs.wasm");
  for (const missing of [{}, { workerUrl: worker }, { workerUrl: worker, wasmPath }]) {
    assets.mockReturnValue(missing);
    expect(() => headlessRuntimePaths(join(root, "hostd"), "/socket")).toThrow("missing Code Mode");
  }
  writeFileSync(worker, "");
  expect(() => headlessRuntimePaths(join(root, "hostd"), "/socket")).toThrow("missing Code Mode");
  writeFileSync(wasmPath, "");
  expect(headlessRuntimePaths(join(root, "hostd"), "/socket")).toEqual({
    binDir: resolve(root, "../bin"),
    venue: { id: "/socket", kind: "remote" },
    codeModeSandbox: { workerUrl: worker, wasmPath },
  });
  expect(assets).toHaveBeenLastCalledWith(root);
});

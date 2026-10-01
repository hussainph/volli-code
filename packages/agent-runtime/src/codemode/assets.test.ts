import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { codeModeSandboxAssetsFrom } from "./assets";
import { CodeModeJournal } from "./journal";
import { createCodeModeTool } from "./tool";
import { DEFAULT_CODE_MODE_LIMITS } from "@volli/shared";

describe("codeModeSandboxAssetsFrom", () => {
  it("finds the worker and the WebAssembly from an installed copy of this package, and they run", async () => {
    const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));
    const assets = codeModeSandboxAssetsFrom(packageDirectory);
    expect(existsSync(fileURLToPath(assets.workerUrl as URL))).toBe(true);
    expect(assets.wasmPath).toMatch(/quickjs\.wasm$/u);
    const tool = createCodeModeTool({
      surface: { routes: {}, limits: DEFAULT_CODE_MODE_LIMITS },
      tools: [],
      gate: () => undefined,
      observe: async () => undefined,
      journal: new CodeModeJournal(),
      sandbox: assets,
    });
    const result = await tool.execute("x", { code: "return 6 * 7;" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Returned: 42") });
  });
});

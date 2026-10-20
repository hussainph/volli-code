import { describe, expect, it, vi } from "vite-plus/test";
import { codeModeRefreshGate } from "./tool-refresh-gate";

const identity = { projectId: "project", parentId: null };
const request = {
  trigger: "code-mode",
  model: { providerId: "fixture", modelId: "first", reasoningLevel: "off" },
} as const;
describe("per-program refresh revision gate", () => {
  it("avoids full checks, returns the same desired context for failed-adoption retries and invalidates every relevant input", async () => {
    let revision = "mcp0/policy0/parent0";
    const read = vi.fn(async () => revision);
    const gate = codeModeRefreshGate<object>({ revision: read });
    const context = {};
    const refresh = vi.fn(async (remember: (value: typeof identity) => Promise<void>) => {
      await remember(identity);
      return context;
    });
    expect(await gate.check("s", request, refresh)).toBe(context);
    for (let i = 0; i < 100; i++) expect(await gate.check("s", request, refresh)).toBe(context);
    expect(refresh).toHaveBeenCalledOnce();
    for (const change of ["mcp1/policy0/parent0", "mcp1/policy1/parent0", "mcp1/policy1/parent1"]) {
      revision = change;
      await gate.check("s", request, refresh);
    }
    await gate.check("s", { ...request, model: { ...request.model, modelId: "second" } }, refresh);
    for (const trigger of ["warm-turn", "cold-turn", "compaction", "model-switch"] as const)
      await gate.check("s", { ...request, trigger }, refresh);
    expect(refresh).toHaveBeenCalledTimes(9);
    gate.forget("s");
    await gate.check("s", request, refresh);
    expect(refresh).toHaveBeenCalledTimes(10);
  });
  it("never memoizes failed or absent checks, and rechecks a revision changed during a check", async () => {
    let revision = "0";
    const gate = codeModeRefreshGate<object>({ revision: async () => revision });
    const context = {};
    await expect(
      gate.check("s", request, async (remember) => {
        await remember(identity);
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(await gate.check("s", request, async () => null)).toBeNull();
    expect(await gate.check("s", request, async () => context)).toBe(context);
    const refresh = vi.fn(async (remember: (value: typeof identity) => Promise<void>) => {
      await remember(identity);
      revision = "1";
      return context;
    });
    await gate.check("s", request, refresh);
    await gate.check("s", request, refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

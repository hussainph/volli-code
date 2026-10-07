import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
} from "@volli/shared";
import { hostModelAccessClient } from "./host-model-access-client";
import { relayHostScope } from "./relay-host-scope";
vi.mock("./relay-host-scope", () => ({ relayHostScope: vi.fn() }));

function fixture() {
  const answers: Record<string, unknown> = {
    inspect: { observedAt: 1, providers: [], models: [] },
    defaults: EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: [],
    compactionPolicy: DEFAULT_COMPACTION_POLICY,
    codeModePolicy: DEFAULT_CODE_MODE_POLICY,
    pickerView: "all",
  };
  const query = vi.fn(
    async (path: string, _input?: unknown, _options?: unknown) => answers[path.split(".")[1]!],
  );
  const mutate = vi.fn(async (path: string, input: unknown, _options?: unknown) =>
    path === "hostModels.setDefault" ? EMPTY_MODEL_ACCESS_DEFAULTS : input,
  );
  vi.mocked(relayHostScope).mockImplementation((hostId) => ({
    hostId,
    query,
    mutate,
    subscribe: vi.fn(),
    getState: () => ({ status: "open" }),
    subscribeState: () => () => {},
  }));
  return { client: hostModelAccessClient("box-a"), query, mutate, answers };
}

describe("host Model Access client", () => {
  it("routes every preference to hostModels over the HOST relay, not local IPC", async () => {
    const { client, query, mutate, answers } = fixture();
    expect(relayHostScope).toHaveBeenCalledWith("box-a");
    expect(await client.inspect({ refresh: true })).toEqual(answers.inspect);
    expect(await client.defaults()).toEqual(answers.defaults);
    expect(await client.hiddenModels()).toEqual([]);
    expect(await client.compactionPolicy()).toEqual(answers.compactionPolicy);
    expect(await client.codeModePolicy()).toEqual(answers.codeModePolicy);
    expect(await client.pickerView()).toBe("all");
    const selection = { providerId: "azure", modelId: "gpt", reasoningLevel: "off" } as const;
    expect(await client.setDefault("global", selection)).toEqual(EMPTY_MODEL_ACCESS_DEFAULTS);
    await client.setHiddenModels([{ providerId: "azure", modelId: "gpt" }]);
    await client.setCompactionPolicy({ autoCompaction: false });
    await client.setCodeModePolicy({ enabled: false, models: {} });
    await client.setPickerView("defaults");
    expect(query.mock.calls.map(([path, input]) => [path, input])).toEqual([
      ["hostModels.inspect", { refresh: true }],
      ["hostModels.defaults", undefined],
      ["hostModels.hiddenModels", undefined],
      ["hostModels.compactionPolicy", undefined],
      ["hostModels.codeModePolicy", undefined],
      ["hostModels.pickerView", undefined],
    ]);
    expect(mutate.mock.calls).toEqual([
      ["hostModels.setDefault", { purpose: "global", selection }, {}],
      ["hostModels.setHiddenModels", [{ providerId: "azure", modelId: "gpt" }], {}],
      ["hostModels.setCompactionPolicy", { autoCompaction: false }, {}],
      ["hostModels.setCodeModePolicy", { enabled: false, models: {} }, {}],
      ["hostModels.setPickerView", "defaults", {}],
    ]);
  });

  it("preserves refusals and cannot manage accounts through local Model Access", async () => {
    const { client, query, mutate } = fixture();
    query.mockRejectedValueOnce(new Error("host refused"));
    await expect(client.defaults()).rejects.toThrow("host refused");
    await expect(client.beginSignIn("azure", "api-key", vi.fn())).rejects.toThrow(
      "Use Sign-ins on the host",
    );
    await expect(client.signOut("azure")).rejects.toThrow("Use Sign-ins on the host");
    expect(mutate).not.toHaveBeenCalled();
  });
});

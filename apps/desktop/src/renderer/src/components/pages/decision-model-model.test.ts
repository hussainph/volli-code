import type { DecisionModelCatalogEntry, DecisionModelSetting } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  catalogEntry,
  catalogGroups,
  cloudLabel,
  cloudOptionKey,
  cloudSetting,
  cloudStatus,
  decisionMode,
  DEFAULT_LOCAL_DECISION_MODEL_ID,
  entryForKey,
  localSetting,
  priceLabel,
  settingLabel,
} from "./decision-model-model";

function entry(overrides: Partial<DecisionModelCatalogEntry> = {}): DecisionModelCatalogEntry {
  return {
    providerId: "typesafe",
    providerLabel: "TypeSafe",
    modelId: "jev-latest",
    label: "Jev",
    state: "available",
    inputUsdPerMillion: 0,
    contextWindow: 64_000,
    ...overrides,
  };
}

const JEV = entry();
const ZEN = entry({
  providerId: "opencode",
  providerLabel: "OpenCode Zen",
  modelId: "jev-1.13",
  label: "Jev 1.13",
  state: "needs-setup",
  inputUsdPerMillion: 0.042,
});
const ZEN_FREE = { ...ZEN, modelId: "jev-1.13-free", label: "Jev 1.13 Free" };
const CATALOG = [ZEN, JEV, ZEN_FREE];

describe("the decision model control's model", () => {
  it("reads a setting's mode", () => {
    expect(decisionMode({ kind: "none" })).toBe("none");
    expect(decisionMode(localSetting("", ""))).toBe("local");
    expect(decisionMode(cloudSetting(JEV, 1))).toBe("cloud");
  });

  it("names a cloud model by the pair, never its label alone", () => {
    expect(cloudOptionKey(JEV)).toBe('["typesafe","jev-latest"]');
    expect(entryForKey(CATALOG, cloudOptionKey(ZEN))).toBe(ZEN);
    expect(entryForKey(CATALOG, "nope")).toBeNull();
    expect(catalogEntry(CATALOG, { providerId: "typesafe", modelId: "jev-latest" })).toBe(JEV);
    expect(catalogEntry(CATALOG, { providerId: "typesafe", modelId: "gone" })).toBeNull();
    expect(cloudLabel(ZEN)).toBe("Jev 1.13 · OpenCode Zen");
  });

  it("groups the catalog by provider, signed-in providers first", () => {
    expect(
      catalogGroups(CATALOG).map((group) => [
        group.providerLabel,
        group.ready,
        group.entries.map((one) => one.label),
      ]),
    ).toEqual([
      ["TypeSafe", true, ["Jev"]],
      ["OpenCode Zen", false, ["Jev 1.13", "Jev 1.13 Free"]],
    ]);
    expect(
      catalogGroups([
        ZEN,
        entry({ providerId: "a", providerLabel: "Alpha", state: "needs-setup" }),
      ]).map((group) => group.providerLabel),
    ).toEqual(["Alpha", "OpenCode Zen"]);
  });

  it("writes a cloud choice with an opt-in for every purpose this build has", () => {
    expect(cloudSetting(ZEN, 42)).toEqual({
      kind: "cloud",
      providerId: "opencode",
      modelId: "jev-1.13",
      optIn: { acceptedAt: 42, purposes: ["agent.classify"] },
    });
  });

  it("fills a local choice's blanks with the zero-configuration defaults", () => {
    expect(localSetting("  ", "")).toEqual({
      kind: "local",
      server: "llama-cpp",
      baseUrl: "http://127.0.0.1:8080",
      modelId: DEFAULT_LOCAL_DECISION_MODEL_ID,
    });
    expect(localSetting(" http://localhost:9000 ", " qwen3-4b ")).toMatchObject({
      baseUrl: "http://localhost:9000",
      modelId: "qwen3-4b",
    });
  });

  it("labels every kind of setting", () => {
    expect(settingLabel({ kind: "none" }, CATALOG)).toBe("None");
    expect(settingLabel(localSetting("", ""), CATALOG)).toBe("Local server");
    expect(settingLabel(localSetting("", "qwen3-4b"), CATALOG)).toBe("Local server · qwen3-4b");
    expect(settingLabel(cloudSetting(JEV, 1), CATALOG)).toBe("Jev · TypeSafe");
    expect(settingLabel(cloudSetting({ providerId: "gone", modelId: "old" }, 1), CATALOG)).toBe(
      "old · gone",
    );
  });

  it("says where a cloud model stands", () => {
    const cloud = (ref: DecisionModelCatalogEntry | { providerId: string; modelId: string }) =>
      cloudSetting(ref, 1) as Extract<DecisionModelSetting, { kind: "cloud" }>;
    expect(cloudStatus(cloud(JEV), CATALOG)).toEqual({ kind: "ready", entry: JEV });
    expect(cloudStatus(cloud(ZEN), CATALOG)).toEqual({ kind: "needs-setup", entry: ZEN });
    expect(cloudStatus(cloud({ providerId: "x", modelId: "y" }), CATALOG)).toEqual({
      kind: "missing",
    });
  });

  it("prices a model as a person reads it", () => {
    expect(priceLabel(JEV)).toBe("Free");
    expect(priceLabel(ZEN)).toBe("$0.042/M input");
  });
});

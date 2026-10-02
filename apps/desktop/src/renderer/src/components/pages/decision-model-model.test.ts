import type { DecisionModelCatalogEntry, DecisionModelSetting } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTHORITY_REASON_SOURCE_KEY,
  AUTHORITY_REASON_SOURCES,
  authorityReasonSource,
  authorityOptInExtensionKey,
  autoPickOn,
  autoPickSetting,
  catalogEntry,
  catalogGroups,
  cloudLabel,
  cloudOptionKey,
  cloudSetting,
  cloudStatus,
  decisionMode,
  DEFAULT_LOCAL_DECISION_MODEL_ID,
  entryForKey,
  extendAuthorityCloudOptIn,
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

function cloud(ref: { providerId: string; modelId: string }) {
  return cloudSetting(ref, 1) as Extract<DecisionModelSetting, { kind: "cloud" }>;
}

describe("the block reason choice", () => {
  it("defaults an unset key to utility and reads the two persisted JSON choices", () => {
    expect(AUTHORITY_REASON_SOURCE_KEY).toBe("volli:authority-reason-source");
    expect(AUTHORITY_REASON_SOURCES.map((option) => option.label)).toEqual([
      "Utility model",
      "Risk category",
    ]);
    expect(authorityReasonSource(undefined)).toBe("utility");
    expect(authorityReasonSource(JSON.stringify("utility"))).toBe("utility");
    expect(authorityReasonSource(JSON.stringify("category"))).toBe("category");
  });

  it("does not hide malformed or unknown saved choices", () => {
    expect(() => authorityReasonSource("")).toThrow();
    expect(() => authorityReasonSource("not json")).toThrow();
    expect(() => authorityReasonSource(JSON.stringify("other"))).toThrow("invalid");
    expect(() => authorityReasonSource("null")).toThrow("invalid");
  });
});

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

  it("writes a cloud choice with the purposes the first opt-in dialog names", () => {
    expect(cloudSetting(ZEN, 42)).toEqual({
      kind: "cloud",
      providerId: "opencode",
      modelId: "jev-1.13",
      optIn: { acceptedAt: 42, purposes: ["agent.classify", "authority.judge"] },
    });
  });

  it("asks once per scope and existing cloud agreement, never for local, none or inherit", () => {
    const legacy = {
      ...cloud(JEV),
      optIn: { acceptedAt: 1, purposes: ["agent.classify"] as const },
    };
    const globalKey = authorityOptInExtensionKey(legacy, null);
    expect(globalKey).toContain("authority.judge");
    expect(authorityOptInExtensionKey(legacy, "project-1")).not.toBe(globalKey);
    expect(authorityOptInExtensionKey(legacy, "project-2")).not.toBe(
      authorityOptInExtensionKey(legacy, "project-1"),
    );
    expect(authorityOptInExtensionKey({ ...legacy, modelId: "other" }, null)).not.toBe(globalKey);
    expect(authorityOptInExtensionKey({ ...legacy, providerId: "other" }, null)).not.toBe(
      globalKey,
    );
    expect(
      authorityOptInExtensionKey({ ...legacy, optIn: { ...legacy.optIn, acceptedAt: 2 } }, null),
    ).not.toBe(globalKey);
    expect(authorityOptInExtensionKey(cloud(JEV), null)).toBeNull();
    expect(authorityOptInExtensionKey(null, "project-1")).toBeNull();
    expect(authorityOptInExtensionKey({ kind: "none" }, null)).toBeNull();
    expect(authorityOptInExtensionKey(localSetting("", ""), null)).toBeNull();
  });

  it("extends just the disclosed authority purpose and preserves the original model", () => {
    const legacy = {
      ...cloud(JEV),
      optIn: { acceptedAt: 1, purposes: ["agent.classify"] as const },
    };
    expect(extendAuthorityCloudOptIn(legacy, 42)).toEqual({
      ...legacy,
      optIn: { acceptedAt: 42, purposes: ["agent.classify", "authority.judge"] },
    });
    expect(legacy.optIn.purposes).toEqual(["agent.classify"]);
    expect(autoPickSetting(legacy, true, 43)).toMatchObject({
      optIn: { acceptedAt: 43, purposes: ["agent.classify", "model.select"] },
    });
    const selector = {
      ...legacy,
      optIn: { acceptedAt: 1, purposes: ["agent.classify", "model.select"] as const },
    };
    expect(extendAuthorityCloudOptIn(selector, 44)).toMatchObject({
      optIn: { acceptedAt: 44, purposes: ["agent.classify", "authority.judge", "model.select"] },
    });
    const authorityOnly = {
      ...cloud(JEV),
      optIn: { acceptedAt: 1, purposes: ["authority.judge"] as const },
    };
    expect(extendAuthorityCloudOptIn(authorityOnly, 42)).toMatchObject({
      optIn: { acceptedAt: 42, purposes: ["authority.judge"] },
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

describe("automatic model choice (VC-432)", () => {
  it("is off after the first opt-in and on once the switch extends it", () => {
    const first = cloudSetting(JEV, 1);
    expect(autoPickOn(first)).toBe(false);
    const on = autoPickSetting(first, true, 9)!;
    expect(autoPickOn(on)).toBe(true);
    expect(on).toMatchObject({
      optIn: { acceptedAt: 9, purposes: ["agent.classify", "authority.judge", "model.select"] },
    });
    expect(autoPickOn(autoPickSetting(on, false, 10)!)).toBe(false);
  });

  it("is nothing for a model that is not in the cloud", () => {
    expect(autoPickOn({ kind: "none" })).toBe(false);
    expect(autoPickOn(localSetting("", ""))).toBe(false);
    expect(autoPickSetting(localSetting("", ""), true, 1)).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { NativeProbeResult } from "@volli/session-engine";

import { getAllAppState } from "./db/app-state-repo";
import { openTestDb, type TestDb } from "./db/test-helpers";
import { createRuntimeCatalog } from "./runtime-catalog";

const AVAILABLE: NativeProbeResult = {
  status: "available",
  runtime: { path: "/usr/bin/opencode", version: "1.0.0", fingerprint: "sha256:one" },
  capabilities: {
    features: [],
    catalog: [
      {
        kind: "model",
        id: "openai/codex",
        label: "Codex",
        state: "available",
        evidence: "reported",
        detail: { providerId: "openai", modelId: "codex", variants: ["low", "high"] },
      },
      {
        kind: "model",
        id: "openai/mini",
        label: "Mini",
        state: "available",
        evidence: "reported",
        detail: { providerId: "openai", modelId: "mini", variants: [] },
      },
      {
        kind: "model",
        id: "anthropic/sonnet",
        label: "Sonnet",
        state: "unavailable",
        evidence: "reported",
        detail: { providerId: "anthropic", modelId: "sonnet", variants: ["high"] },
      },
      {
        kind: "agent",
        id: "build",
        label: "Build",
        state: "available",
        evidence: "reported",
        detail: { mode: "primary", description: "Can edit files" },
      },
    ],
  },
};

let testDb: TestDb | null = null;

afterEach(() => {
  testDb?.cleanup();
  testDb = null;
});

function setup() {
  testDb = openTestDb();
  let probes = 0;
  const directories: string[] = [];
  const catalog = createRuntimeCatalog({
    db: testDb.db,
    directory: "/owned/lab/workspace",
    adapters: [
      {
        id: "opencode",
        profileId: "native",
        discover: async (context) => {
          probes += 1;
          directories.push(context.directory);
          return AVAILABLE;
        },
      },
    ],
    now: () => 1_000,
  });
  return { catalog, probes: () => probes, directories };
}

describe("Runtime Catalog", () => {
  it("keeps exhaustive discovery behind a bounded provider browse Interface", async () => {
    const fixture = setup();

    const overview = await fixture.catalog.inspect({ adapterId: "opencode" });
    expect(overview.providers).toEqual([
      expect.objectContaining({
        id: "openai",
        modelCount: 2,
        availableModelCount: 2,
        enabledModelCount: 0,
      }),
    ]);
    expect(overview.models).toEqual([]);

    const provider = await fixture.catalog.inspect({
      adapterId: "opencode",
      providerId: "openai",
      query: "cod",
      limit: 1,
    });
    expect(provider.models).toEqual([
      expect.objectContaining({ providerId: "openai", modelId: "codex", label: "Codex" }),
    ]);
    expect(provider.modelTotal).toBe(1);
    expect(fixture.probes()).toBe(1);
    expect(fixture.directories).toEqual(["/owned/lab/workspace"]);
  });

  it("keeps Chat empty and does not discover providers before Settings curates models", async () => {
    const fixture = setup();

    const resolved = await fixture.catalog.resolve({ adapterId: "opencode" });

    expect(resolved.catalog).toEqual({ providers: [], models: [], agents: [] });
    expect(resolved.selection).toEqual({
      providerId: "",
      modelId: "",
      variant: "",
      agent: "",
    });
    expect(fixture.probes()).toBe(0);
  });

  it("persists only the curated allowlist and resolves chat choices against availability", async () => {
    const fixture = setup();

    await fixture.catalog.inspect({ adapterId: "opencode" });

    await fixture.catalog.save({
      adapterId: "opencode",
      preferences: {
        version: 1,
        enabledModels: [
          { providerId: "anthropic", modelId: "sonnet" },
          { providerId: "openai", modelId: "codex" },
        ],
        defaults: {
          providerId: "anthropic",
          modelId: "sonnet",
          variant: "high",
          agent: "missing",
        },
      },
    });

    const resolved = await fixture.catalog.resolve({ adapterId: "opencode" });
    expect(resolved.catalog.providers).toEqual(["openai"]);
    expect(resolved.catalog.models).toEqual([
      expect.objectContaining({ providerId: "openai", modelId: "codex" }),
    ]);
    expect(resolved.selection).toEqual({
      providerId: "openai",
      modelId: "codex",
      // Effort carries across the repaired model only because that model
      // explicitly reports the same variant.
      variant: "high",
      agent: "build",
    });

    const stored = getAllAppState(testDb!.db)["volli:runtime-preferences:opencode"];
    expect(stored).toBeDefined();
    expect(stored).toContain("anthropic");
    expect(stored).not.toContain("Can edit files");
    expect(stored!.length).toBeLessThan(1_000);
  });

  it("reuses discovery until Settings explicitly refreshes it", async () => {
    const fixture = setup();

    await fixture.catalog.inspect({ adapterId: "opencode", providerId: "openai" });
    await fixture.catalog.resolve({ adapterId: "opencode" });
    expect(fixture.probes()).toBe(1);

    await fixture.catalog.inspect({ adapterId: "opencode", refresh: true });
    expect(fixture.probes()).toBe(2);
  });
});

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { NativeProbeResult } from "@volli/session-engine";
import type { RuntimePreferences } from "@volli/shared";

import { getAllAppState } from "./db/app-state-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
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

const PROJECT_ID = "proj-runtime";

function setup() {
  testDb = openTestDb();
  insertProject(testDb.db, testProject({ id: PROJECT_ID }));
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

/** The smallest valid preference set enabling one of the fixture's OpenAI models. */
function enabling(modelId: string): RuntimePreferences {
  return {
    version: 1,
    enabledModels: [{ providerId: "openai", modelId }],
    defaults: { providerId: "openai", modelId, variant: "", agent: "build" },
  };
}

/** A second catalog over the same db that has never probed anything. */
function undiscoveredCatalog() {
  return createRuntimeCatalog({
    db: testDb!.db,
    directory: "/owned/lab/workspace",
    adapters: [],
    now: () => 2_000,
  });
}

function projectColumn(): string | null {
  const row = testDb!.db
    .prepare("SELECT runtime_preferences FROM projects WHERE id = ?")
    .get(PROJECT_ID) as { runtime_preferences: string | null };
  return row.runtime_preferences;
}

describe("Runtime Catalog — per-project scope", () => {
  it("resolves a project against its own curated models, not the global ones", async () => {
    const fixture = setup();
    await fixture.catalog.inspect({ adapterId: "opencode" });

    await fixture.catalog.save({ adapterId: "opencode", preferences: enabling("codex") });
    await fixture.catalog.save({
      adapterId: "opencode",
      projectId: PROJECT_ID,
      preferences: enabling("mini"),
    });

    // The collision this scope exists to end: one global row cannot hold both.
    const global = await fixture.catalog.resolve({ adapterId: "opencode" });
    expect(global.catalog.models.map((model) => model.modelId)).toEqual(["codex"]);
    const scoped = await fixture.catalog.resolve({
      adapterId: "opencode",
      projectId: PROJECT_ID,
    });
    // And it resolves out of the project's OWN snapshot — `mini` is absent from
    // the global record's pre-filtered `models`, so intent alone could not have
    // answered this.
    expect(scoped.catalog.models.map((model) => model.modelId)).toEqual(["mini"]);
    expect(scoped.selection).toEqual({
      providerId: "openai",
      modelId: "mini",
      variant: "",
      agent: "build",
    });
  });

  it("inherits the global record for an adapter the project does not override", async () => {
    const fixture = setup();
    await fixture.catalog.inspect({ adapterId: "opencode" });
    await fixture.catalog.save({ adapterId: "opencode", preferences: enabling("codex") });

    const scoped = await fixture.catalog.resolve({
      adapterId: "opencode",
      projectId: PROJECT_ID,
    });

    expect(scoped.catalog.models.map((model) => model.modelId)).toEqual(["codex"]);
    expect(projectColumn()).toBeNull();
  });

  it("falls through to the global record when the project's own JSON no longer parses", async () => {
    const fixture = setup();
    await fixture.catalog.inspect({ adapterId: "opencode" });
    await fixture.catalog.save({ adapterId: "opencode", preferences: enabling("codex") });
    // Valid JSON, wrong shape — what a hand-edited row looks like. The column's
    // CHECK admits it and nothing above here may throw over it.
    testDb!.db
      .prepare("UPDATE projects SET runtime_preferences = ? WHERE id = ?")
      .run('{"opencode":{"recordVersion":1,"nonsense":true}}', PROJECT_ID);

    const scoped = await fixture.catalog.resolve({
      adapterId: "opencode",
      projectId: PROJECT_ID,
    });
    const view = await fixture.catalog.inspect({ adapterId: "opencode", projectId: PROJECT_ID });

    expect(scoped.catalog.models.map((model) => model.modelId)).toEqual(["codex"]);
    expect(view.preferencesOrigin).toBe("global");
  });

  it("reports which scope answered, so an inherit/override control has something to read", async () => {
    const fixture = setup();
    await fixture.catalog.inspect({ adapterId: "opencode" });
    await fixture.catalog.save({ adapterId: "opencode", preferences: enabling("codex") });

    // Nothing stored for the project yet, and the identical preferences read
    // back either way — the origin is the only thing that tells them apart.
    const inherited = await fixture.catalog.inspect({
      adapterId: "opencode",
      projectId: PROJECT_ID,
    });
    expect(inherited.preferencesOrigin).toBe("global");
    expect(inherited.preferences.enabledModels).toEqual([
      { providerId: "openai", modelId: "codex" },
    ]);

    await fixture.catalog.save({
      adapterId: "opencode",
      projectId: PROJECT_ID,
      preferences: enabling("codex"),
    });

    const overridden = await fixture.catalog.inspect({
      adapterId: "opencode",
      projectId: PROJECT_ID,
    });
    expect(overridden.preferencesOrigin).toBe("project");
    expect(overridden.preferences.enabledModels).toEqual(inherited.preferences.enabledModels);
    expect((await fixture.catalog.inspect({ adapterId: "opencode" })).preferencesOrigin).toBe(
      "global",
    );
  });

  it("pairs a project-scoped save with the inspect before it, on the one instance holding the snapshot", async () => {
    const fixture = setup();

    // The precondition is about the DISCOVERY snapshot, which the instance holds
    // per adapter and not per scope — so the pairing is kept by sending the same
    // projectId twice, and this is what a Settings screen actually does.
    await expect(
      fixture.catalog.save({
        adapterId: "opencode",
        projectId: PROJECT_ID,
        preferences: enabling("codex"),
      }),
    ).rejects.toThrow("Inspect the Runtime Catalog before saving model preferences");

    await fixture.catalog.inspect({ adapterId: "opencode", projectId: PROJECT_ID });
    await fixture.catalog.save({
      adapterId: "opencode",
      projectId: PROJECT_ID,
      preferences: enabling("codex"),
    });

    expect(projectColumn()).toContain("recordVersion");
    // The global row stays out of it entirely.
    expect(getAllAppState(testDb!.db)["volli:runtime-preferences:opencode"]).toBeUndefined();
  });

  it("clears a project override without a discovery snapshot, nulling the column with the last key", async () => {
    const fixture = setup();
    await fixture.catalog.inspect({ adapterId: "opencode" });
    await fixture.catalog.save({ adapterId: "opencode", preferences: enabling("codex") });
    await fixture.catalog.save({
      adapterId: "opencode",
      projectId: PROJECT_ID,
      preferences: enabling("mini"),
    });

    // A second instance over the same db has discovered nothing — which `save`
    // refuses over and `clear` has no use for.
    await undiscoveredCatalog().clear({ projectId: PROJECT_ID, adapterId: "opencode" });

    expect(projectColumn()).toBeNull();
    const scoped = await fixture.catalog.resolve({
      adapterId: "opencode",
      projectId: PROJECT_ID,
    });
    expect(scoped.catalog.models.map((model) => model.modelId)).toEqual(["codex"]);
  });
});

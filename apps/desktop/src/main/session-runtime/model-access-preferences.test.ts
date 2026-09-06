import { afterEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  assertDefaultModelAvailable,
  COMPACTION_POLICY_APP_STATE_KEY,
  MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
  MODEL_ACCESS_DEFAULTS_APP_STATE_KEY,
  MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY,
  readCompactionPolicy,
  readDefaultModelSelection,
  readHiddenModels,
  readModelAccessDefaults,
  reconcileModelAccessPreferences,
  writeCompactionPolicy,
  writeHiddenModels,
  writeModelAccessDefault,
} from "./model-access-preferences";

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

describe("Model Access default selection", () => {
  it("round-trips one purpose's model policy without disturbing the others", () => {
    ctx = openTestDb();
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    writeModelAccessDefault(ctx.db, "global", selection, 123);
    const ticket = { ...selection, modelId: "gpt-5.6-luna" };
    expect(writeModelAccessDefault(ctx.db, "ticket", ticket, 124)).toEqual({
      global: selection,
      ticket,
      utility: null,
    });
    expect(readModelAccessDefaults(ctx.db)).toEqual({
      global: selection,
      ticket,
      utility: null,
    });

    // Clearing an explicit choice is a write, not an absence.
    writeModelAccessDefault(ctx.db, "ticket", null, 125);
    expect(readModelAccessDefaults(ctx.db).ticket).toBeNull();
    expect(readModelAccessDefaults(ctx.db).global).toEqual(selection);
  });

  it("reads a pre-purpose single default as the global purpose", () => {
    ctx = openTestDb();
    const selection = {
      providerId: "anthropic",
      modelId: "claude-sonnet",
      reasoningLevel: "medium" as const,
    };
    setAppState(ctx.db, MODEL_ACCESS_DEFAULT_APP_STATE_KEY, JSON.stringify(selection), 1);

    expect(readModelAccessDefaults(ctx.db)).toEqual({
      global: selection,
      ticket: null,
      utility: null,
    });

    // The first purpose-aware write persists the new shape; the legacy key
    // stops being consulted from then on.
    writeModelAccessDefault(ctx.db, "utility", { ...selection, modelId: "claude-haiku" }, 2);
    setAppState(ctx.db, MODEL_ACCESS_DEFAULT_APP_STATE_KEY, "not-json", 3);
    expect(readModelAccessDefaults(ctx.db)).toEqual({
      global: selection,
      ticket: null,
      utility: { ...selection, modelId: "claude-haiku" },
    });
  });

  it("sanitizes each stored purpose independently", () => {
    ctx = openTestDb();
    setAppState(
      ctx.db,
      MODEL_ACCESS_DEFAULTS_APP_STATE_KEY,
      JSON.stringify({
        global: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "medium" },
        ticket: { providerId: "  ", modelId: "broken", reasoningLevel: "medium" },
        utility: "not-an-object",
      }),
      1,
    );

    expect(readModelAccessDefaults(ctx.db)).toEqual({
      global: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "medium" },
      ticket: null,
      utility: null,
    });

    setAppState(ctx.db, MODEL_ACCESS_DEFAULTS_APP_STATE_KEY, "not-json", 2);
    expect(readModelAccessDefaults(ctx.db)).toEqual({ global: null, ticket: null, utility: null });
  });

  it("treats missing or malformed stored state as unconfigured", () => {
    ctx = openTestDb();
    expect(readDefaultModelSelection(ctx.db)).toBeNull();

    setAppState(ctx.db, MODEL_ACCESS_DEFAULT_APP_STATE_KEY, "not-json", 1);
    expect(readDefaultModelSelection(ctx.db)).toBeNull();

    setAppState(
      ctx.db,
      MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
      JSON.stringify({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "provider-native-ultra",
        token: "must-not-escape",
      }),
      2,
    );
    expect(readDefaultModelSelection(ctx.db)).toBeNull();

    for (const providerId of ["   ", " openai-codex", "x".repeat(513)]) {
      setAppState(
        ctx.db,
        MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
        JSON.stringify({ providerId, modelId: "gpt-5.6-sol", reasoningLevel: "high" }),
        3,
      );
      expect(readDefaultModelSelection(ctx.db)).toBeNull();
    }
  });

  it("reconstructs the exact safe shape from stored JSON", () => {
    ctx = openTestDb();
    setAppState(
      ctx.db,
      MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
      JSON.stringify({
        providerId: "anthropic",
        modelId: "claude-sonnet",
        reasoningLevel: "medium",
        apiKey: "secret",
      }),
      1,
    );

    expect(readDefaultModelSelection(ctx.db)).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet",
      reasoningLevel: "medium",
    });
  });

  it("round-trips the curated hidden-model list and drops malformed entries", () => {
    ctx = openTestDb();
    expect(readHiddenModels(ctx.db)).toEqual([]);

    writeHiddenModels(
      ctx.db,
      [{ providerId: "anthropic", modelId: "claude-haiku", extra: "dropped" } as never],
      1,
    );
    expect(readHiddenModels(ctx.db)).toEqual([
      { providerId: "anthropic", modelId: "claude-haiku" },
    ]);

    setAppState(
      ctx.db,
      MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY,
      JSON.stringify([
        { providerId: "anthropic", modelId: "claude-haiku" },
        { providerId: "  ", modelId: "claude-haiku" },
        "not-an-object",
        null,
      ]),
      2,
    );
    expect(readHiddenModels(ctx.db)).toEqual([
      { providerId: "anthropic", modelId: "claude-haiku" },
    ]);

    setAppState(ctx.db, MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY, "not-json", 3);
    expect(readHiddenModels(ctx.db)).toEqual([]);
  });

  it("clears defaults and visibility settings whose models retired upstream", () => {
    ctx = openTestDb();
    const stable = {
      providerId: "acme",
      modelId: "stable",
      reasoningLevel: "off" as const,
    };
    writeModelAccessDefault(ctx.db, "global", { ...stable, modelId: "retired" }, 1);
    writeModelAccessDefault(ctx.db, "ticket", stable, 2);
    writeHiddenModels(
      ctx.db,
      [
        { providerId: "acme", modelId: "retired" },
        { providerId: "acme", modelId: "stable" },
      ],
      3,
    );

    reconcileModelAccessPreferences(
      ctx.db,
      {
        observedAt: 4,
        providers: [],
        models: [
          {
            providerId: "acme",
            modelId: "stable",
            label: "Stable",
            state: "available",
            reasoningLevels: ["off"],
            acceptsImageInput: false,
          },
        ],
        refresh: {
          added: 0,
          removed: 1,
          rejected: 0,
          refreshedProviderIds: ["acme"],
          failedProviderIds: [],
        },
      },
      5,
    );

    expect(readModelAccessDefaults(ctx.db)).toEqual({
      global: null,
      ticket: stable,
      utility: null,
    });
    expect(readHiddenModels(ctx.db)).toEqual([{ providerId: "acme", modelId: "stable" }]);
  });

  it("follows a renamed model rather than dropping the choice someone made", () => {
    ctx = openTestDb();
    // `ox-alpha-free` is superseded by `glm-5.3-flash` in the catalogue's own
    // identity policy; a default naming it should end up on the new id, not on
    // nothing. The provider is hidden under BOTH names, so following the rename
    // must also not leave the same row hidden twice.
    const alias = {
      providerId: "opencode-go",
      modelId: "ox-alpha-free",
      reasoningLevel: "high" as const,
    };
    writeModelAccessDefault(ctx.db, "global", alias, 1);
    writeHiddenModels(
      ctx.db,
      [
        { providerId: "opencode-go", modelId: "ox-alpha-free" },
        { providerId: "opencode-go", modelId: "glm-5.3-flash" },
      ],
      2,
    );

    reconcileModelAccessPreferences(
      ctx.db,
      {
        observedAt: 3,
        providers: [],
        models: [
          {
            providerId: "opencode-go",
            modelId: "glm-5.3-flash",
            label: "GLM-5.3-Flash",
            state: "available",
            reasoningLevels: ["high"],
            acceptsImageInput: false,
          },
        ],
        refresh: {
          added: 1,
          removed: 1,
          rejected: 0,
          refreshedProviderIds: ["opencode-go"],
          failedProviderIds: [],
        },
      },
      4,
    );

    expect(readModelAccessDefaults(ctx.db).global).toEqual({
      ...alias,
      modelId: "glm-5.3-flash",
    });
    expect(readHiddenModels(ctx.db)).toEqual([
      { providerId: "opencode-go", modelId: "glm-5.3-flash" },
    ]);
  });

  it("leaves every preference alone for a provider whose feed failed", () => {
    ctx = openTestDb();
    const pinned = {
      providerId: "acme",
      modelId: "only-in-the-old-list",
      reasoningLevel: "off" as const,
    };
    writeModelAccessDefault(ctx.db, "global", pinned, 1);
    writeHiddenModels(ctx.db, [{ providerId: "acme", modelId: "only-in-the-old-list" }], 2);

    reconcileModelAccessPreferences(
      ctx.db,
      {
        observedAt: 3,
        providers: [],
        models: [],
        refresh: {
          added: 0,
          removed: 0,
          rejected: 0,
          refreshedProviderIds: ["other"],
          failedProviderIds: ["acme"],
        },
      },
      4,
    );

    // `acme` kept its last usable list, so nothing about it was retired.
    expect(readModelAccessDefaults(ctx.db).global).toEqual(pinned);
    expect(readHiddenModels(ctx.db)).toEqual([
      { providerId: "acme", modelId: "only-in-the-old-list" },
    ]);
  });

  it("stores only a model this profile can run today", () => {
    const access = {
      observedAt: 1,
      providers: [],
      models: [
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          state: "available" as const,
          reasoningLevels: ["off", "high"] as const,
          acceptsImageInput: true,
        },
      ],
    };

    expect(() =>
      assertDefaultModelAvailable(access, {
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    ).not.toThrow();
    expect(() =>
      assertDefaultModelAvailable(access, {
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "medium",
      }),
    ).toThrow("reasoning level");
    expect(() =>
      assertDefaultModelAvailable(
        { ...access, models: [{ ...access.models[0]!, state: "authentication-required" }] },
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      ),
    ).toThrow("Sign in");
    expect(() =>
      assertDefaultModelAvailable(
        { ...access, models: [] },
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      ),
    ).toThrow("not currently available");
    expect(() =>
      assertDefaultModelAvailable(
        { ...access, models: [{ ...access.models[0]!, state: "unavailable" }] },
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      ),
    ).toThrow("not currently available");
  });
});

describe("the stored compaction policy", () => {
  it("compacts automatically until a profile says otherwise", () => {
    ctx = openTestDb();
    // What every profile did before this setting existed. An update is not a
    // reason to stop compacting, so an absent key is not an off switch.
    expect(readCompactionPolicy(ctx.db)).toEqual({ autoCompaction: true });

    setAppState(ctx.db, COMPACTION_POLICY_APP_STATE_KEY, "not-json", 1);
    expect(readCompactionPolicy(ctx.db)).toEqual({ autoCompaction: true });

    setAppState(ctx.db, COMPACTION_POLICY_APP_STATE_KEY, JSON.stringify({}), 2);
    expect(readCompactionPolicy(ctx.db).autoCompaction).toBe(true);
  });

  it("round-trips the switch", () => {
    ctx = openTestDb();
    const policy = { autoCompaction: false, extra: "dropped" } as never;

    expect(writeCompactionPolicy(ctx.db, policy, 1)).toEqual({ autoCompaction: false });
    expect(readCompactionPolicy(ctx.db)).toEqual({ autoCompaction: false });
  });

  it("keeps the switch from a blob written by the per-model-reserve era", () => {
    ctx = openTestDb();
    // The retired shape (VC-155): the switch is still honoured and the limits
    // beside it are simply ignored — nobody's off switch flips back on update.
    setAppState(
      ctx.db,
      COMPACTION_POLICY_APP_STATE_KEY,
      JSON.stringify({
        autoCompaction: false,
        modelLimits: [
          { providerId: "anthropic", modelId: "claude-sonnet-4-5", reserveTokens: 32_768 },
        ],
      }),
      1,
    );

    expect(readCompactionPolicy(ctx.db)).toEqual({ autoCompaction: false });
  });
});

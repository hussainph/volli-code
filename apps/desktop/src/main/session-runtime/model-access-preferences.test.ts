import { afterEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  assertDefaultModelAvailable,
  MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
  MODEL_ACCESS_DEFAULTS_APP_STATE_KEY,
  MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY,
  readDefaultModelSelection,
  readHiddenModels,
  readModelAccessDefaults,
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

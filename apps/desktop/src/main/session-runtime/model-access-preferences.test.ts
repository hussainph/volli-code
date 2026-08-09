import { afterEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  assertDefaultModelAvailable,
  MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
  readDefaultModelSelection,
  writeDefaultModelSelection,
} from "./model-access-preferences";

let ctx: TestDb | null = null;

afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

describe("Model Access default selection", () => {
  it("round-trips the user-configured model and reasoning policy", () => {
    ctx = openTestDb();
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    writeDefaultModelSelection(ctx.db, selection, 123);

    expect(readDefaultModelSelection(ctx.db)).toEqual(selection);
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

  it("accepts a known model before sign-in but still rejects unavailable or unsupported choices", () => {
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
    ).not.toThrow();
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

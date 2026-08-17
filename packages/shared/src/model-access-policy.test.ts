import { describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "./agent-runtime";

import {
  DEFAULT_MODEL_REQUIRED,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  isDefaultModelRequired,
  isModelHidden,
  resolveDefaultModel,
  visibleModels,
  withModelVisibility,
} from "./model-access-policy";

const GLOBAL: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-sonnet",
  reasoningLevel: "medium",
};
const TICKET: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

describe("resolveDefaultModel", () => {
  it("resolves each purpose to its own explicit choice", () => {
    const defaults = { global: GLOBAL, ticket: TICKET, utility: GLOBAL };
    expect(resolveDefaultModel(defaults, "global")).toBe(GLOBAL);
    expect(resolveDefaultModel(defaults, "ticket")).toBe(TICKET);
    expect(resolveDefaultModel(defaults, "utility")).toBe(GLOBAL);
  });

  it("resolves an unset ticket or utility purpose to the global default", () => {
    const defaults = { global: GLOBAL, ticket: null, utility: null };
    expect(resolveDefaultModel(defaults, "ticket")).toBe(GLOBAL);
    expect(resolveDefaultModel(defaults, "utility")).toBe(GLOBAL);
  });

  it("resolves null — never a substitute — when nothing is configured", () => {
    expect(resolveDefaultModel(EMPTY_MODEL_ACCESS_DEFAULTS, "global")).toBeNull();
    expect(resolveDefaultModel(EMPTY_MODEL_ACCESS_DEFAULTS, "ticket")).toBeNull();
  });
});

describe("isDefaultModelRequired", () => {
  it("recognizes the refusal however a transport wrapped it", () => {
    expect(isDefaultModelRequired(DEFAULT_MODEL_REQUIRED)).toBe(true);
    expect(isDefaultModelRequired(`Could not start Session: ${DEFAULT_MODEL_REQUIRED}`)).toBe(true);
  });

  it("does not claim unrelated failures", () => {
    expect(isDefaultModelRequired("socket hang up")).toBe(false);
  });
});

describe("model visibility", () => {
  const sonnet = { providerId: "anthropic", modelId: "claude-sonnet" };
  const opus = { providerId: "anthropic", modelId: "claude-opus" };
  const luna = { providerId: "openai", modelId: "claude-sonnet" };

  it("hides exactly the provider+model pair, not every model sharing an id", () => {
    const hidden = [sonnet];
    expect(isModelHidden(hidden, sonnet)).toBe(true);
    expect(isModelHidden(hidden, luna)).toBe(false);
    expect(visibleModels([sonnet, opus, luna], hidden)).toEqual([opus, luna]);
  });

  it("keeps the whole catalog when nothing is hidden", () => {
    const models = [sonnet, opus];
    expect(visibleModels(models, [])).toBe(models);
  });

  it("toggles a model off and back on without duplicating entries", () => {
    const hidden = withModelVisibility([], sonnet, false);
    expect(hidden).toEqual([sonnet]);
    expect(withModelVisibility(hidden, sonnet, false)).toEqual([sonnet]);
    expect(withModelVisibility(hidden, sonnet, true)).toEqual([]);
  });
});

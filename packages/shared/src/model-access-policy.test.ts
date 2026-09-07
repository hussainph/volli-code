import { describe, expect, it } from "vite-plus/test";
import type { ModelSelection } from "./agent-runtime";

import {
  DEFAULT_MODEL_REQUIRED,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  isDefaultModelRequired,
  isModelHidden,
  isModelPickerView,
  DEFAULT_MODEL_PICKER_VIEW,
  MODEL_PICKER_VIEWS,
  AGENT_MODEL_TIERS,
  MODEL_TIER_ROWS,
  MODEL_TIERS,
  acceptsImageInputIn,
  defaultModelRequiredForTier,
  isAgentModelTier,
  modelPurposeForRole,
  resolveDefaultModel,
  resolveModelTier,
  visibleModels,
  visualModelProblem,
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
    const defaults = {
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: GLOBAL,
      ticket: TICKET,
      utility: GLOBAL,
    };
    expect(resolveDefaultModel(defaults, "global")).toBe(GLOBAL);
    expect(resolveDefaultModel(defaults, "ticket")).toBe(TICKET);
    expect(resolveDefaultModel(defaults, "utility")).toBe(GLOBAL);
  });

  it("resolves an unset ticket or utility purpose to the global default", () => {
    const defaults = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: GLOBAL };
    expect(resolveDefaultModel(defaults, "ticket")).toBe(GLOBAL);
    expect(resolveDefaultModel(defaults, "utility")).toBe(GLOBAL);
  });

  it("resolves null — never a substitute — when nothing is configured", () => {
    expect(resolveDefaultModel(EMPTY_MODEL_ACCESS_DEFAULTS, "global")).toBeNull();
    expect(resolveDefaultModel(EMPTY_MODEL_ACCESS_DEFAULTS, "ticket")).toBeNull();
  });
});

describe("model tiers", () => {
  const FAST: ModelSelection = { providerId: "openai", modelId: "gpt-mini", reasoningLevel: "low" };

  it("is the fixed set, in Settings order: the three purposes, then the advanced tiers", () => {
    expect(MODEL_TIERS).toEqual(["global", "ticket", "utility", "fast", "deep", "visual"]);
  });

  it("resolves a set tier to its own choice and says so", () => {
    const defaults = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: GLOBAL, ticket: TICKET, fast: FAST };
    expect(resolveModelTier(defaults, "fast")).toEqual({
      tier: "fast",
      resolvedFrom: "fast",
      selection: FAST,
    });
  });

  it("resolves an unset advanced tier through Ticket, then Board — and names the rung", () => {
    const viaTicket = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: GLOBAL, ticket: TICKET };
    expect(resolveModelTier(viaTicket, "fast")).toEqual({
      tier: "fast",
      resolvedFrom: "ticket",
      selection: TICKET,
    });
    const viaGlobal = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: GLOBAL };
    expect(resolveModelTier(viaGlobal, "deep")).toEqual({
      tier: "deep",
      resolvedFrom: "global",
      selection: GLOBAL,
    });
  });

  it("resolves null for an advanced tier when nothing above it is configured", () => {
    expect(resolveModelTier(EMPTY_MODEL_ACCESS_DEFAULTS, "fast")).toBeNull();
    expect(resolveDefaultModel(EMPTY_MODEL_ACCESS_DEFAULTS, "deep")).toBeNull();
  });
});

describe("tiers as agents name them", () => {
  it("lets a delegating Session name every tier but Utility", () => {
    expect(AGENT_MODEL_TIERS).toEqual(["fast", "deep", "visual", "ticket", "global"]);
    expect(isAgentModelTier("fast")).toBe(true);
    expect(isAgentModelTier("utility")).toBe(false);
    expect(isAgentModelTier("smol")).toBe(false);
  });

  it("carries one label and one-line job per tier, in Settings order", () => {
    expect(MODEL_TIER_ROWS.map((row) => row.tier)).toEqual(MODEL_TIERS);
    expect(MODEL_TIER_ROWS.find((row) => row.tier === "fast")).toEqual({
      tier: "fast",
      label: "Fast",
      hint: "Quick, low-cost tasks.",
      advanced: true,
    });
    expect(MODEL_TIER_ROWS.find((row) => row.tier === "ticket")?.advanced).toBe(false);
  });

  it("refuses an unresolved tier with the one missing-default sentence, naming the tier", () => {
    const message = defaultModelRequiredForTier("deep");
    expect(message).toBe(
      "Choose a default model in Settings before starting a Session. The deep tier resolved to nothing.",
    );
    expect(isDefaultModelRequired(message)).toBe(true);
  });
});

describe("the visual tier", () => {
  const VISUAL: ModelSelection = {
    providerId: "openai",
    modelId: "gpt-vision",
    reasoningLevel: "medium",
  };
  const catalog = [
    { providerId: "anthropic", modelId: "claude-sonnet", acceptsImageInput: true },
    { providerId: "anthropic", modelId: "claude-opus", acceptsImageInput: false },
    { providerId: "openai", modelId: "gpt-vision", acceptsImageInput: true },
  ];
  const sees = acceptsImageInputIn(catalog);

  it("resolves an explicit Visual choice as-is — it was checked when it was saved", () => {
    const defaults = { ...EMPTY_MODEL_ACCESS_DEFAULTS, visual: VISUAL };
    expect(resolveModelTier(defaults, "visual")).toEqual({
      tier: "visual",
      resolvedFrom: "visual",
      selection: VISUAL,
    });
  });

  it("falls back to the Ticket default only when that model accepts images", () => {
    const sonnetTicket = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: TICKET, ticket: GLOBAL };
    expect(resolveModelTier(sonnetTicket, "visual", sees)).toEqual({
      tier: "visual",
      resolvedFrom: "ticket",
      selection: GLOBAL,
    });
  });

  it("reads a model the catalog does not hold as blind", () => {
    // A stored default whose row has since left the catalog (provider signed
    // out, model retired) cannot be checked, so it cannot be inherited by
    // Visual — the same refusal as a model that is known not to see.
    expect(sees({ providerId: "gone", modelId: "gone", reasoningLevel: "low" })).toBe(false);
    const goneTicket = {
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: GLOBAL,
      ticket: { providerId: "gone", modelId: "gone", reasoningLevel: "low" as const },
    };
    expect(resolveModelTier(goneTicket, "visual", sees)).toBeNull();
  });

  it("refuses — never skips a rung — when the Ticket default cannot read images", () => {
    // Ticket is Opus (no images); Board is Sonnet (images). The walk lands on
    // Ticket and stops: reaching past the user's Ticket choice to find a model
    // that happens to see would be a substitution nobody chose.
    const opusTicket = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: GLOBAL, ticket: TICKET };
    expect(resolveModelTier(opusTicket, "visual", sees)).toBeNull();
  });

  it("refuses the fallback when no catalog is there to check it against", () => {
    const defaults = { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: GLOBAL };
    expect(resolveModelTier(defaults, "visual")).toBeNull();
  });

  it("names the one reason a model cannot be the Visual default", () => {
    expect(visualModelProblem(catalog, GLOBAL)).toBeNull();
    expect(visualModelProblem(catalog, TICKET)).toBe(
      "This model can't read images, so it can't be the Visual default.",
    );
    expect(visualModelProblem(catalog, VISUAL)).toBeNull();
  });
});

describe("modelPurposeForRole", () => {
  it("reads a Subagent Session off the utility rung — cost-efficient background work (VC-9)", () => {
    expect(modelPurposeForRole("project")).toBe("global");
    expect(modelPurposeForRole("ticket")).toBe("ticket");
    expect(modelPurposeForRole("subagent")).toBe("utility");
  });

  it("is the rung a start resolves through only when it names no tier of its own", () => {
    // VC-259: the Role's tier is the floor. A named tier replaces it, which is
    // `resolveModelTier`'s job above, not this map's.
    expect(MODEL_TIERS).toContain(modelPurposeForRole("subagent"));
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

describe("the picker view", () => {
  it("opens on every model until a profile chooses otherwise", () => {
    expect(MODEL_PICKER_VIEWS).toEqual(["all", "defaults"]);
    expect(DEFAULT_MODEL_PICKER_VIEW).toBe("all");
  });

  it("recognizes the two views and nothing else", () => {
    expect(isModelPickerView("all")).toBe(true);
    expect(isModelPickerView("defaults")).toBe(true);
    expect(isModelPickerView("tiers")).toBe(false);
    expect(isModelPickerView(null)).toBe(false);
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

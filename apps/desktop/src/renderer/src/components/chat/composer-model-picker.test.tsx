// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessDefaults,
  type ModelAccessModel,
  type ModelAccessProvider as CatalogProvider,
  type ModelPickerView,
} from "@volli/shared";

import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";

import {
  composerTierRows,
  ModelPill,
  offerableModels,
  type ComposerModelSelection,
} from "./composer-ui";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

const PROVIDERS: readonly CatalogProvider[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    state: "available",
    accountLabel: null,
    billingSource: "unknown",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    state: "authentication-required",
    accountLabel: null,
    billingSource: "unknown",
    recovery: null,
    signIn: [],
    hasStoredCredential: false,
  },
];

const MODELS: readonly ModelAccessModel[] = [
  {
    providerId: "anthropic",
    modelId: "sonnet",
    label: "Claude Sonnet",
    state: "available",
    reasoningLevels: ["low", "medium", "high"],
    acceptsImageInput: true,
  },
  {
    providerId: "anthropic",
    modelId: "haiku",
    label: "Claude Haiku",
    state: "available",
    reasoningLevels: ["off", "low"],
    acceptsImageInput: true,
  },
  {
    providerId: "anthropic",
    modelId: "blind",
    label: "Blind",
    state: "available",
    reasoningLevels: ["low"],
    acceptsImageInput: false,
  },
  {
    providerId: "openai",
    modelId: "o5",
    label: "o5",
    state: "authentication-required",
    reasoningLevels: ["medium"],
    acceptsImageInput: true,
  },
];

const SONNET = { providerId: "anthropic", modelId: "sonnet", reasoningLevel: "high" as const };
const HAIKU = { providerId: "anthropic", modelId: "haiku", reasoningLevel: "low" as const };

/* ---------------------------------------------------------------- the rows */

describe("the tier table a picker offers", () => {
  it("lists the five agent-facing tiers in the tool's order, never Utility", () => {
    const rows = composerTierRows(EMPTY_MODEL_ACCESS_DEFAULTS, MODELS, PROVIDERS, []);
    expect(rows.map((row) => row.tier)).toEqual(["fast", "deep", "visual", "ticket", "global"]);
    expect(rows.map((row) => row.label)).toEqual([
      "Fast",
      "Deep",
      "Visual",
      "Ticket Sessions",
      "Board chats",
    ]);
  });

  it("resolves each tier through the shared ladder, carrying the rung's level", () => {
    const rows = composerTierRows(
      { ...EMPTY_MODEL_ACCESS_DEFAULTS, ticket: SONNET, fast: HAIKU },
      MODELS,
      PROVIDERS,
      [],
    );
    const byTier = Object.fromEntries(rows.map((row) => [row.tier, row]));
    expect(byTier["fast"]).toMatchObject({
      state: "ready",
      model: { providerId: "anthropic", providerLabel: "Anthropic", label: "Claude Haiku" },
      reasoningLevel: "low",
    });
    // Deep inherits the Ticket row — model AND level.
    expect(byTier["deep"]).toMatchObject({
      state: "ready",
      model: { modelId: "sonnet" },
      reasoningLevel: "high",
    });
    expect(byTier["global"]).toMatchObject({ state: "unset", model: null, reasoningLevel: null });
  });

  it("is honest about a Visual fallback the Ticket model cannot see", () => {
    const rows = composerTierRows(
      {
        ...EMPTY_MODEL_ACCESS_DEFAULTS,
        ticket: { providerId: "anthropic", modelId: "blind", reasoningLevel: "low" },
      },
      MODELS,
      PROVIDERS,
      [],
    );
    expect(rows.find((row) => row.tier === "visual")).toMatchObject({ state: "unset" });
    expect(rows.find((row) => row.tier === "fast")).toMatchObject({ state: "ready" });
  });

  it("still names a model it cannot offer, with the reason", () => {
    const rows = composerTierRows(
      {
        ...EMPTY_MODEL_ACCESS_DEFAULTS,
        global: { providerId: "openai", modelId: "o5", reasoningLevel: "medium" },
        fast: HAIKU,
        deep: { providerId: "anthropic", modelId: "retired", reasoningLevel: "low" },
      },
      MODELS,
      PROVIDERS,
      [{ providerId: "anthropic", modelId: "haiku" }],
    );
    const byTier = Object.fromEntries(rows.map((row) => [row.tier, row]));
    expect(byTier["fast"]).toMatchObject({ state: "hidden", model: { label: "Claude Haiku" } });
    expect(byTier["global"]).toMatchObject({ state: "signed-out", model: { label: "o5" } });
    // A model the catalog no longer lists keeps its id as its name.
    expect(byTier["deep"]).toMatchObject({
      state: "unavailable",
      model: { label: "retired", providerLabel: "Anthropic" },
    });
  });
});

/* ---------------------------------------------------------------- the pill */

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // cmdk measures its list and scrolls the active row; jsdom has neither.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function labClient(
  view: ModelPickerView,
  defaults: ModelAccessDefaults,
): ModelAccessClient & {
  views: ModelPickerView[];
} {
  const views: ModelPickerView[] = [];
  return {
    views,
    inspect: async () => ({ observedAt: 1, providers: PROVIDERS, models: MODELS }),
    defaults: async () => defaults,
    setDefault: async () => defaults,
    hiddenModels: async () => [],
    setHiddenModels: async (hidden) => hidden,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    pickerView: async () => view,
    setPickerView: async (next) => {
      views.push(next);
      return next;
    },
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
}

async function renderPill(input: {
  view: ModelPickerView;
  defaults: ModelAccessDefaults;
  withTiers?: boolean;
  selectionTier?: string | null;
  onChange?: (next: ComposerModelSelection) => void;
}): Promise<ReturnType<typeof labClient>> {
  const client = labClient(input.view, input.defaults);
  const models = offerableModels(MODELS, PROVIDERS, []);
  const tiers = composerTierRows(input.defaults, MODELS, PROVIDERS, []);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={client}>
        <ModelPill
          models={models}
          tiers={input.withTiers === false ? undefined : tiers}
          selection={{ providerId: "anthropic", modelId: "sonnet", reasoningLevel: "medium" }}
          selectionTier={input.selectionTier ?? null}
          disabled={false}
          onChange={input.onChange ?? (() => undefined)}
          open
        />
      </ModelAccessProvider>,
    );
  });
  return client;
}

function tierRow(tier: string): HTMLElement | null {
  return document.querySelector(`[data-testid="model-picker-tier-${tier}"]`);
}

describe("the model pill's Defaults view", () => {
  it("opens on the list the profile remembered, with no search box over the tiers", async () => {
    await renderPill({
      view: "defaults",
      defaults: { ...EMPTY_MODEL_ACCESS_DEFAULTS, ticket: SONNET, fast: HAIKU },
    });
    const toggle = document.querySelector('[data-testid="model-picker-view"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.querySelector('[data-choice="defaults"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.querySelector('[data-slot="command-input"]')).toBeNull();
    expect(tierRow("fast")?.textContent).toContain("Fast");
    expect(tierRow("fast")?.textContent).toContain("Claude Haiku");
    expect(tierRow("fast")?.textContent).toContain("low");
    expect(tierRow("deep")?.textContent).toContain("Claude Sonnet");
    expect(tierRow("deep")?.textContent).toContain("high");
  });

  it("shows an unset tier as one word and refuses to pick it", async () => {
    await renderPill({ view: "defaults", defaults: EMPTY_MODEL_ACCESS_DEFAULTS });
    const row = tierRow("global");
    expect(row?.textContent).toBe("Board chatsunset");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.getAttribute("data-tier-state")).toBe("unset");
  });

  it("pins the tier's exact model and level through the same onChange a model row calls", async () => {
    const picked: ComposerModelSelection[] = [];
    await renderPill({
      view: "defaults",
      defaults: { ...EMPTY_MODEL_ACCESS_DEFAULTS, ticket: SONNET, fast: HAIKU },
      onChange: (next) => picked.push(next),
    });
    await act(async () => {
      tierRow("fast")?.click();
    });
    expect(picked).toEqual([{ providerId: "anthropic", modelId: "haiku", reasoningLevel: "low" }]);
  });

  it("switches back to every model, brings the search box with it, and remembers the choice", async () => {
    const client = await renderPill({
      view: "defaults",
      defaults: { ...EMPTY_MODEL_ACCESS_DEFAULTS, ticket: SONNET },
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="model-picker-view"] [data-choice="all"]')
        ?.click();
    });
    expect(client.views).toEqual(["all"]);
    expect(document.querySelector('[data-slot="command-input"]')).not.toBeNull();
    expect(tierRow("ticket")).toBeNull();
    expect(document.body.textContent).toContain("Claude Haiku");
  });

  it("draws no toggle at all for a caller with no tier table", async () => {
    await renderPill({
      view: "defaults",
      defaults: { ...EMPTY_MODEL_ACCESS_DEFAULTS, ticket: SONNET },
      withTiers: false,
    });
    expect(document.querySelector('[data-testid="model-picker-view"]')).toBeNull();
    expect(document.querySelector('[data-slot="command-input"]')).not.toBeNull();
  });
});

/**
 * The pill draws eight characters of a model name at a narrow pane and is right
 * to (VC-288): it is the elastic member of a row that has to survive a 313px
 * composer. What it cannot be is the ONLY place the fact exists — the tier, the
 * provider and the rest of the name were unreachable without changing the
 * selection to find out what it had been.
 */
describe("reading the whole selected model without changing it", () => {
  it("leads the open list with the tier, the model and the provider, in full", async () => {
    await renderPill({
      view: "all",
      defaults: { ...EMPTY_MODEL_ACCESS_DEFAULTS, fast: HAIKU },
      selectionTier: "Fast",
    });
    const identity = document.querySelector('[data-testid="model-pill-identity"]');
    expect(identity?.textContent).toContain("Fast · Claude Sonnet · Anthropic");
    // Wrapping, not an ellipsis: a reveal that truncates is the thing it was
    // opened to escape, and a popover has a width of its own to spend.
    expect(identity?.innerHTML).not.toContain("truncate");
  });

  it("says the same words the pill itself carries as its name", async () => {
    // One string, one function (`modelIdentityLabel`): a reveal that composed
    // its own could drift into describing a different selection than the
    // control it was opened from.
    await renderPill({ view: "all", defaults: EMPTY_MODEL_ACCESS_DEFAULTS, selectionTier: "Fast" });
    const pill = document.querySelector('[data-slot="popover-trigger"]');
    const identity = document.querySelector('[data-testid="model-pill-identity"]');
    expect(pill?.getAttribute("aria-label")).toBe("Model: Fast · Claude Sonnet · Anthropic");
    expect(identity?.textContent).toContain(pill?.getAttribute("title") ?? "");
  });
});

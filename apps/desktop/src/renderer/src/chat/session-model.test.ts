import type { SessionCapabilitySnapshot } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  composerIntent,
  deriveRuntimeCatalog,
  enqueueMessage,
  isPrimaryAgent,
  nextRelease,
  offersAgentChoice,
  primaryAgents,
  removeQueued,
  resolveRuntimeSelection,
  takeQueued,
  unqueueLast,
  type AgentVisibility,
} from "./session-model";

const snapshot: SessionCapabilitySnapshot = {
  id: "caps-1",
  adapterId: "opencode",
  attachmentId: "attachment-1",
  profileId: "native",
  revision: 3,
  observedAt: 10,
  expiresAt: null,
  features: [],
  catalog: [
    {
      kind: "model",
      id: "anthropic/disabled",
      label: "Disabled model",
      state: "unavailable",
      evidence: "reported",
      detail: { providerId: "anthropic", modelId: "disabled", variants: ["high"] },
    },
    {
      kind: "model",
      id: "openai/codex",
      label: "Codex",
      state: "available",
      evidence: "reported",
      detail: { providerId: "openai", modelId: "codex", variants: ["low", "high"] },
    },
    {
      kind: "agent",
      id: "plan",
      label: "Plan",
      state: "available",
      evidence: "reported",
      detail: { mode: "primary", description: "Read-only planning" },
    },
  ],
};

describe("native Session runtime picker", () => {
  it("derives provider, model, effort, and agent mode from reported capabilities", () => {
    expect(deriveRuntimeCatalog(snapshot)).toEqual({
      providers: ["openai"],
      models: [
        {
          id: "anthropic/disabled",
          label: "Disabled model",
          state: "unavailable",
          providerId: "anthropic",
          modelId: "disabled",
          variants: ["high"],
        },
        {
          id: "openai/codex",
          label: "Codex",
          state: "available",
          providerId: "openai",
          modelId: "codex",
          variants: ["low", "high"],
        },
      ],
      agents: [
        {
          id: "plan",
          label: "Plan",
          state: "available",
          mode: "primary",
          hidden: null,
          description: "Read-only planning",
        },
      ],
    });
  });

  it("carries the harness's own hidden flag through to the picker", () => {
    const catalog = deriveRuntimeCatalog({
      ...snapshot,
      catalog: [
        {
          kind: "agent",
          id: "compaction",
          label: "Compaction",
          state: "available",
          evidence: "reported",
          detail: { mode: "primary", hidden: true },
        },
      ],
    });
    expect(catalog.agents[0]?.hidden).toBe(true);
    expect(primaryAgents(catalog.agents)).toEqual([]);
  });

  it("keeps a valid choice and otherwise prefers an available runtime", () => {
    const catalog = deriveRuntimeCatalog(snapshot);
    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "missing",
        modelId: "missing",
        variant: "missing",
        agent: "missing",
      }),
    ).toEqual({ providerId: "openai", modelId: "codex", variant: "low", agent: "plan" });
    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "openai",
        modelId: "codex",
        variant: "high",
        agent: "plan",
      }),
    ).toEqual({ providerId: "openai", modelId: "codex", variant: "high", agent: "plan" });
  });

  it("does not submit through catalog entries the adapter reports as unavailable", () => {
    const catalog = deriveRuntimeCatalog({
      ...snapshot,
      catalog: snapshot.catalog.map((item) =>
        Object.assign({}, item, { state: "unavailable" as const }),
      ),
    });

    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "",
        modelId: "",
        variant: "",
        agent: "",
      }),
    ).toEqual({ providerId: "", modelId: "", variant: "", agent: "" });
  });

  it("defaults to an agent a person could have picked", () => {
    const catalog = {
      models: [],
      agents: [
        { id: "compaction", state: "available" as const, mode: "primary", hidden: true },
        { id: "explore", state: "available" as const, mode: "subagent" },
        { id: "build", state: "available" as const, mode: "primary" },
      ],
    };
    expect(
      resolveRuntimeSelection(catalog, {
        providerId: "",
        modelId: "",
        variant: "",
        agent: "",
      }).agent,
    ).toBe("build");
  });
});

describe("which agents a person may pick", () => {
  // OpenCode's own catalog: two primaries, two subagents, three hidden helpers.
  const catalog: (AgentVisibility & { id: string })[] = [
    { id: "build", mode: "primary" },
    { id: "plan", mode: "primary" },
    { id: "general", mode: "subagent" },
    { id: "explore", mode: "subagent" },
    { id: "compaction", mode: "primary", hidden: true },
    { id: "title", mode: null, hidden: true },
    { id: "summary", mode: null, hidden: true },
  ];

  it("filters on declared flags rather than a name list", () => {
    expect(primaryAgents(catalog).map((agent) => agent.id)).toEqual(["build", "plan"]);
  });

  it("treats a missing hidden flag as visible, so an unannotated harness still works", () => {
    expect(isPrimaryAgent({ mode: null })).toBe(true);
    expect(isPrimaryAgent({ mode: "primary", hidden: null })).toBe(true);
    expect(isPrimaryAgent({ mode: "primary", hidden: false })).toBe(true);
    expect(isPrimaryAgent({ mode: "subagent" })).toBe(false);
    expect(isPrimaryAgent({ mode: null, hidden: true })).toBe(false);
  });

  it("offers a mode control only when there is a genuine choice", () => {
    expect(offersAgentChoice(catalog)).toBe(true);
    expect(offersAgentChoice([{ mode: "primary" }])).toBe(false);
    expect(offersAgentChoice([{ mode: "primary" }, { mode: "subagent" }])).toBe(false);
    expect(offersAgentChoice([])).toBe(false);
  });
});

describe("composer delivery", () => {
  it("reads ⏎ against session state, not a delivery control", () => {
    expect(composerIntent({ working: false, steer: false })).toBe("send");
    // ⌘ is meaningless while nothing is running: there is no turn to steer.
    expect(composerIntent({ working: false, steer: true })).toBe("send");
    expect(composerIntent({ working: true, steer: false })).toBe("queue");
    expect(composerIntent({ working: true, steer: true })).toBe("steer");
  });

  it("trims on the way in and refuses blank", () => {
    expect(enqueueMessage([], { id: "a", text: "  ship it  " })).toEqual([
      { id: "a", text: "ship it" },
    ]);
    expect(enqueueMessage([], { id: "a", text: "   " })).toEqual([]);
  });

  it("gives an unqueued message back rather than dropping it", () => {
    const queue = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    expect(unqueueLast(queue)).toEqual({ queue: [{ id: "a", text: "first" }], text: "second" });
    expect(unqueueLast([])).toBeNull();
    expect(takeQueued(queue, "a")).toEqual({ queue: [{ id: "b", text: "second" }], text: "first" });
    expect(takeQueued(queue, "missing")).toBeNull();
    expect(removeQueued(queue, "a")).toEqual([{ id: "b", text: "second" }]);
  });

  it("drains one message, and only into an idle attached Session", () => {
    const queue = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    expect(nextRelease(queue, { working: false, ready: true })).toEqual({ id: "a", text: "first" });
    expect(nextRelease(queue, { working: true, ready: true })).toBeNull();
    expect(nextRelease(queue, { working: false, ready: false })).toBeNull();
    expect(nextRelease([], { working: false, ready: true })).toBeNull();
  });
});

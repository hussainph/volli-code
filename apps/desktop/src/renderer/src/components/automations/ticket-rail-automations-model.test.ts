import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, ColumnArming } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  modelOverrideRows,
  overridePressable,
  railRunLabel,
  RAIL_UNREAD_LABEL,
  ticketRailAutomations,
} from "./ticket-rail-automations-model";
import type { ComposerModel } from "@renderer/components/chat/composer-ui";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    projectId: "p1",
    name: "Review sweep",
    instructions: "/review",
    trigger: { kind: "columns", columns: ["doing"] },
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function arming(overrides: Partial<ColumnArming> = {}): ColumnArming {
  return { projectId: "p1", status: "doing", automationId: "a1", armedAt: 5, ...overrides };
}

function model(overrides: Partial<ComposerModel> = {}): ComposerModel {
  return {
    id: "anthropic/claude-opus",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-opus",
    label: "claude-opus",
    reasoningLevels: ["low", "high"],
    ...overrides,
  };
}

describe("ticketRailAutomations", () => {
  it("presses the Armed automation of this Ticket's own column", () => {
    const armed = automation();

    const rail = ticketRailAutomations({
      automations: [armed],
      armings: [arming()],
      status: "doing",
      ready: true,
    });

    expect(rail.primary).toEqual({ kind: "automation", automation: armed });
    expect(railRunLabel(rail.primary)).toBe("Review sweep");
  });

  it("presses Run once where the column arms nothing, so the button is never dead", () => {
    const rail = ticketRailAutomations({
      automations: [automation()],
      armings: [],
      status: "doing",
      ready: true,
    });

    expect(rail.primary).toEqual({ kind: "run-once" });
    expect(railRunLabel(rail.primary)).toBe("Run once");
    // Still offered here, even with nothing armed: the Offered list is the
    // record's Trigger, and arming is the column's separate choice.
    expect(rail.offered.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("reads an arming from another column as nothing armed here", () => {
    const rail = ticketRailAutomations({
      automations: [automation()],
      armings: [arming({ status: "todo" })],
      status: "doing",
      ready: true,
    });

    expect(rail.primary).toEqual({ kind: "run-once" });
  });

  it("offers this column's list with the armed one first", () => {
    const offeredFirst = automation({ id: "a2", name: "Alphabetically first" });
    const armed = automation();

    const rail = ticketRailAutomations({
      automations: [offeredFirst, armed],
      armings: [arming()],
      status: "doing",
      ready: true,
    });

    expect(rail.offered.map((entry) => entry.id)).toEqual(["a1", "a2"]);
  });

  it("offers nothing in a column no Trigger names, and still presses", () => {
    const rail = ticketRailAutomations({
      automations: [automation({ trigger: NO_AUTOMATION_TRIGGER })],
      armings: [],
      status: "doing",
      ready: true,
    });

    expect(rail.offered).toEqual([]);
    expect(rail.primary).toEqual({ kind: "run-once" });
    // The project DOES list one, so this is not the empty state — the rail's
    // sentence about an empty project must not appear here.
    expect(rail.listsAny).toBe(true);
  });

  it("says the project lists nothing, which is what the empty state is drawn from", () => {
    const rail = ticketRailAutomations({
      automations: [],
      armings: [],
      status: "doing",
      ready: true,
    });

    expect(rail.listsAny).toBe(false);
    expect(rail.offered).toEqual([]);
    // Run once needs no record, so an empty project still has a working press.
    expect(rail.primary).toEqual({ kind: "run-once" });
    expect(rail.ready).toBe(true);
  });

  it("presses nothing until the reads behind it have landed", () => {
    // The cache says the same thing whether this column arms nothing or nobody
    // has asked yet, so an unread rail answers neither: it says it is reading.
    const rail = ticketRailAutomations({
      automations: [automation()],
      armings: [arming()],
      status: "doing",
      ready: false,
    });

    expect(rail.ready).toBe(false);
    expect(rail.primary).toEqual({ kind: "unread" });
    expect(railRunLabel(rail.primary)).toBe(RAIL_UNREAD_LABEL);
    // Nothing offered and no claim about the project either: a menu row here
    // would be a record read from a cache nobody has filled.
    expect(rail.offered).toEqual([]);
    expect(rail.listsAny).toBe(false);
  });

  it("does not mistake an unread cache for an armed column that lost its record", () => {
    // The stale case the read exists for: this cache still holds the arming a
    // person removed in another window, and the rail must not press it.
    const stale = ticketRailAutomations({
      automations: [automation()],
      armings: [arming()],
      status: "doing",
      ready: false,
    });

    expect(stale.primary).not.toEqual({ kind: "automation", automation: automation() });
  });
});

describe("overridePressable", () => {
  it("offers the override wherever the default press is a Run", () => {
    const primary = { kind: "automation", automation: automation() } as const;

    expect(overridePressable(primary, true)).toBe(true);
    expect(overridePressable(primary, false)).toBe(true);
  });

  it("offers it for Run once only where there is a form to carry it into", () => {
    expect(overridePressable({ kind: "run-once" }, true)).toBe(true);
    // The board card has nowhere to type an Unbound Run, so an override there
    // would name a model for a Run that cannot be described.
    expect(overridePressable({ kind: "run-once" }, false)).toBe(false);
  });

  it("never offers it before the rail has read what it would run", () => {
    expect(overridePressable({ kind: "unread" }, true)).toBe(false);
    expect(overridePressable({ kind: "unread" }, false)).toBe(false);
  });
});

describe("modelOverrideRows", () => {
  it("offers every whole model-and-reasoning pair a model can run at", () => {
    expect(modelOverrideRows([model()])).toEqual([
      {
        model: model(),
        selections: [
          { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "low" },
          { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
        ],
      },
    ]);
  });

  it("drops a level the wire grammar cannot spell rather than sending it", () => {
    const rows = modelOverrideRows([model({ reasoningLevels: ["turbo", "high"] })]);

    expect(rows[0]?.selections).toEqual([
      { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
    ]);
  });

  it("does not offer a model left with no runnable level at all", () => {
    expect(modelOverrideRows([model({ reasoningLevels: ["turbo"] })])).toEqual([]);
    expect(modelOverrideRows([model({ reasoningLevels: [] })])).toEqual([]);
  });

  it("offers nothing when the catalog could not be read", () => {
    expect(modelOverrideRows([])).toEqual([]);
  });
});

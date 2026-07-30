import { describe, expect, it } from "vite-plus/test";

import {
  candidatesForColumn,
  digitFor,
  forgetAutomation,
  offeredForColumn,
  reorderInColumn,
  type ColumnOrder,
} from "./column-order";
import { SEEDED_AUTOMATIONS, type Automation } from "./model";

describe("offeredForColumn", () => {
  it("returns seed order when no ranking has been written", () => {
    const offered = offeredForColumn(SEEDED_AUTOMATIONS, "todo", {});
    expect(offered.map((automation) => automation.id)).toEqual(["atm-grill"]);
  });

  it("puts an explicit ranking ahead of newcomers", () => {
    const extras: Automation[] = [
      ...SEEDED_AUTOMATIONS,
      {
        id: "atm-extra",
        scope: "project",
        name: "Extra",
        trigger: { kind: "enters-column", columns: ["todo"] },
        steps: SEEDED_AUTOMATIONS[0].steps,
      },
    ];
    const order: ColumnOrder = { todo: ["atm-extra", "atm-grill"] };
    expect(offeredForColumn(extras, "todo", order).map((a) => a.id)).toEqual([
      "atm-extra",
      "atm-grill",
    ]);
  });

  it("skips ids that no longer exist", () => {
    const order: ColumnOrder = { doing: ["atm-gone", "atm-implement"] };
    expect(offeredForColumn(SEEDED_AUTOMATIONS, "doing", order).map((a) => a.id)).toEqual([
      "atm-implement",
    ]);
  });

  it("ignores off-board automations", () => {
    const ids = offeredForColumn(SEEDED_AUTOMATIONS, "backlog", {}).map((a) => a.id);
    expect(ids).not.toContain("atm-signals");
    expect(ids).not.toContain("atm-tdd");
    expect(candidatesForColumn(SEEDED_AUTOMATIONS, "backlog").map((a) => a.id)).toEqual([
      "atm-grill",
    ]);
  });
});

describe("reorderInColumn", () => {
  it("moves an id within the lane", () => {
    const automations: Automation[] = [
      {
        id: "a",
        scope: "project",
        name: "A",
        trigger: { kind: "enters-column", columns: ["doing"] },
        steps: SEEDED_AUTOMATIONS[0].steps,
      },
      {
        id: "b",
        scope: "project",
        name: "B",
        trigger: { kind: "enters-column", columns: ["doing"] },
        steps: SEEDED_AUTOMATIONS[0].steps,
      },
      {
        id: "c",
        scope: "project",
        name: "C",
        trigger: { kind: "enters-column", columns: ["doing"] },
        steps: SEEDED_AUTOMATIONS[0].steps,
      },
    ];
    const next = reorderInColumn(automations, {}, "doing", 0, 2);
    expect(next.doing).toEqual(["b", "c", "a"]);
    expect(digitFor(automations, "doing", next, "a")).toBe(3);
    expect(digitFor(automations, "doing", next, "b")).toBe(1);
  });

  it("lets the same automation hold different ranks in different columns", () => {
    const order = reorderInColumn(SEEDED_AUTOMATIONS, { backlog: ["atm-grill"] }, "todo", 0, 0);
    // Grill is alone in both; give Todo a second peer and rank grill below it.
    const withPeer: Automation[] = [
      ...SEEDED_AUTOMATIONS,
      {
        id: "atm-peer",
        scope: "project",
        name: "Peer",
        trigger: { kind: "enters-column", columns: ["todo"] },
        steps: SEEDED_AUTOMATIONS[0].steps,
      },
    ];
    const ranked = reorderInColumn(withPeer, order, "todo", 0, 1);
    expect(digitFor(withPeer, "backlog", ranked, "atm-grill")).toBe(1);
    expect(digitFor(withPeer, "todo", ranked, "atm-grill")).toBe(2);
    expect(digitFor(withPeer, "todo", ranked, "atm-peer")).toBe(1);
  });
});

describe("forgetAutomation", () => {
  it("strips an id from every lane", () => {
    const order: ColumnOrder = {
      backlog: ["atm-grill"],
      todo: ["atm-grill"],
      doing: ["atm-implement"],
    };
    expect(forgetAutomation(order, "atm-grill")).toEqual({ doing: ["atm-implement"] });
  });
});

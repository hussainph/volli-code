import { describe, expect, it } from "vite-plus/test";

import {
  candidatesForColumn,
  digitFor,
  forgetAutomation,
  offeredForColumn,
  offeredForColumnWithArming,
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
      "atm-standards",
    ]);
  });

  it("ignores off-board automations, and an empty column offers nothing", () => {
    const ids = offeredForColumn(SEEDED_AUTOMATIONS, "backlog", {}).map((a) => a.id);
    expect(ids).not.toContain("atm-signals");
    expect(ids).not.toContain("atm-tdd");
    // Backlog is the seeded empty column (VC-132's rig needs one on screen).
    expect(candidatesForColumn(SEEDED_AUTOMATIONS, "backlog")).toEqual([]);
  });
});

describe("offeredForColumnWithArming", () => {
  it("pins the armed automation to digit 1 ahead of the authored rank", () => {
    const order: ColumnOrder = { needs_review: ["atm-standards", "atm-review", "atm-spec"] };
    expect(
      offeredForColumnWithArming(SEEDED_AUTOMATIONS, "needs_review", order, "atm-review").map(
        (a) => a.id,
      ),
    ).toEqual(["atm-review", "atm-standards", "atm-spec"]);
  });

  it("is the plain offered list when the column is unarmed", () => {
    const order: ColumnOrder = { needs_review: ["atm-standards", "atm-review", "atm-spec"] };
    expect(
      offeredForColumnWithArming(SEEDED_AUTOMATIONS, "needs_review", order, undefined),
    ).toEqual(offeredForColumn(SEEDED_AUTOMATIONS, "needs_review", order));
  });

  it("ignores an armed id the column does not offer (stale arming)", () => {
    expect(
      offeredForColumnWithArming(SEEDED_AUTOMATIONS, "doing", {}, "atm-review").map((a) => a.id),
    ).toEqual(["atm-implement", "atm-standards"]);
  });

  it("pins before the digit cap, so an armed automation ranked past 9 keeps digit 1", () => {
    const crowd: Automation[] = Array.from({ length: 10 }, (_, i) => ({
      id: `atm-crowd-${i}`,
      scope: "project",
      name: `Crowd ${i}`,
      trigger: { kind: "enters-column", columns: ["doing"] },
      steps: SEEDED_AUTOMATIONS[0].steps,
    }));
    const pinned = offeredForColumnWithArming(crowd, "doing", {}, "atm-crowd-9").map((a) => a.id);
    expect(pinned).toHaveLength(9);
    expect(pinned[0]).toBe("atm-crowd-9");
    // The cap still holds — the pin displaces the tail, never widens the list.
    expect(pinned).not.toContain("atm-crowd-8");
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
    // Standards sweep is seeded into Doing and Needs Review. Rank it first in
    // Needs Review and it still reads second in Doing — one record, two digits.
    const ranked = reorderInColumn(SEEDED_AUTOMATIONS, {}, "needs_review", 1, 0);
    expect(digitFor(SEEDED_AUTOMATIONS, "needs_review", ranked, "atm-standards")).toBe(1);
    expect(digitFor(SEEDED_AUTOMATIONS, "doing", ranked, "atm-standards")).toBe(2);
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

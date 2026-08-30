import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessSnapshot, ModelSelection } from "./agent-runtime";

import {
  ARMED_RUN_DELAY_MS,
  armedAutomationFor,
  automationDraftProblem,
  automationOwnership,
  automationPinProblem,
  automationTriggerColumns,
  automationTriggersColumn,
  columnRankAfterLaneDrop,
  effectiveArmedAutomationFor,
  isAutomationRuntimePin,
  isColumnArrival,
  MAX_OFFERED_DIGITS,
  NO_AUTOMATION_TRIGGER,
  offeredAutomationsForColumn,
  offeredAutomationsInDigitOrder,
  parseAutomationTrigger,
  type Automation,
  type ColumnArming,
} from "./automation";

const PIN: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus",
  reasoningLevel: "high",
};

function snapshot(models: ModelAccessSnapshot["models"]): ModelAccessSnapshot {
  return { observedAt: 0, providers: [], models };
}

function accessModel(
  overrides: Partial<ModelAccessSnapshot["models"][number]> = {},
): ModelAccessSnapshot["models"][number] {
  return {
    providerId: PIN.providerId,
    modelId: PIN.modelId,
    label: "Claude Opus",
    state: "available",
    reasoningLevels: ["medium", "high"],
    acceptsImageInput: true,
    ...overrides,
  };
}

describe("automationOwnership", () => {
  it("reads a null projectId as global and a set one as project", () => {
    expect(automationOwnership({ projectId: null })).toBe("global");
    expect(automationOwnership({ projectId: "p1" })).toBe("project");
  });
});

describe("isAutomationRuntimePin", () => {
  it("distinguishes a complete pin from inherit and an invalid stored Runtime", () => {
    expect(isAutomationRuntimePin(PIN)).toBe(true);
    expect(isAutomationRuntimePin(null)).toBe(false);
    expect(isAutomationRuntimePin({ kind: "invalid", raw: { providerId: "anthropic" } })).toBe(
      false,
    );
  });
});

describe("automationDraftProblem", () => {
  it("accepts a named draft with Instructions", () => {
    expect(automationDraftProblem({ name: "Review", instructions: "/tdd go" })).toBeNull();
  });

  it("refuses a blank name, including whitespace-only", () => {
    expect(automationDraftProblem({ name: "", instructions: "x" })).toMatch(/Name/);
    expect(automationDraftProblem({ name: "   ", instructions: "x" })).toMatch(/Name/);
  });

  it("refuses blank Instructions — a Run would have nothing to say", () => {
    expect(automationDraftProblem({ name: "Review", instructions: "" })).toMatch(/Instructions/);
    expect(automationDraftProblem({ name: "Review", instructions: "\n " })).toMatch(/Instructions/);
  });
});

describe("automationPinProblem", () => {
  it("accepts a pin the catalog can run at that reasoning level", () => {
    expect(automationPinProblem(snapshot([accessModel()]), PIN)).toBeNull();
  });

  it("refuses a model the catalog does not know", () => {
    expect(automationPinProblem(snapshot([]), PIN)).toMatch(/not currently available/);
  });

  it("refuses an unavailable model", () => {
    expect(automationPinProblem(snapshot([accessModel({ state: "unavailable" })]), PIN)).toMatch(
      /not currently available/,
    );
  });

  it("asks for sign-in when the provider needs it, rather than storing a dead pin", () => {
    expect(
      automationPinProblem(snapshot([accessModel({ state: "authentication-required" })]), PIN),
    ).toMatch(/Sign in/);
  });

  it("refuses a reasoning level the model's own scale does not offer, naming the valid ones", () => {
    const problem = automationPinProblem(
      snapshot([accessModel({ reasoningLevels: ["low", "medium"] })]),
      PIN,
    );
    expect(problem).toMatch(/"high"/);
    expect(problem).toMatch(/low, medium/);
  });
});

/* ---------------------------------------- column Trigger + arming (VC-128) - */

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    projectId: "p1",
    name: "Review sweep",
    instructions: "/review",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function arming(overrides: Partial<ColumnArming> = {}): ColumnArming {
  return { projectId: "p1", status: "doing", automationId: "a1", armedAt: 10, ...overrides };
}

describe("parseAutomationTrigger", () => {
  it("reads a column Trigger and orders its columns as the board reads them", () => {
    expect(parseAutomationTrigger({ kind: "columns", columns: ["done", "todo"] })).toEqual({
      kind: "columns",
      columns: ["todo", "done"],
    });
  });

  it("drops duplicates and column names this build does not know", () => {
    expect(
      parseAutomationTrigger({ kind: "columns", columns: ["doing", "doing", "shipped", 7] }),
    ).toEqual({ kind: "columns", columns: ["doing"] });
  });

  it("collapses a column Trigger that names nothing to the no-Trigger answer", () => {
    expect(parseAutomationTrigger({ kind: "columns", columns: [] })).toEqual(NO_AUTOMATION_TRIGGER);
    expect(parseAutomationTrigger({ kind: "columns", columns: ["nope"] })).toEqual(
      NO_AUTOMATION_TRIGGER,
    );
  });

  it("degrades every unreadable stored value to firing nothing", () => {
    for (const raw of [
      null,
      undefined,
      4,
      "columns",
      [],
      {},
      // A Trigger this build has no arm for — a schedule, once VC-130 ships and
      // an older build reads a newer record.
      { kind: "schedule" },
      // The right kind carrying the wrong shape.
      { kind: "columns" },
      { kind: "columns", columns: "doing" },
    ]) {
      expect(parseAutomationTrigger(raw)).toEqual(NO_AUTOMATION_TRIGGER);
    }
  });
});

describe("automationTriggerColumns / automationTriggersColumn", () => {
  it("reports the named columns, and nothing for a Trigger that names none", () => {
    const trigger = parseAutomationTrigger({ kind: "columns", columns: ["doing"] });
    expect(automationTriggerColumns(trigger)).toEqual(["doing"]);
    expect(automationTriggerColumns(NO_AUTOMATION_TRIGGER)).toEqual([]);
  });

  it("answers offering per column, so one record can be offered in two and not a third", () => {
    const offered = automation({
      trigger: { kind: "columns", columns: ["doing", "needs_review"] },
    });
    expect(automationTriggersColumn(offered, "doing")).toBe(true);
    expect(automationTriggersColumn(offered, "needs_review")).toBe(true);
    expect(automationTriggersColumn(offered, "done")).toBe(false);
    expect(automationTriggersColumn(automation(), "doing")).toBe(false);
  });
});

describe("offeredAutomationsForColumn", () => {
  const inDoing = automation({ id: "a1", trigger: { kind: "columns", columns: ["doing"] } });
  const alsoDoing = automation({ id: "a2", trigger: { kind: "columns", columns: ["doing"] } });
  const elsewhere = automation({ id: "a3", trigger: { kind: "columns", columns: ["done"] } });

  it("offers exactly the Automations whose Trigger names the column", () => {
    expect(
      offeredAutomationsForColumn(
        [inDoing, alsoDoing, elsewhere, automation({ id: "a4" })],
        "doing",
      ),
    ).toEqual([inDoing, alsoDoing]);
  });

  it("reads the column's authored rank first, then whatever order it was handed", () => {
    expect(offeredAutomationsForColumn([inDoing, alsoDoing], "doing", ["a2"])).toEqual([
      alsoDoing,
      inDoing,
    ]);
  });

  it("ignores a ranked id this column does not offer, and one named twice", () => {
    expect(offeredAutomationsForColumn([inDoing], "doing", ["a3", "a1", "a1"])).toEqual([inDoing]);
  });

  it("is uncapped, so a tenth Offered row is still armable", () => {
    const crowd = Array.from({ length: 12 }, (_, index) =>
      automation({ id: `a${index}`, trigger: { kind: "columns", columns: ["doing"] } }),
    );
    expect(offeredAutomationsForColumn(crowd, "doing")).toHaveLength(12);
  });
});

describe("offeredAutomationsInDigitOrder", () => {
  const first = automation({ id: "a1", trigger: { kind: "columns", columns: ["doing"] } });
  const second = automation({ id: "a2", trigger: { kind: "columns", columns: ["doing"] } });
  const third = automation({ id: "a3", trigger: { kind: "columns", columns: ["doing"] } });

  it("reads the authored rank when the column arms nothing effective", () => {
    expect(
      offeredAutomationsInDigitOrder({
        automations: [first, second, third],
        status: "doing",
        rankedAutomationIds: ["a3", "a1"],
      }).map((row) => row.id),
    ).toEqual(["a3", "a1", "a2"]);
  });

  it("pins the effective armed Automation to digit 1 ahead of the authored rank", () => {
    expect(
      offeredAutomationsInDigitOrder({
        automations: [first, second, third],
        status: "doing",
        rankedAutomationIds: ["a3", "a1", "a2"],
        effectiveArmedAutomationId: "a2",
      }).map((row) => row.id),
    ).toEqual(["a2", "a3", "a1"]);
  });

  it("ignores an armed id this column does not offer (stale arming)", () => {
    expect(
      offeredAutomationsInDigitOrder({
        automations: [first, second],
        status: "doing",
        effectiveArmedAutomationId: "gone",
      }).map((row) => row.id),
    ).toEqual(["a1", "a2"]);
  });

  it("pins BEFORE the nine-digit cap, so an armed row ranked past nine keeps digit 1", () => {
    const crowd = Array.from({ length: 10 }, (_, index) =>
      automation({ id: `c${index}`, trigger: { kind: "columns", columns: ["doing"] } }),
    );
    const digits = offeredAutomationsInDigitOrder({
      automations: crowd,
      status: "doing",
      effectiveArmedAutomationId: "c9",
    }).map((row) => row.id);
    expect(digits).toHaveLength(MAX_OFFERED_DIGITS);
    expect(digits[0]).toBe("c9");
    // The cap still holds: the pin displaces the tail, it never widens the list.
    expect(digits).not.toContain("c8");
  });

  it("lets one Automation hold a different rank in two columns", () => {
    const both = automation({
      id: "shared",
      trigger: { kind: "columns", columns: ["doing", "needs_review"] },
    });
    const doingOnly = automation({ id: "d1", trigger: { kind: "columns", columns: ["doing"] } });
    const reviewOnly = automation({
      id: "r1",
      trigger: { kind: "columns", columns: ["needs_review"] },
    });
    const automations = [both, doingOnly, reviewOnly];
    expect(
      offeredAutomationsInDigitOrder({
        automations,
        status: "doing",
        rankedAutomationIds: ["d1", "shared"],
      }).map((row) => row.id),
    ).toEqual(["d1", "shared"]);
    expect(
      offeredAutomationsInDigitOrder({
        automations,
        status: "needs_review",
        rankedAutomationIds: ["shared", "r1"],
      }).map((row) => row.id),
    ).toEqual(["shared", "r1"]);
  });
});

describe("columnRankAfterLaneDrop", () => {
  it("refills the slots the lane moved and leaves every other slot alone", () => {
    expect(columnRankAfterLaneDrop(["a", "b", "c"], ["c", "b", "a"])).toEqual(["c", "b", "a"]);
  });

  it("keeps a pinned row's authored rank, so disarming returns it there", () => {
    // "b" is armed and drawn at slot 1, so the lane never moves it: only "a"
    // and "c" are draggable, and swapping them must not disturb b's own rank.
    expect(columnRankAfterLaneDrop(["a", "b", "c"], ["c", "a"])).toEqual(["c", "b", "a"]);
  });

  it("keeps rows past the digit cap where they were, under rows they cannot see", () => {
    expect(columnRankAfterLaneDrop(["a", "b", "tenth"], ["b", "a"])).toEqual(["b", "a", "tenth"]);
  });

  it("drops an id the authored list does not hold", () => {
    expect(columnRankAfterLaneDrop(["a", "b"], ["b", "gone", "a"])).toEqual(["b", "a"]);
  });
});

describe("effectiveArmedAutomationFor", () => {
  const armedRecord = automation({ trigger: { kind: "columns", columns: ["doing"] } });

  it("is the armed record when this machine has it switched on", () => {
    expect(
      effectiveArmedAutomationFor({
        automations: [armedRecord],
        armings: [arming()],
        enabledAutomationIds: ["a1"],
        status: "doing",
      }),
    ).toBe(armedRecord);
  });

  it("is null when the armed record is switched off here — a plain drop runs nothing", () => {
    expect(
      effectiveArmedAutomationFor({
        automations: [armedRecord],
        armings: [arming()],
        enabledAutomationIds: [],
        status: "doing",
      }),
    ).toBeNull();
  });

  it("is null for an unarmed column", () => {
    expect(
      effectiveArmedAutomationFor({
        automations: [armedRecord],
        armings: [],
        enabledAutomationIds: ["a1"],
        status: "doing",
      }),
    ).toBeNull();
  });
});

describe("armedAutomationFor", () => {
  const armedRecord = automation({ trigger: { kind: "columns", columns: ["doing"] } });

  it("resolves the column's one Armed automation", () => {
    expect(armedAutomationFor([armedRecord], [arming()], "doing")).toBe(armedRecord);
  });

  it("reads an unarmed column as null, so an arrival there is a pure status change", () => {
    expect(armedAutomationFor([armedRecord], [], "doing")).toBeNull();
    expect(armedAutomationFor([armedRecord], [arming()], "todo")).toBeNull();
  });

  it("treats an arming naming a deleted Automation as inert", () => {
    expect(armedAutomationFor([], [arming()], "doing")).toBeNull();
  });

  it("disarms when the Trigger no longer offers that column", () => {
    expect(armedAutomationFor([automation()], [arming()], "doing")).toBeNull();
  });
});

describe("isColumnArrival", () => {
  it("is an arrival only when the column actually changes", () => {
    expect(isColumnArrival("todo", "doing")).toBe(true);
    expect(isColumnArrival("doing", "doing")).toBe(false);
  });
});

describe("ARMED_RUN_DELAY_MS", () => {
  it("is the 3500 ms VC-112 ruled, stated once for every surface", () => {
    expect(ARMED_RUN_DELAY_MS).toBe(3500);
  });
});

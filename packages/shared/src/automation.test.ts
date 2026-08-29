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
  isAutomationRuntimePin,
  isColumnArrival,
  NO_AUTOMATION_TRIGGER,
  offeredAutomationsForColumn,
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
        null,
      ),
    ).toEqual([inDoing, alsoDoing]);
  });

  it("puts the column's Armed automation first, keeping the rest in order", () => {
    expect(offeredAutomationsForColumn([inDoing, alsoDoing], "doing", "a2")).toEqual([
      alsoDoing,
      inDoing,
    ]);
  });

  it("ignores an armed id that is not offered here", () => {
    expect(offeredAutomationsForColumn([inDoing], "doing", "a3")).toEqual([inDoing]);
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

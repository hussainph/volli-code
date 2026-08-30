import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessSnapshot, ModelSelection } from "./agent-runtime";

import {
  ARMED_RUN_DELAY_MS,
  armedAutomationFor,
  automationDraftProblem,
  automationOwnership,
  automationPinProblem,
  automationScheduleProblem,
  automationTriggerColumns,
  automationTriggerSchedule,
  automationTriggersColumn,
  isAutomationRuntimePin,
  isColumnArrival,
  NO_AUTOMATION_TRIGGER,
  offeredAutomationsForColumn,
  parseAutomationSkipReason,
  parseAutomationTrigger,
  type Automation,
  type AutomationTrigger,
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
      // A Trigger kind this build has no arm for at all.
      { kind: "webhook" },
      // The right kind carrying the wrong shape.
      { kind: "columns" },
      { kind: "columns", columns: "doing" },
      { kind: "schedule" },
      { kind: "schedule", schedule: { preset: "daily", hour: 9, minute: 0 } },
      // A zone this build's ICU cannot resolve. Repairing it would start
      // unattended work at a time nobody chose.
      {
        kind: "schedule",
        schedule: { preset: "daily", hour: 9, minute: 0, timeZone: "Mars/Olympus" },
      },
    ]) {
      expect(parseAutomationTrigger(raw)).toEqual(NO_AUTOMATION_TRIGGER);
    }
  });

  it("reads a schedule Trigger and keeps its stored zone (VC-130)", () => {
    expect(
      parseAutomationTrigger({
        kind: "schedule",
        schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
      }),
    ).toEqual({
      kind: "schedule",
      schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
    });
  });
});

describe("automationTriggerSchedule", () => {
  const schedule = {
    preset: "weekly",
    weekday: "monday",
    hour: 8,
    minute: 0,
    timeZone: "UTC",
  } as const;

  it("answers the schedule a Trigger carries, and null for every other arm", () => {
    expect(automationTriggerSchedule({ kind: "schedule", schedule })).toEqual(schedule);
    expect(automationTriggerSchedule(NO_AUTOMATION_TRIGGER)).toBeNull();
    expect(automationTriggerSchedule({ kind: "columns", columns: ["doing"] })).toBeNull();
  });

  it("leaves a schedule Trigger out of every column question", () => {
    // The two arms are not interchangeable: a schedule names the Project, so
    // it is offered in no column and can arm none.
    const scheduled = automation({ trigger: { kind: "schedule", schedule } });
    expect(automationTriggerColumns(scheduled.trigger)).toEqual([]);
    expect(automationTriggersColumn(scheduled, "doing")).toBe(false);
    expect(offeredAutomationsForColumn([scheduled], "doing", null)).toEqual([]);
    expect(armedAutomationFor([scheduled], [arming()], "doing")).toBeNull();
  });
});

describe("automationScheduleProblem", () => {
  const scheduled: AutomationTrigger = {
    kind: "schedule",
    schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
  };

  it("accepts a schedule on a project-owned Automation", () => {
    expect(automationScheduleProblem({ projectId: "p1", trigger: scheduled })).toBeNull();
  });

  it("refuses a schedule on a globally listed Automation, and names the way out", () => {
    // A schedule Run's Target is the Project, and a global record belongs to
    // none: firing in every project would be the launch backlog VC-130 forbids.
    const problem = automationScheduleProblem({ projectId: null, trigger: scheduled });
    expect(problem).toMatch(/one project/);
    expect(problem).toMatch(/Duplicate/);
  });

  it("has nothing to say about the other Triggers, at either Ownership", () => {
    expect(
      automationScheduleProblem({ projectId: null, trigger: NO_AUTOMATION_TRIGGER }),
    ).toBeNull();
    expect(
      automationScheduleProblem({
        projectId: null,
        trigger: { kind: "columns", columns: ["doing"] },
      }),
    ).toBeNull();
  });
});

describe("parseAutomationSkipReason", () => {
  it("reads the three reasons a schedule actually records", () => {
    expect(parseAutomationSkipReason({ kind: "app-closed" })).toEqual({ kind: "app-closed" });
    // The app WAS running and still did not reach the due time — a sleeping
    // machine, a suspended process. Its own reason, because recording it as
    // "app-closed" would be recording something false.
    expect(parseAutomationSkipReason({ kind: "not-observed" })).toEqual({ kind: "not-observed" });
    expect(
      parseAutomationSkipReason({ kind: "run-refused", code: "MODEL_REQUIRED", error: "No model" }),
    ).toEqual({ kind: "run-refused", code: "MODEL_REQUIRED", error: "No model" });
  });

  it("keeps a refusal code this build no longer knows, verbatim", () => {
    // Historical evidence, like a Run's recorded reasoning level: printed as
    // recorded rather than rewritten into today's vocabulary.
    expect(
      parseAutomationSkipReason({ kind: "run-refused", code: "QUOTA_EXHAUSTED", error: "Later" }),
    ).toEqual({ kind: "run-refused", code: "QUOTA_EXHAUSTED", error: "Later" });
  });

  it("still reads as a skip when the reason itself is unreadable", () => {
    // Never invented as "app-closed": the cause is unknown, but a skip that
    // degraded into a silence is the one outcome VC-112 forbids.
    for (const raw of [
      null,
      "app-closed",
      {},
      { kind: "nope" },
      { kind: "run-refused" },
      { kind: "run-refused", code: 7, error: "x" },
      { kind: "run-refused", code: "X", error: null },
    ]) {
      expect(parseAutomationSkipReason(raw)).toEqual({ kind: "unknown" });
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

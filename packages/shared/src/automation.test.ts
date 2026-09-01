import { describe, expect, it } from "vite-plus/test";
import type { ModelAccessSnapshot, ModelSelection } from "./agent-runtime";

import {
  ARMED_RUN_DELAY_MS,
  armedAutomationFor,
  AUTOMATION_RUN_ATTENDANCE,
  automationDraftProblem,
  automationOwnership,
  isAutomationRunAttendance,
  parseAutomationRunAttendance,
  automationPinProblem,
  automationRunRequestIdentity,
  automationRunRetryKey,
  automationRunTargetId,
  automationScheduleProblem,
  automationTriggerColumns,
  automationTriggerSchedule,
  automationTriggersColumn,
  columnRankAfterLaneDrop,
  effectiveArmedAutomationFor,
  isAutomationRuntimePin,
  isColumnArrival,
  MAX_OFFERED_DIGITS,
  NO_AUTOMATION_TRIGGER,
  offeredAutomationsForColumn,
  offeredAutomationsInDigitOrder,
  parseAutomationSkipReason,
  parseAutomationTrigger,
  sameAutomationRunRequestIdentity,
  UNBOUND_RUN_LABEL,
  unboundRunProblem,
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
    expect(offeredAutomationsForColumn([scheduled], "doing")).toEqual([]);
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

describe("automationRunTargetId", () => {
  it("names the Automation a bound Run runs", () => {
    expect(automationRunTargetId({ kind: "automation", automationId: "a1" })).toBe("a1");
  });

  it("names none for an Unbound Run, which is what its own record stores", () => {
    expect(automationRunTargetId({ kind: "unbound", instructions: "/sweep" })).toBeNull();
  });
});

describe("unboundRunProblem", () => {
  it("accepts Instructions with something in them", () => {
    expect(unboundRunProblem("/sweep the diff")).toBeNull();
  });

  it("refuses blank Instructions, as the saved record's own rule does", () => {
    expect(unboundRunProblem("")).toContain("Write Instructions");
    expect(unboundRunProblem("   \n\t ")).toContain("Write Instructions");
  });
});

describe("UNBOUND_RUN_LABEL", () => {
  it("is the one name an Unbound Run wears on every surface", () => {
    expect(UNBOUND_RUN_LABEL).toBe("Run once");
  });
});

describe("one Run request's identity", () => {
  const OPUS = { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" } as const;
  const GPT = { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" } as const;

  it("reads a bound Run as its record plus this invocation's override", () => {
    expect(
      automationRunRequestIdentity({
        target: { kind: "automation", automationId: "a1" },
        modelOverride: OPUS,
      }),
    ).toEqual({ instructions: null, modelOverride: OPUS });
  });

  it("reads an Unbound Run as the words it carries", () => {
    expect(
      automationRunRequestIdentity({
        target: { kind: "unbound", instructions: "/sweep" },
        modelOverride: null,
      }),
    ).toEqual({ instructions: "/sweep", modelOverride: null });
  });

  it("is the same intent when both halves match", () => {
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: "/sweep", modelOverride: OPUS },
        { instructions: "/sweep", modelOverride: { ...OPUS } },
      ),
    ).toBe(true);
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: null },
        { instructions: null, modelOverride: null },
      ),
    ).toBe(true);
  });

  it("is a different intent when the Instructions changed", () => {
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: "/sweep", modelOverride: null },
        { instructions: "/sweep twice", modelOverride: null },
      ),
    ).toBe(false);
  });

  it("is a different intent when the override changed, in either direction", () => {
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: OPUS },
        { instructions: null, modelOverride: GPT },
      ),
    ).toBe(false);
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: OPUS },
        { instructions: null, modelOverride: { ...OPUS, reasoningLevel: "low" } },
      ),
    ).toBe(false);
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: null },
        { instructions: null, modelOverride: OPUS },
      ),
    ).toBe(false);
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: OPUS },
        { instructions: null, modelOverride: null },
      ),
    ).toBe(false);
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: { ...OPUS, modelId: "claude-sonnet" } },
        { instructions: null, modelOverride: OPUS },
      ),
    ).toBe(false);
    expect(
      sameAutomationRunRequestIdentity(
        { instructions: null, modelOverride: { ...OPUS, providerId: "openai" } },
        { instructions: null, modelOverride: OPUS },
      ),
    ).toBe(false);
  });

  it("files a retry under the whole intent, never under the Ticket alone", () => {
    const bound = { kind: "automation", automationId: "a1" } as const;
    expect(automationRunRetryKey({ target: bound, ticketId: "t1", modelOverride: null })).toBe(
      automationRunRetryKey({ target: bound, ticketId: "t1", modelOverride: null }),
    );
    // A different model is a second Run, so it must not find the first one's id.
    expect(automationRunRetryKey({ target: bound, ticketId: "t1", modelOverride: OPUS })).not.toBe(
      automationRunRetryKey({ target: bound, ticketId: "t1", modelOverride: null }),
    );
    expect(automationRunRetryKey({ target: bound, ticketId: "t1", modelOverride: OPUS })).not.toBe(
      automationRunRetryKey({ target: bound, ticketId: "t1", modelOverride: GPT }),
    );
    // Edited Instructions are a second Run for the same reason.
    expect(
      automationRunRetryKey({
        target: { kind: "unbound", instructions: "/sweep" },
        ticketId: "t1",
        modelOverride: null,
      }),
    ).not.toBe(
      automationRunRetryKey({
        target: { kind: "unbound", instructions: "/sweep twice" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
    // And the same words on ANOTHER Ticket are another Run again.
    expect(
      automationRunRetryKey({
        target: { kind: "unbound", instructions: "/sweep" },
        ticketId: "t1",
        modelOverride: null,
      }),
    ).not.toBe(
      automationRunRetryKey({
        target: { kind: "unbound", instructions: "/sweep" },
        ticketId: "t2",
        modelOverride: null,
      }),
    );
  });
});

describe("automation Run attendance", () => {
  it("names the two answers a door can give", () => {
    expect([...AUTOMATION_RUN_ATTENDANCE]).toEqual(["attended", "unattended"]);
  });

  it("recognises its own words and nothing else", () => {
    expect(isAutomationRunAttendance("attended")).toBe(true);
    expect(isAutomationRunAttendance("unattended")).toBe(true);
    expect(isAutomationRunAttendance("scheduled")).toBe(false);
    expect(isAutomationRunAttendance(null)).toBe(false);
    expect(isAutomationRunAttendance(undefined)).toBe(false);
    expect(isAutomationRunAttendance(1)).toBe(false);
  });

  it("reads anything it cannot understand as attended, which never notifies", () => {
    // The degrade direction is the whole decision here. A Run recorded before
    // VC-133 says nothing about its door; reading that as `unattended` would
    // notify about work somebody is already watching, and VC-112 is explicit
    // that this is how a person learns to switch a feature off. A wrong
    // `attended` costs one missed notification on a historical Run.
    expect(parseAutomationRunAttendance(undefined)).toBe("attended");
    expect(parseAutomationRunAttendance(null)).toBe("attended");
    expect(parseAutomationRunAttendance("")).toBe("attended");
    expect(parseAutomationRunAttendance("UNATTENDED")).toBe("attended");
    expect(parseAutomationRunAttendance({})).toBe("attended");
  });

  it("passes through the two it does understand", () => {
    expect(parseAutomationRunAttendance("attended")).toBe("attended");
    expect(parseAutomationRunAttendance("unattended")).toBe("unattended");
  });
});

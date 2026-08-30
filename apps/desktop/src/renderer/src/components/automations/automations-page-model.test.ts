import { describe, expect, it } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, AutomationRun, AutomationSkippedOccurrence } from "@volli/shared";

import {
  INSTRUCTIONS_PLACEHOLDER,
  MANUAL_TRIGGER_LABEL,
  automationHistory,
  duplicateName,
  groupByOwnership,
  listingRunTarget,
  ownershipLabel,
  runAutomationLabel,
  runModelLabel,
  runModelTitle,
  runtimeLabel,
  skipCountLabel,
  skipReasonLabel,
  triggerLabel,
} from "./automations-page-model";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review",
    instructions: "/review go",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "automation-1",
    automationName: "Review",
    ticketId: "t1",
    sessionId: "s1",
    model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
    attendance: "attended",
    createdAt: 10,
    ...overrides,
  };
}

describe("vocabulary", () => {
  it("names the default Trigger as a complete answer, not an absent one", () => {
    expect(MANUAL_TRIGGER_LABEL).toBe("Only when I run it");
  });

  it("pushes the Instructions placeholder toward /skill rather than prose", () => {
    expect(INSTRUCTIONS_PLACEHOLDER.startsWith("/skill")).toBe(true);
    expect(INSTRUCTIONS_PLACEHOLDER).toContain("@");
  });
});

describe("ownershipLabel", () => {
  it("names the two places an Automation can be listed", () => {
    expect(ownershipLabel(automation())).toBe("This project");
    expect(ownershipLabel(automation({ projectId: null }))).toBe("All projects");
  });
});

describe("triggerLabel", () => {
  it("says the manual sentence when the Trigger names no column", () => {
    expect(triggerLabel(NO_AUTOMATION_TRIGGER)).toBe(MANUAL_TRIGGER_LABEL);
  });

  it("names the columns a column Trigger actually names, in the board's own words", () => {
    expect(triggerLabel({ kind: "columns", columns: ["doing"] })).toBe("Ticket enters Doing");
    expect(triggerLabel({ kind: "columns", columns: ["doing", "needs_review"] })).toBe(
      "Ticket enters Doing, Needs Review",
    );
  });

  it("degrades a column Trigger that ended up naming nothing to the manual sentence", () => {
    // The record cannot hold this — the parser collapses it on the way in — but
    // a row that printed "Ticket enters" with nothing after it would be a page
    // saying less than nothing, so the label answers for the shape too.
    expect(triggerLabel({ kind: "columns", columns: [] })).toBe(MANUAL_TRIGGER_LABEL);
  });
});

describe("runtimeLabel", () => {
  it("says inherit as a sentence rather than leaving a blank", () => {
    expect(runtimeLabel(null)).toBe("Default model");
  });

  it("prints a pin as one model-and-reasoning pair, never half of it", () => {
    expect(
      runtimeLabel({ providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" }),
    ).toBe("claude-opus · high");
  });

  it("says a corrupt stored Runtime is unreadable instead of reading it as inherit", () => {
    // The whole reason `InvalidAutomationRuntime` exists: coercing it to null
    // would silently change a saved Automation's execution policy.
    expect(runtimeLabel({ kind: "invalid", raw: { model: "gpt-9" } })).toBe("Unreadable runtime");
  });
});

describe("a Run prints its own evidence", () => {
  it("shows the model and reasoning it resolved at launch", () => {
    expect(runModelLabel(run())).toBe("claude-opus · high");
    expect(runModelTitle(run())).toBe("anthropic / claude-opus · high");
  });

  it("prints a level a current build no longer knows exactly as recorded", () => {
    const historical = run({
      model: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "galactic" },
    });
    expect(runModelLabel(historical)).toBe("gpt-5 · galactic");
  });

  it("keeps the Automation name a deleted record left behind", () => {
    expect(runAutomationLabel(run())).toBe("Review");
    expect(runAutomationLabel(run({ automationId: null, automationName: null }))).toBe("Run once");
  });
});

describe("groupByOwnership", () => {
  it("splits the list without re-sorting either half", () => {
    const own = [automation({ id: "a" }), automation({ id: "b", name: "Aardvark" })];
    const global = [automation({ id: "g", projectId: null })];
    expect(groupByOwnership([...own, ...global])).toEqual({ project: own, global });
  });

  it("answers two empty halves for an empty list", () => {
    expect(groupByOwnership([])).toEqual({ project: [], global: [] });
  });
});

describe("duplicateName", () => {
  it("makes the copy distinguishable at a glance and sorts it beside its source", () => {
    expect(duplicateName("Review", ["Review"])).toBe("Review (copy)");
  });

  it("counts from 2, so duplicating the duplicate does not collide either", () => {
    expect(duplicateName("Review", ["Review", "Review (copy)"])).toBe("Review (copy 2)");
    expect(duplicateName("Review", ["Review", "Review (copy)", "Review (copy 2)"])).toBe(
      "Review (copy 3)",
    );
  });

  it("takes the plain suffix when nothing has claimed it", () => {
    expect(duplicateName("Review", [])).toBe("Review (copy)");
  });
});

/* ------------------------------- schedules (VC-130) ----------------------- */

function skip(overrides: Partial<AutomationSkippedOccurrence> = {}): AutomationSkippedOccurrence {
  return {
    id: "skip-1",
    automationId: "automation-1",
    automationName: "Nightly sweep",
    projectId: "p1",
    dueAt: 500,
    missedCount: 1,
    reason: { kind: "app-closed" },
    recordedAt: 900,
    ...overrides,
  };
}

describe("triggerLabel for a schedule", () => {
  it("prints the whole sentence, zone included", () => {
    // VC-112 requires the stored zone to be shown ALWAYS. A row that printed
    // "Every day at 21:00" would leave a reader unable to tell whose 21:00.
    expect(
      triggerLabel({
        kind: "schedule",
        schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
      }),
    ).toBe("Every day at 21:00 Europe/London");
    expect(
      triggerLabel({
        kind: "schedule",
        schedule: { preset: "hourly", minute: 5, timeZone: "America/New_York" },
      }),
    ).toBe("Every hour at :05 America/New_York");
    expect(
      triggerLabel({
        kind: "schedule",
        schedule: { preset: "weekly", weekday: "monday", hour: 8, minute: 30, timeZone: "UTC" },
      }),
    ).toBe("Every Monday at 08:30 UTC");
  });
});

describe("listingRunTarget", () => {
  it("sends a schedule to the Project and everything else to a Ticket", () => {
    // VC-112's second scope axis: the Trigger decides the Target. A schedule
    // names the Project, so running one by hand opens the Project Session it
    // would have opened rather than asking which Ticket.
    expect(
      listingRunTarget({
        trigger: {
          kind: "schedule",
          schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
        },
      }),
    ).toBe("project");
    expect(listingRunTarget({ trigger: NO_AUTOMATION_TRIGGER })).toBe("ticket");
    expect(listingRunTarget({ trigger: { kind: "columns", columns: ["doing"] } })).toBe("ticket");
  });
});

describe("automationHistory", () => {
  it("interleaves Runs and Skipped occurrences, newest first", () => {
    const early = run({ id: "run-early", createdAt: 100 });
    const late = run({ id: "run-late", createdAt: 900 });
    const missed = skip({ dueAt: 500 });
    expect(automationHistory([late, early], [missed]).map((entry) => entry.at)).toEqual([
      900, 500, 100,
    ]);
    expect(automationHistory([late], [missed])[1]).toEqual({
      kind: "skip",
      at: 500,
      skip: missed,
    });
  });

  it("files a skip at its DUE time, not at the moment it was noticed", () => {
    // An app opened on Monday records Friday's miss on Monday. Filing it under
    // Monday would sit it above Runs that really did happen in between.
    const monday = run({ id: "run-monday", createdAt: 800 });
    const missed = skip({ dueAt: 100, recordedAt: 1_000 });
    expect(automationHistory([monday], [missed]).map((entry) => entry.kind)).toEqual([
      "run",
      "skip",
    ]);
  });

  it("is empty when nothing has happened at all", () => {
    expect(automationHistory([], [])).toEqual([]);
  });
});

describe("skipReasonLabel", () => {
  it("says Skipped in every arm, so a skip is never a silence", () => {
    expect(skipReasonLabel(skip())).toBe("Skipped — Volli wasn’t running");
    // A machine asleep at 21:00 with the app open is not a closed app, and the
    // row says what was observed rather than a cause it cannot know.
    expect(skipReasonLabel(skip({ reason: { kind: "not-observed" } }))).toBe(
      "Skipped — Volli didn’t wake in time",
    );
    expect(
      skipReasonLabel(
        skip({ reason: { kind: "run-refused", code: "MODEL_REQUIRED", error: "Choose a model." } }),
      ),
    ).toBe("Skipped — Choose a model.");
    // The cause may be unreadable; that something did not run must not be.
    expect(skipReasonLabel(skip({ reason: { kind: "unknown" } }))).toBe(
      "Skipped — reason unreadable",
    );
  });
});

describe("skipCountLabel", () => {
  it("stays quiet for the ordinary single miss and states a real gap", () => {
    expect(skipCountLabel({ missedCount: 1 })).toBe("");
    expect(skipCountLabel({ missedCount: 50 })).toBe("50 occurrences");
  });
});

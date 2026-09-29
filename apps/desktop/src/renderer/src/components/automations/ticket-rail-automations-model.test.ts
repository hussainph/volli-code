import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, ColumnArming, TicketStatus } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  automationGroupsFor,
  automationInspectMeta,
  modelOverrideRows,
  overridePressable,
  railAutomationRows,
  railRowQualifier,
  railRunLabel,
  RAIL_PENDING_LABEL,
  RAIL_UNARMED_LABEL,
  RAIL_UNREAD_LABEL,
  runLaunchLabel,
  runModelChoices,
  SAVED_RUNTIME_CHOICE,
  ticketRailAutomations,
  type RailAutomationRow,
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
      rankedAutomationIds: [],
      orders: [],
      ready: true,
    });

    expect(rail.primary).toEqual({ kind: "automation", automation: armed });
    expect(railRunLabel(rail.primary)).toBe("Review sweep");
  });

  it("has no default press where the column arms nothing — and no stand-in for one (VC-406)", () => {
    const rail = ticketRailAutomations({
      automations: [automation()],
      armings: [],
      status: "doing",
      rankedAutomationIds: [],
      orders: [],
      ready: true,
    });

    expect(rail.primary).toEqual({ kind: "none" });
    expect(railRunLabel(rail.primary)).toBe(RAIL_UNARMED_LABEL);
    // Still offered here, even with nothing armed: the Offered list is the
    // record's Trigger, and arming is the column's separate choice.
    expect(rail.offered.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("reads an arming from another column as nothing armed here", () => {
    const rail = ticketRailAutomations({
      automations: [automation()],
      armings: [arming({ status: "todo" })],
      status: "doing",
      rankedAutomationIds: [],
      orders: [],
      ready: true,
    });

    expect(rail.primary).toEqual({ kind: "none" });
  });

  it("offers this column's list in the rank its lane arranged (VC-132)", () => {
    // The menu and the lane are one list read twice. It is deliberately NOT
    // the drag's pinned shape — the pin protects what digit `1` means, and
    // this menu has no digits — so the armed row is not floated to the top.
    const listedFirst = automation({ id: "a2", name: "Alphabetically first" });
    const armed = automation();

    expect(
      ticketRailAutomations({
        automations: [listedFirst, armed],
        armings: [arming()],
        status: "doing",
        rankedAutomationIds: ["a1", "a2"],
        orders: [],
        ready: true,
      }).offered.map((entry) => entry.id),
    ).toEqual(["a1", "a2"]);

    // Unarranged, it is the order main listed them in.
    expect(
      ticketRailAutomations({
        automations: [listedFirst, armed],
        armings: [arming()],
        status: "doing",
        rankedAutomationIds: [],
        orders: [],
        ready: true,
      }).offered.map((entry) => entry.id),
    ).toEqual(["a2", "a1"]);
  });

  it("offers nothing in a column no Trigger names, and still presses", () => {
    const rail = ticketRailAutomations({
      automations: [automation({ trigger: NO_AUTOMATION_TRIGGER })],
      armings: [],
      status: "doing",
      rankedAutomationIds: [],
      orders: [],
      ready: true,
    });

    expect(rail.offered).toEqual([]);
    expect(rail.primary).toEqual({ kind: "none" });
    // The project DOES list one, so this is not the empty state — the rail's
    // sentence about an empty project must not appear here.
    expect(rail.listsAny).toBe(true);
  });

  it("says the project lists nothing, which is what the empty state is drawn from", () => {
    const rail = ticketRailAutomations({
      automations: [],
      armings: [],
      status: "doing",
      rankedAutomationIds: [],
      orders: [],
      ready: true,
    });

    expect(rail.listsAny).toBe(false);
    expect(rail.offered).toEqual([]);
    // Nothing to arm, so nothing is armed; the block draws its sentence and door.
    expect(rail.primary).toEqual({ kind: "none" });
    expect(rail.ready).toBe(true);
  });

  it("presses nothing until the reads behind it have landed", () => {
    // The cache says the same thing whether this column arms nothing or nobody
    // has asked yet, so an unread rail answers neither: it says it is reading.
    const rail = ticketRailAutomations({
      automations: [automation()],
      armings: [arming()],
      status: "doing",
      rankedAutomationIds: [],
      orders: [],
      ready: false,
    });

    expect(rail.ready).toBe(false);
    expect(rail.primary).toEqual({ kind: "unread" });
    expect(railRunLabel(rail.primary)).toBe(RAIL_UNREAD_LABEL);
    // Nothing offered and no claim about the project either: a menu row here
    // would be a record read from a cache nobody has filled.
    expect(rail.offered).toEqual([]);
    expect(rail.groups).toEqual([]);
    expect(rail.listsAny).toBe(false);
  });

  it("does not mistake an unread cache for an armed column that lost its record", () => {
    // The stale case the read exists for: this cache still holds the arming a
    // person removed in another window, and the rail must not press it.
    const stale = ticketRailAutomations({
      automations: [automation()],
      armings: [arming()],
      status: "doing",
      rankedAutomationIds: [],
      orders: [],
      ready: false,
    });

    expect(stale.primary).not.toEqual({ kind: "automation", automation: automation() });
  });
});

describe("automationGroupsFor (VC-329 item 5)", () => {
  it("groups every column's offer, this ticket's column first, board order after", () => {
    const doing = automation(); // triggers doing
    const todo = automation({
      id: "a2",
      name: "Triage",
      trigger: { kind: "columns", columns: ["todo"] },
    });

    const groups = automationGroupsFor({ automations: [doing, todo], orders: [], status: "todo" });

    expect(groups.map((group) => group.status)).toEqual(["todo", "doing"]);
    expect(groups[0]?.current).toBe(true);
    expect(groups[0]?.label).toBe("Todo");
    expect(groups[1]?.current).toBe(false);
    expect(groups[1]?.automations.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("orders each group by its own column's authored rank", () => {
    const first = automation({ id: "a1", name: "Ranked first here" });
    const second = automation({ id: "a2", name: "Ranked second here" });

    const groups = automationGroupsFor({
      automations: [second, first],
      orders: [
        { projectId: "p1", status: "doing", rankedAutomationIds: ["a1", "a2"], orderedAt: 1 },
      ],
      status: "todo",
    });

    expect(groups[0]?.automations.map((entry) => entry.id)).toEqual(["a1", "a2"]);
  });

  it("offers a column that arms nothing, because the trigger decides membership", () => {
    // Arming is a per-column act and these groups are hand-run doors; a column
    // with no arming row still lists the Automations its trigger names.
    const groups = automationGroupsFor({ automations: [automation()], orders: [], status: "todo" });

    expect(groups.map((group) => group.status)).toEqual(["doing"]);
  });

  it("offers triggerless records on any ticket but excludes project schedules", () => {
    const groups = automationGroupsFor({
      automations: [
        automation({ trigger: NO_AUTOMATION_TRIGGER }),
        automation({
          id: "scheduled",
          trigger: {
            kind: "schedule",
            schedule: { preset: "daily", hour: 9, minute: 0, timeZone: "UTC" },
          },
        }),
      ],
      orders: [],
      status: "doing",
    });

    expect(groups.map((group) => group.status)).toEqual(["any"]);
    expect(groups[0]?.automations.map((record) => record.id)).toEqual(["a1"]);
  });

  it("contributes no group for an empty column, so the menu stays short", () => {
    const groups = automationGroupsFor({ automations: [], orders: [], status: "doing" });

    expect(groups).toEqual([]);
  });

  it("feeds ticketRailAutomations' cross-column answer", () => {
    const doing = automation();
    const rail = ticketRailAutomations({
      automations: [doing],
      armings: [],
      status: "todo",
      rankedAutomationIds: [],
      orders: [],
      ready: true,
    });

    // The ticket sits in Todo; the Doing automation is still offered, in its
    // own labelled group — the whole point of item 5.
    expect(rail.groups.map((group) => group.status)).toEqual(["doing"]);
    expect(rail.primary).toEqual({ kind: "none" });
  });
});

describe("overridePressable", () => {
  it("offers the override wherever the default press is a Run", () => {
    expect(overridePressable({ kind: "automation", automation: automation() })).toBe(true);
  });

  it("offers nothing where the column arms nothing — there is no Run to pick a model for", () => {
    expect(overridePressable({ kind: "none" })).toBe(false);
  });

  it("never offers it before the rail has read what it would run", () => {
    expect(overridePressable({ kind: "unread" })).toBe(false);
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

/** The rail's own answer, so the rows are read off the shape the view is handed. */
function readRail(input: {
  automations: readonly Automation[];
  armings?: readonly ColumnArming[];
  status?: TicketStatus;
}) {
  return ticketRailAutomations({
    automations: input.automations,
    armings: input.armings ?? [],
    orders: [],
    status: input.status ?? "doing",
    ready: true,
  });
}

describe("railAutomationRows", () => {
  it("flattens every column's offer into rows, this Ticket's column first", () => {
    const rows = railAutomationRows(
      readRail({
        automations: [
          automation({
            id: "a2",
            name: "Ship it",
            trigger: { kind: "columns", columns: ["done"] },
          }),
          automation(),
        ],
      }),
    );

    expect(rows.map((row) => [row.automation.id, row.columnLabel, row.armed])).toEqual([
      ["a1", "Doing", false],
      ["a2", "Done", false],
    ]);
  });

  it("marks the row this column has armed, and only that one", () => {
    const rows = railAutomationRows(
      readRail({
        automations: [automation(), automation({ id: "a2", name: "Nightly sweep" })],
        armings: [arming()],
      }),
    );

    expect(rows.map((row) => [row.automation.id, row.armed])).toEqual([
      ["a1", true],
      ["a2", false],
    ]);
  });

  // ONE ROW PER RECORD. The menu lists a multi-column record once per column,
  // which is right there — the heading is the subject. Here both rows would
  // reach the same Run with the same id, so the reader would be offered a
  // choice between two identical presses.
  it("draws a record offered by several columns once, under the nearest", () => {
    const rows = railAutomationRows(
      readRail({
        automations: [automation({ trigger: { kind: "columns", columns: ["doing", "done"] } })],
        armings: [arming()],
      }),
    );

    expect(rows.map((row) => [row.columnLabel, row.armed])).toEqual([["Doing", true]]);
  });

  // The same record from a column that is NOT this Ticket's: it is still one
  // row, and still not the armed one — the dedupe must not promote a far
  // column's row into the default just by being the survivor.
  it("keeps a deduped row unmarked when the Ticket's own column arms nothing", () => {
    const rows = railAutomationRows(
      readRail({
        automations: [automation({ trigger: { kind: "columns", columns: ["todo", "done"] } })],
        armings: [arming({ status: "todo" })],
      }),
    );

    expect(rows.map((row) => [row.columnLabel, row.armed])).toEqual([["Todo", false]]);
  });

  it("names the triggerless group the way the menu does", () => {
    const rows = railAutomationRows(
      readRail({ automations: [automation({ trigger: NO_AUTOMATION_TRIGGER })] }),
    );

    expect(rows.map((row) => row.columnLabel)).toEqual(["Any column"]);
    expect(rows[0]?.armed).toBe(false);
  });

  it("lists nothing at all from an unread rail", () => {
    // Not an empty project — an unasked one. The block draws its own sentence
    // for this, and a row here would be a press against a cache that has not
    // landed (VC-112).
    expect(
      railAutomationRows(
        ticketRailAutomations({
          automations: [automation()],
          armings: [arming()],
          orders: [],
          status: "doing",
          ready: false,
        }),
      ),
    ).toEqual([]);
  });
});

/* ----------------------------------------------- the inspection (VC-406) */

function railRow(overrides: Partial<RailAutomationRow> = {}): RailAutomationRow {
  return { automation: automation(), columnLabel: "Doing", armed: false, ...overrides };
}

describe("runLaunchLabel", () => {
  it("names the three states a launch can be in", () => {
    expect(runLaunchLabel("idle")).toBe("Run");
    expect(runLaunchLabel("pending")).toBe(RAIL_PENDING_LABEL);
    // A second press on an intent that is still the same intent, not a first
    // attempt wearing the same word.
    expect(runLaunchLabel("failed")).toBe("Retry Run");
  });
});

describe("railRowQualifier", () => {
  it("says the one thing that is happening now, while it is happening", () => {
    // The wait outranks both other answers: it is the row's acknowledgment
    // that a press was heard, which is what lets the inspection be closed.
    expect(railRowQualifier(railRow({ armed: true }), true)).toBe(RAIL_PENDING_LABEL);
    expect(railRowQualifier(railRow(), true)).toBe(RAIL_PENDING_LABEL);
  });

  it("otherwise says Armed, or the column that offers the row", () => {
    expect(railRowQualifier(railRow({ armed: true }), false)).toBe("Armed");
    expect(railRowQualifier(railRow({ columnLabel: "Needs Review" }), false)).toBe("Needs Review");
  });
});

describe("automationInspectMeta", () => {
  it("says how the record would start, and in which column", () => {
    expect(automationInspectMeta(railRow({ armed: true }), false)).toBe("Armed · Doing");
    expect(automationInspectMeta(railRow({ columnLabel: "Done" }), false)).toBe(
      "Manual launch · Done",
    );
  });

  it("adds the switch's own words where nothing but a person starts it", () => {
    // VC-112: the switch governs what starts an Automation BESIDES a person,
    // so the record is still offered and still runs by hand.
    expect(automationInspectMeta(railRow({ armed: true }), true)).toBe(
      "Armed · Doing · Manual only",
    );
    expect(automationInspectMeta(railRow(), true)).toBe("Manual launch · Doing · Manual only");
  });
});

describe("runModelChoices", () => {
  it("leads with the record's own saved Runtime", () => {
    const choices = runModelChoices([model()]);

    expect(choices[0]).toEqual({ id: SAVED_RUNTIME_CHOICE, label: "Saved model", selection: null });
  });

  it("gives a model with several levels one row per whole pair", () => {
    // Model and reasoning travel together (VC-112): there is no row here that
    // names a model and leaves the level to a default nobody chose.
    expect(runModelChoices([model()]).slice(1)).toEqual([
      {
        id: "anthropic/claude-opus\u0000low",
        label: "claude-opus · low",
        selection: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "low" },
      },
      {
        id: "anthropic/claude-opus\u0000high",
        label: "claude-opus · high",
        selection: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
    ]);
  });

  it("gives a model with exactly one level its own name alone", () => {
    expect(runModelChoices([model({ reasoningLevels: ["high"] })]).slice(1)).toEqual([
      {
        id: "anthropic/claude-opus\u0000high",
        label: "claude-opus",
        selection: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      },
    ]);
  });

  it("offers nothing at all when the catalog names no runnable model", () => {
    // Not even the saved row: a control whose only choice is the default is a
    // field with nothing to choose, and the inspection drops it.
    expect(runModelChoices([])).toEqual([]);
    expect(runModelChoices([model({ reasoningLevels: ["turbo"] })])).toEqual([]);
  });
});

/**
 * The island's rules, without an island: when there is one at all, which
 * clusters it draws and in what order, and the one grammar every announcement
 * and caption is written in.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_ISLAND_FEEL,
  agentDimmed,
  agentProgressMeasured,
  agentsDone,
  agentsHeading,
  agentsLine,
  agentStateWord,
  EMPTY_ACTIVITY_ISLAND,
  flashLine,
  type IslandAgent,
  type IslandPlan,
  type IslandShell,
  type IslandTab,
  islandClusters,
  islandEmpty,
  islandPlanFromTodos,
  planCount,
  planCurrent,
  planHeading,
  planLine,
  planPercent,
  planStepState,
  planTotal,
  resolveFeel,
  shellsHeading,
  shellsLine,
  shellsRunning,
  shellStateWord,
  summaryLine,
  tabsHeading,
  tabsLine,
  tabsLoading,
  tabStateWord,
} from "./activity-island";

function tab(over: Partial<IslandTab> = {}): IslandTab {
  return {
    id: "t1",
    host: "github.com",
    state: "ready",
    promoted: false,
    surface: null,
    owner: null,
    ...over,
  };
}

function agent(over: Partial<IslandAgent> = {}): IslandAgent {
  return {
    id: "a1",
    label: "Audit icon weights",
    progress: 0.5,
    state: "working",
    promoted: false,
    ...over,
  };
}

function shell(over: Partial<IslandShell> = {}): IslandShell {
  return { id: "s1", command: "pnpm lab", state: "running", code: null, ...over };
}

const PLAN: IslandPlan = {
  id: "p1",
  steps: [
    { id: "s1", title: "Read composer stack", state: "completed" },
    { id: "s2", title: "Sketch closed pill", state: "in_progress" },
    { id: "s3", title: "Wire feel dials", state: "pending" },
  ],
  done: 1,
};

describe("the empty rule", () => {
  it("draws no island when there is nothing to model", () => {
    expect(islandEmpty(EMPTY_ACTIVITY_ISLAND)).toBe(true);
  });

  it("does not count a lone flash as something to model", () => {
    // A flash is a change to something; with nothing left it has no subject,
    // and a 32px pill announcing it has nothing to say is the bar this rule
    // exists to refuse.
    expect(
      islandEmpty({
        ...EMPTY_ACTIVITY_ISLAND,
        flash: { id: "f1", event: "Closed", payload: "github.com" },
      }),
    ).toBe(true);
  });

  it("has an island for any one element kind", () => {
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] })).toBe(false);
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, agents: [agent()] })).toBe(false);
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, plan: PLAN })).toBe(false);
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, shells: [shell()] })).toBe(false);
  });

  it("has an island for a plan with no steps yet — a drafted plan is still a subject", () => {
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, plan: { ...PLAN, steps: [], done: 0 } })).toBe(
      false,
    );
  });
});

describe("cluster membership", () => {
  it("lists visible clusters in reading order regardless of arrival order", () => {
    // Shells and the plan were added before any tab; the pill still reads
    // tabs → agents → plan → shells, because the order is a grammar, not a log.
    const clusters = islandClusters({
      tabs: [tab()],
      agents: [agent()],
      plan: PLAN,
      shells: [shell()],
      flash: null,
    });
    expect(clusters).toEqual(["tabs", "agents", "plan", "shells"]);
  });

  it("leaves out a cluster whose subject is gone", () => {
    expect(islandClusters({ ...EMPTY_ACTIVITY_ISLAND, plan: PLAN, shells: [shell()] })).toEqual([
      "plan",
      "shells",
    ]);
    expect(islandClusters(EMPTY_ACTIVITY_ISLAND)).toEqual([]);
  });
});

describe("the now channel's grammar", () => {
  it("keeps the two registers apart and joins them only on request", () => {
    // The point of the split: a drawing weights `payload` without parsing, and
    // a translating client gets two strings rather than one it must take apart.
    const flash = { id: "f1", event: "Opened in pane", payload: "github.com" };
    expect(flash.event).toBe("Opened in pane");
    expect(flash.payload).toBe("github.com");
    expect(flashLine(flash)).toBe("Opened in pane · github.com");
  });

  it("carries a payload that contains the separator without ambiguity", () => {
    // The old pre-joined string could not survive this: splitting it back gave
    // the wrong halves for any payload wearing its own middle dot.
    const flash = { id: "f2", event: "Plan 3/7", payload: "a · b" };
    expect(flash.payload).toBe("a · b");
    expect(flashLine(flash)).toBe("Plan 3/7 · a · b");
  });

  it("joins an empty payload without inventing a word for it", () => {
    expect(flashLine({ id: "f3", event: "Page loaded", payload: "" })).toBe("Page loaded · ");
  });
});

describe("tabs", () => {
  it("names a lone tab and counts several", () => {
    expect(tabsLine([tab()])).toBe("1 browser tab · github.com");
    expect(tabsLine([tab(), tab({ id: "t2", host: "motion.dev" })])).toBe("2 browser tabs");
    expect(tabsHeading([tab()])).toBe("Browser · 1 tab");
    expect(tabsHeading([tab(), tab({ id: "t2" })])).toBe("Browser · 2 tabs");
  });

  it("counts zero tabs in the plural — the heading outlives the last tab by a frame", () => {
    expect(tabsLine([])).toBe("0 browser tabs");
    expect(tabsHeading([])).toBe("Browser · 0 tabs");
    expect(tabsLoading([])).toBe(false);
  });

  it("says loading over promoted, and nothing when there is nothing to say", () => {
    expect(tabStateWord(tab({ state: "loading", promoted: true, surface: "preview" }))).toBe(
      "loading",
    );
    expect(tabStateWord(tab())).toBeNull();
    expect(tabsLoading([tab(), tab({ id: "t2", state: "loading" })])).toBe(true);
    expect(tabsLoading([tab()])).toBe(false);
  });

  it("tells the two visible places apart — pinned in this chat, or out in the strip (VC-268)", () => {
    // `promoted` is one boolean for the pill; the card's caption answers
    // "where", and a preview above this composer is not a tab in the strip.
    expect(tabStateWord(tab({ promoted: true, surface: "preview" }))).toBe("pinned here");
    expect(tabStateWord(tab({ promoted: true, surface: "tab" }))).toBe("as a tab");
  });
});

describe("subagents", () => {
  const group = [
    agent(),
    agent({ id: "a2", state: "done", progress: 1 }),
    agent({ id: "a3", state: "failed" }),
    agent({ id: "a4", state: "stopped" }),
  ];

  it("counts done, never a mood", () => {
    expect(agentsDone(group)).toBe(1);
    expect(agentsLine(group)).toBe("1/4 subagents done");
    expect(agentsHeading(group)).toBe("Subagents · 1/4 done");
  });

  it("still counts when every subagent is done — never a word like `settled`", () => {
    const finished = [agent({ state: "done" }), agent({ id: "a2", state: "done" })];
    expect(agentsDone(finished)).toBe(2);
    expect(agentsLine(finished)).toBe("2/2 subagents done");
    expect(agentsHeading(finished)).toBe("Subagents · 2/2 done");
  });

  it("says progress while working and the state otherwise, with `· tab` once promoted", () => {
    expect(agentStateWord(agent({ progress: 0.724 }))).toBe("72%");
    expect(agentStateWord(agent({ state: "done" }))).toBe("done");
    expect(agentStateWord(agent({ state: "stopped", promoted: true }))).toBe("stopped · tab");
  });

  it("rounds progress rather than truncating it, at both ends", () => {
    expect(agentStateWord(agent({ progress: 0.005 }))).toBe("1%");
    expect(agentStateWord(agent({ progress: 1 }))).toBe("100%");
  });

  // VC-269: no feed has a measure of a turn's progress, so a working agent
  // carries 0 — and 0 is "unmeasured", never a percentage nobody took.
  it("says a word, not 0%, for a working agent with no measure", () => {
    expect(agentStateWord(agent({ progress: 0 }))).toBe("working");
    expect(agentStateWord(agent({ progress: 0, promoted: true }))).toBe("working · tab");
    expect(agentProgressMeasured(agent({ progress: 0 }))).toBe(false);
    expect(agentProgressMeasured(agent({ progress: 0.3 }))).toBe(true);
    expect(agentProgressMeasured(agent({ progress: 0.3, state: "done" }))).toBe(false);
  });

  it("dims what ended without finishing", () => {
    expect(agentDimmed(agent({ state: "failed" }))).toBe(true);
    expect(agentDimmed(agent({ state: "stopped" }))).toBe(true);
    expect(agentDimmed(agent({ state: "done" }))).toBe(false);
    expect(agentDimmed(agent())).toBe(false);
  });
});

describe("plan", () => {
  it("derives current, count and percent from the steps and the done mark", () => {
    expect(planCurrent(PLAN)).toEqual({
      id: "s2",
      title: "Sketch closed pill",
      state: "in_progress",
    });
    expect(planTotal(PLAN)).toBe(3);
    expect(planCount(PLAN)).toBe("1/3");
    expect(planPercent(PLAN)).toBeCloseTo(33.33, 1);
    expect(planLine(PLAN)).toBe("Plan 1/3 · Sketch closed pill");
    expect(planHeading(PLAN)).toBe("Plan · 1/3");
  });

  it("names the current step by id, so two steps may share a title", () => {
    // Titles were the key until a plan repeated one; the id is what the card
    // draws and what `jumpStep` addresses.
    const repeated: IslandPlan = {
      id: "p2",
      steps: [
        { id: "s1", title: "Review", state: "completed" },
        { id: "s2", title: "Review", state: "in_progress" },
      ],
      done: 1,
    };
    expect(planCurrent(repeated)).toEqual({ id: "s2", title: "Review", state: "in_progress" });
  });

  it("has no current step once every step is done", () => {
    const finished: IslandPlan = {
      ...PLAN,
      steps: PLAN.steps.map((step) => ({ ...step, state: "completed" as const })),
      done: 3,
    };
    expect(planCurrent(finished)).toBeNull();
    expect(planLine(finished)).toBe("Plan 3/3 · done");
    expect(planPercent(finished)).toBe(100);
  });

  it("survives an empty plan without dividing by zero", () => {
    const empty: IslandPlan = { id: "p3", steps: [], done: 0 };
    expect(planPercent(empty)).toBe(0);
    expect(planCount(empty)).toBe("0/0");
    expect(planCurrent(empty)).toBeNull();
    expect(planLine(empty)).toBe("Plan 0/0 · done");
  });

  it("never lets a bad done mark overflow the progress track", () => {
    // A projection that counts more done than it has steps is a bug upstream;
    // the hairline still may not run past its own end.
    expect(planPercent({ ...PLAN, done: 5 })).toBe(100);
    expect(planCount({ ...PLAN, done: 5 })).toBe("5/3");
  });

  it("states each step from the step's own state, not its position", () => {
    expect(planStepState(PLAN, 0)).toBe("done");
    expect(planStepState(PLAN, 1)).toBe("current");
    expect(planStepState(PLAN, 2)).toBe("pending");
  });

  it("answers for a row that is not there, rather than throwing at a client", () => {
    // The list a client is drawing and the plan it asks about can disagree for
    // a frame: a `todo_write` call replaces the WHOLE list, so a shorter one
    // can land between a render and this call. `pending` is the answer that
    // draws nothing alarming for a row on its way out.
    expect(planStepState(PLAN, 99)).toBe("pending");
    expect(planStepState(PLAN, -1)).toBe("pending");
  });

  it("draws work finished out of order where it actually happened (VC-6)", () => {
    // The whole reason `IslandStep` carries a state. Every real todo tool lets
    // the model finish the third item first; counting completed prefixes drew
    // that as "one done" with the wrong row ticked.
    const scattered: IslandPlan = {
      id: "p4",
      steps: [
        { id: "s1", title: "Read the ticket", state: "pending" },
        { id: "s2", title: "Write the tool", state: "completed" },
        { id: "s3", title: "Wire the island", state: "in_progress" },
      ],
      done: 1,
    };

    expect(planStepState(scattered, 0)).toBe("pending");
    expect(planStepState(scattered, 1)).toBe("done");
    expect(planStepState(scattered, 2)).toBe("current");
    expect(planCurrent(scattered)).toEqual({
      id: "s3",
      title: "Wire the island",
      state: "in_progress",
    });
    // The pill's grammar is untouched: `done` is still a COUNT, so `n/n` and
    // the hairline read exactly as they did before the step gained a state.
    expect(planCount(scattered)).toBe("1/3");
    expect(planPercent(scattered)).toBeCloseTo(33.33, 1);
  });

  it("dims a step the model dropped instead of losing it", () => {
    const dropped: IslandPlan = {
      id: "p5",
      steps: [
        { id: "s1", title: "Read the ticket", state: "completed" },
        { id: "s2", title: "Revive the dock", state: "cancelled" },
      ],
      done: 1,
    };

    expect(planStepState(dropped, 1)).toBe("cancelled");
    // A cancelled step is not current, and it is not the plan waiting on
    // something: with nothing left to do, the line says done.
    expect(planCurrent(dropped)).toBeNull();
    expect(planLine(dropped)).toBe("Plan 1/2 · done");
  });

  it("names the next pending step as current when nothing is marked in progress", () => {
    // A model that ticks an item and writes the list before starting the next
    // one leaves no in_progress row; the card still has to point somewhere.
    const between: IslandPlan = {
      id: "p6",
      steps: [
        { id: "s1", title: "Read the ticket", state: "completed" },
        { id: "s2", title: "Write the tool", state: "pending" },
      ],
      done: 1,
    };

    expect(planCurrent(between)).toMatchObject({ id: "s2" });
    expect(planStepState(between, 1)).toBe("current");
  });
});

describe("islandPlanFromTodos", () => {
  it("projects the Session's current todo list onto the card's model (VC-6)", () => {
    expect(
      islandPlanFromTodos("session-1", [
        { content: "Read the ticket", status: "completed" },
        { content: "Write the tool", status: "in_progress" },
        { content: "Wire the island", status: "pending" },
      ]),
    ).toEqual({
      id: "session-1",
      steps: [
        { id: "session-1:0", title: "Read the ticket", state: "completed" },
        { id: "session-1:1", title: "Write the tool", state: "in_progress" },
        { id: "session-1:2", title: "Wire the island", state: "pending" },
      ],
      done: 1,
    });
  });

  it("has no plan for a Session that never wrote one, and none for one that cleared it", () => {
    // Both draw no cluster, but they are different facts and the fold that
    // feeds this keeps them apart — an emptied list must not revive the old one.
    expect(islandPlanFromTodos("session-1", null)).toBeNull();
    expect(islandPlanFromTodos("session-1", [])).toBeNull();
  });

  it("counts only completed rows as done, so a cancelled step is not progress", () => {
    const plan = islandPlanFromTodos("session-1", [
      { content: "Read the ticket", status: "completed" },
      { content: "Revive the dock", status: "cancelled" },
    ]);

    expect(plan?.done).toBe(1);
    expect(planCount(plan!)).toBe("1/2");
  });
});

describe("shells", () => {
  it("leads with the running count while any run, and the exited count after", () => {
    const mixed = [shell(), shell({ id: "s2", state: "exited", code: 0 })];
    expect(shellsRunning(mixed)).toBe(1);
    expect(shellsLine(mixed)).toBe("1 shell running");
    expect(shellsHeading(mixed)).toBe("Shells · 1 running");

    const quiet = [
      shell({ state: "exited", code: 0 }),
      shell({ id: "s2", state: "exited", code: 137 }),
    ];
    expect(shellsLine(quiet)).toBe("2 shells · exited");
    expect(shellsHeading(quiet)).toBe("Shells · 2 exited");
  });

  it("says the exit code and nothing while running", () => {
    expect(shellStateWord(shell({ state: "exited", code: 137 }))).toBe("exit 137");
    expect(shellStateWord(shell())).toBeNull();
  });

  it("reads a missing exit code as 0 rather than printing `exit null`", () => {
    expect(shellStateWord(shell({ state: "exited", code: null }))).toBe("exit 0");
  });
});

describe("the inline summary", () => {
  it("averages working agents and falls back to the done count", () => {
    const working = summaryLine({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab()],
      agents: [agent({ progress: 0.2 }), agent({ id: "a2", progress: 0.6 })],
      plan: PLAN,
    });
    expect(working).toBe("1 tab · agents 40% · plan 1/3");

    const rested = summaryLine({
      ...EMPTY_ACTIVITY_ISLAND,
      tabs: [tab(), tab({ id: "t2" })],
      agents: [agent({ state: "done" }), agent({ id: "a2", state: "failed" })],
    });
    expect(rested).toBe("2 tabs · agents 1/2");
    expect(summaryLine(EMPTY_ACTIVITY_ISLAND)).toBe("");
    // Unmeasured workers are counted, not averaged to a 0% nobody measured.
    expect(
      summaryLine({
        ...EMPTY_ACTIVITY_ISLAND,
        agents: [agent({ progress: 0 }), agent({ id: "a2", progress: 0 })],
      }),
    ).toBe("agents 2 working");
  });

  it("leaves shells out — a running one announces itself through the flash", () => {
    expect(summaryLine({ ...EMPTY_ACTIVITY_ISLAND, shells: [shell()] })).toBe("");
  });
});

describe("feel", () => {
  it("defaults to the live-round verdicts and lets an override name one dial at a time", () => {
    expect(ACTIVITY_ISLAND_FEEL).toMatchObject({
      grammar: "clusters-now",
      springDuration: 0.55,
      springBounce: 0.25,
      flashHoldSeconds: 1.6,
      hover: "popover",
      nowVoice: "payload",
      reveal: "hover",
      armDestructive: true,
    });
    expect(resolveFeel()).toBe(ACTIVITY_ISLAND_FEEL);
    expect(resolveFeel({ hover: "tooltip" })).toEqual({
      ...ACTIVITY_ISLAND_FEEL,
      hover: "tooltip",
    });
  });
});

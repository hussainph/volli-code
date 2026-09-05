/**
 * The island's rules, without an island: when there is one at all, which
 * clusters it draws and in what order, and the one grammar every announcement
 * and caption is written in.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_ISLAND_FEEL,
  agentDimmed,
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
  planCount,
  planCurrent,
  planHeading,
  planLine,
  planPercent,
  planStepState,
  resolveFeel,
  shellsHeading,
  shellsLine,
  shellsRunning,
  shellStateWord,
  splitFlash,
  summaryLine,
  tabsHeading,
  tabsLine,
  tabsLoading,
  tabStateWord,
} from "./activity-island-model";

function tab(over: Partial<IslandTab> = {}): IslandTab {
  return {
    id: "t1",
    host: "github.com",
    tone: "#3577f2",
    state: "ready",
    promoted: false,
    ...over,
  };
}

function agent(over: Partial<IslandAgent> = {}): IslandAgent {
  return {
    id: "a1",
    label: "Audit icon weights",
    tone: "#e8652a",
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
  steps: ["Read composer stack", "Sketch closed pill", "Wire feel dials"],
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
      islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, flash: { id: "f1", text: "Closed · github.com" } }),
    ).toBe(true);
  });

  it("has an island for any one element kind", () => {
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, tabs: [tab()] })).toBe(false);
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, agents: [agent()] })).toBe(false);
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, plan: PLAN })).toBe(false);
    expect(islandEmpty({ ...EMPTY_ACTIVITY_ISLAND, shells: [shell()] })).toBe(false);
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
  it("writes and reads `event · payload`", () => {
    const line = flashLine("Opened in pane", "github.com");
    expect(line).toBe("Opened in pane · github.com");
    expect(splitFlash(line)).toEqual({ event: "Opened in pane", payload: "github.com" });
  });

  it("splits on the first separator so a payload may carry its own", () => {
    expect(splitFlash(flashLine("Plan 3/7", "a · b"))).toEqual({
      event: "Plan 3/7",
      payload: "a · b",
    });
  });

  it("has no registers for a line that was not built by it", () => {
    expect(splitFlash("Page loaded")).toBeNull();
  });
});

describe("tabs", () => {
  it("names a lone tab and counts several", () => {
    expect(tabsLine([tab()])).toBe("1 browser tab · github.com");
    expect(tabsLine([tab(), tab({ id: "t2", host: "motion.dev" })])).toBe("2 browser tabs");
    expect(tabsHeading([tab()])).toBe("Browser · 1 tab");
    expect(tabsHeading([tab(), tab({ id: "t2" })])).toBe("Browser · 2 tabs");
  });

  it("says loading over promoted, and nothing when there is nothing to say", () => {
    expect(tabStateWord(tab({ state: "loading", promoted: true }))).toBe("loading");
    expect(tabStateWord(tab({ promoted: true }))).toBe("in pane");
    expect(tabStateWord(tab())).toBeNull();
    expect(tabsLoading([tab(), tab({ id: "t2", state: "loading" })])).toBe(true);
    expect(tabsLoading([tab()])).toBe(false);
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

  it("says progress while working and the state otherwise, with `· tab` once promoted", () => {
    expect(agentStateWord(agent({ progress: 0.724 }))).toBe("72%");
    expect(agentStateWord(agent({ state: "done" }))).toBe("done");
    expect(agentStateWord(agent({ state: "stopped", promoted: true }))).toBe("stopped · tab");
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
    expect(planCurrent(PLAN)).toBe("Sketch closed pill");
    expect(planCount(PLAN)).toBe("1/3");
    expect(planPercent(PLAN)).toBeCloseTo(33.33, 1);
    expect(planLine(PLAN)).toBe("Plan 1/3 · Sketch closed pill");
    expect(planHeading(PLAN)).toBe("Plan · 1/3");
  });

  it("has no current step once every step is done", () => {
    const finished = { ...PLAN, done: 3 };
    expect(planCurrent(finished)).toBeNull();
    expect(planLine(finished)).toBe("Plan 3/3 · done");
    expect(planPercent({ ...PLAN, steps: [], done: 0 })).toBe(0);
  });

  it("states each step relative to the done mark", () => {
    expect(planStepState(PLAN, 0)).toBe("done");
    expect(planStepState(PLAN, 1)).toBe("current");
    expect(planStepState(PLAN, 2)).toBe("pending");
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
    expect(shellStateWord(shell({ state: "exited", code: null }))).toBe("exit 0");
    expect(shellStateWord(shell())).toBeNull();
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

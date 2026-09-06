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
  return { id: "t1", host: "github.com", state: "ready", promoted: false, ...over };
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
    { id: "s1", title: "Read composer stack" },
    { id: "s2", title: "Sketch closed pill" },
    { id: "s3", title: "Wire feel dials" },
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
    expect(agentStateWord(agent({ progress: 0 }))).toBe("0%");
    expect(agentStateWord(agent({ progress: 0.005 }))).toBe("1%");
    expect(agentStateWord(agent({ progress: 1 }))).toBe("100%");
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
    expect(planCurrent(PLAN)).toEqual({ id: "s2", title: "Sketch closed pill" });
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
        { id: "s1", title: "Review" },
        { id: "s2", title: "Review" },
      ],
      done: 1,
    };
    expect(planCurrent(repeated)).toEqual({ id: "s2", title: "Review" });
  });

  it("has no current step once every step is done", () => {
    const finished = { ...PLAN, done: 3 };
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

import { CLEANUP_PRESERVATION_RULES, preservationRuleText } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import type {
  KeptWorktreeMetadata,
  KeptWorktreeOrphan,
  OrphanCleanupItem,
  OrphanCleanupRun,
  PrunableWorktreeMetadata,
  RemovableWorktreeOrphan,
  UnreadableWorktreeProject,
} from "../../../../../ipc/contract";
import {
  ageBasisText,
  cleanupOutcome,
  cleanupRejectionMessage,
  cleanupSummary,
  describeCompleted,
  describeInterrupted,
  describeKept,
  describeKeptMetadata,
  describeMetadata,
  describeRemovable,
  describeRunFailures,
  describeUnreadableProject,
  hasCleanupWork,
  historyRows,
  orphanPolicyNote,
  planCleanup,
  preservationHistoryRows,
  retentionNote,
  runsWithFailures,
  unfinishedRuns,
  type OrphansScan,
} from "./storage-orphans-model";

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

function scan(overrides: Partial<OrphansScan> = {}): OrphansScan {
  return {
    revision: "rev-1",
    scannedAt: AT,
    retentionDays: 14,
    prunable: [],
    removable: [],
    keptRecent: [],
    keptMetadata: [],
    unreadableProjects: [],
    dirty: [],
    runs: [],
    ...overrides,
  };
}

function run(overrides: Partial<OrphanCleanupRun> = {}): OrphanCleanupRun {
  return {
    id: "run-1",
    source: "settings",
    scanRevision: "rev-1",
    startedAt: AT,
    finishedAt: AT + 1_000,
    interruptedAt: null,
    preservation: [],
    retentionDays: 14,
    items: [],
    ...overrides,
  };
}

function item(overrides: Partial<OrphanCleanupItem> = {}): OrphanCleanupItem {
  return {
    id: "item-1",
    kind: "worktree",
    path: "/wt/one",
    projectId: "p1",
    projectName: "Proj",
    branch: "volli/VC-1-x",
    state: "completed",
    detail: "Removed the folder.",
    startedAt: AT,
    settledAt: AT,
    ...overrides,
  };
}

const removable: RemovableWorktreeOrphan = {
  id: "rm-1",
  path: "/wt/one",
  projectId: "p1",
  projectName: "Proj One",
  branch: "volli/VC-1-x",
  lastTouchedAt: AT - 1,
  ageBasis: "directory",
  removableAt: AT,
};

const prunable: PrunableWorktreeMetadata = {
  id: "meta-1",
  projectId: "p1",
  projectName: "Proj One",
  projectPath: "/repo",
  path: "/wt/gone",
  reason: "gitdir file points to non-existent location",
};

describe("the cleanup plan", () => {
  // The acceptance the audit asks for: the confirmation names every affected
  // path and metadata change, and states what is preserved.
  it("names every directory, every metadata record, and what survives — one object, so shown and sent cannot drift", () => {
    const plan = planCleanup(scan({ removable: [removable], prunable: [prunable] }));

    expect(plan.scanRevision).toBe("rev-1");
    expect(plan.itemIds).toEqual(["rm-1", "meta-1"]);
    expect(plan.worktrees).toEqual([removable]);
    expect(plan.metadata).toEqual([prunable]);
    expect(plan.isEmpty).toBe(false);
  });

  // S3: the policy is rendered from the shared typed vocabulary, never a
  // hand-written list, so it can never independently drift from main's.
  it("renders the preservation policy from the shared vocabulary, never a hand-written list", () => {
    const plan = planCleanup(scan({ retentionDays: 9 }));

    expect(plan.preservation).toEqual(
      CLEANUP_PRESERVATION_RULES.map((rule) => preservationRuleText(rule, { retentionDays: 9 })),
    );
    // Rules the old hand-written list had already dropped.
    expect(plan.preservation.join(" ")).toMatch(/not pushed anywhere/i);
    expect(plan.preservation.join(" ")).toMatch(/merge, rebase, or bisect/i);
    expect(plan.preservation.join(" ")).toMatch(/submodules have drifted/i);
  });

  it("is empty, and offers no cleanup, when the scan found only things to keep", () => {
    const nothingToDo = scan();

    expect(planCleanup(nothingToDo).isEmpty).toBe(true);
    expect(hasCleanupWork(nothingToDo)).toBe(false);
    expect(hasCleanupWork(scan({ removable: [removable] }))).toBe(true);
  });
});

describe("the age basis", () => {
  it("names the folder's own clock", () => {
    expect(ageBasisText("directory")).toBe("the folder's last modification");
  });

  it("names the branch's clock", () => {
    expect(ageBasisText("commit")).toBe("its branch's last commit");
  });
});

describe("what a row says", () => {
  it("names the project, the eligibility date, its basis, and the branch that stays", () => {
    expect(describeRemovable(removable, { retentionDays: 14 })).toBe(
      `Proj One — eligible for cleanup since ${new Date(AT).toLocaleDateString()} (the folder's last modification, past the 14-day retention window). Branch volli/VC-1-x would stay in git.`,
    );
  });

  it("says a candidate has no branch rather than inventing one, and names a commit-basis deadline", () => {
    expect(
      describeRemovable({ ...removable, branch: null, ageBasis: "commit" }, { retentionDays: 7 }),
    ).toBe(
      `Proj One — eligible for cleanup since ${new Date(AT).toLocaleDateString()} (its branch's last commit, past the 7-day retention window). No branch is checked out here.`,
    );
  });

  const keptBase: KeptWorktreeOrphan = {
    path: "/wt/fresh",
    projectId: "p1",
    projectName: "Proj One",
    branch: null,
    lastTouchedAt: AT,
    ageBasis: "directory",
    removableAt: AT,
    reason: "recently-used",
    detail: null,
  };

  it("gives a recently-used folder its deadline and basis", () => {
    expect(describeKept(keptBase)).toBe(
      `Proj One — Kept until ${new Date(AT).toLocaleDateString()} (the folder's last modification) — used recently.`,
    );
  });

  it("admits the age is unknown rather than guessing at a deadline", () => {
    expect(
      describeKept({
        ...keptBase,
        reason: "recently-used",
        removableAt: null,
        ageBasis: null,
      }),
    ).toBe("Proj One — Kept — used recently.");
  });

  it("says an unreadable age outright", () => {
    expect(
      describeKept({ ...keptBase, reason: "age-unknown", removableAt: null, ageBasis: null }),
    ).toBe("Proj One — Kept — Volli can't tell when this was last used.");
  });

  it("names what is live inside an active worktree", () => {
    expect(describeKept({ ...keptBase, reason: "active", detail: "a running terminal" })).toBe(
      "Proj One — Kept — a running terminal.",
    );
  });

  it("falls back to a generic phrase when an active worktree names nothing specific", () => {
    expect(describeKept({ ...keptBase, reason: "active", detail: null })).toBe(
      "Proj One — Kept — in use right now.",
    );
  });

  it("distinguishes a stale RECORD from a directory, and names its project", () => {
    expect(describeMetadata(prunable)).toBe(
      "Proj One — stale git record (gitdir file points to non-existent location). Cleanup would prune the record; nothing on disk changes.",
    );
  });

  const keptMetadata: KeptWorktreeMetadata = {
    projectId: "p1",
    projectName: "Proj One",
    projectPath: "/repo",
    path: "/wt/gone",
    gitReason: "prunable: gitdir file points to non-existent location",
    reason: "not-owned",
  };

  it("says a stale record is kept because it isn't this database's to prune", () => {
    expect(describeKeptMetadata(keptMetadata)).toBe(
      "Proj One — stale git record (prunable: gitdir file points to non-existent location) kept — not owned by this database.",
    );
  });

  it("says a stale record is kept because a ticket still claims it", () => {
    expect(describeKeptMetadata({ ...keptMetadata, reason: "ticket-linked" })).toBe(
      "Proj One — stale git record (prunable: gitdir file points to non-existent location) kept — still linked to a ticket.",
    );
  });

  it("reports a project whose worktrees couldn't even be listed, rather than hiding it", () => {
    const unreadable: UnreadableWorktreeProject = {
      projectId: "p1",
      projectName: "Proj One",
      projectPath: "/repo",
      error: "permission denied",
    };
    expect(describeUnreadableProject(unreadable)).toBe(
      "Proj One — worktrees couldn't be listed: permission denied.",
    );
  });

  it("shows the retention window the eligibility dates come from", () => {
    expect(retentionNote(14)).toBe("Unused folders become eligible after 14 day(s).");
  });

  // Review C6: the retention period and the archive policy have to be SHOWN,
  // not summoned — and the orphan/ticket distinction is what explains why this
  // list's only verb is "remove the folder".
  it("states the retention window and the archive policy as a row of its own", () => {
    const note = orphanPolicyNote(9);
    expect(note).toContain("eligible after 9 day(s)");
    expect(note).toContain("no ticket to archive");
    expect(note).toContain("branch stays in git");
    expect(note).toContain("Archiving a ticket is a separate action");
  });
});

describe("the cleanup history", () => {
  // The mislabelling the audit found: every removed row said "Removed at
  // launch", including the ones a person had just asked for by hand.
  it("attributes a confirmed cleanup to the cleanup, never to the launch", () => {
    expect(describeCompleted(run(), item())).toBe(
      `Proj — Removed by cleanup at ${new Date(AT).toLocaleString()}. Branch volli/VC-1-x is still in git.`,
    );
  });

  it("attributes a startup-sourced removal to startup, and a missing branch honestly", () => {
    expect(describeCompleted(run({ source: "startup" }), item({ branch: null }))).toBe(
      `Proj — Removed during startup at ${new Date(AT).toLocaleString()}. No branch was checked out here.`,
    );
  });

  it("falls back to the run's finish time when an item has no settle time of its own", () => {
    expect(describeCompleted(run({ finishedAt: AT + 500 }), item({ settledAt: null }))).toContain(
      new Date(AT + 500).toLocaleString(),
    );
  });

  it("falls back to the run's start time when neither the item nor the run recorded a finish", () => {
    expect(describeCompleted(run({ finishedAt: null }), item({ settledAt: null }))).toContain(
      new Date(AT).toLocaleString(),
    );
  });

  it("names a pruned record without pretending a folder went with it, crediting the right project", () => {
    expect(
      describeCompleted(
        run(),
        item({ kind: "metadata", path: "/repo", branch: null, projectName: null }),
      ),
    ).toBe(
      `Unknown project — stale git record pruned by cleanup at ${new Date(AT).toLocaleString()}.`,
    );
  });

  it("attributes a pruned record to startup when that is who ran it", () => {
    expect(
      describeCompleted(run({ source: "startup" }), item({ kind: "metadata", branch: null })),
    ).toContain("pruned during startup");
  });

  it("lists every completed item, newest run first, and never folds two away as one", () => {
    const rows = historyRows([
      run({
        id: "run-2",
        items: [
          item({ id: "a", path: "/wt/one" }),
          item({ id: "b", path: "/wt/two", state: "skipped" }),
          item({ id: "c", kind: "metadata", path: "/repo", branch: null }),
        ],
      }),
      // Completing the SAME path in an earlier run is still its own row —
      // history is not deduplicated by path.
      run({ id: "run-1", items: [item({ id: "a", path: "/wt/one" })] }),
    ]);

    expect(rows).toEqual([
      { key: "run-2:a", path: "/wt/one", meta: expect.stringContaining("Removed by cleanup") },
      { key: "run-2:c", path: "/repo", meta: expect.stringContaining("stale git record") },
      { key: "run-1:a", path: "/wt/one", meta: expect.stringContaining("Removed by cleanup") },
    ]);
  });

  it("renders a run's recorded preservation ids through the shared vocabulary, unknown ids included", () => {
    const rows = preservationHistoryRows([
      run({
        id: "run-9",
        retentionDays: 21,
        preservation: ["branches", "from-a-later-version"],
        items: [item()],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toContain(preservationRuleText("branches", { retentionDays: 21 }));
    expect(rows[0]!.meta).toContain("from-a-later-version");
    expect(rows[0]!.meta).toContain("Cleanup at");
  });

  it("credits a startup run's preservation note to startup", () => {
    const rows = preservationHistoryRows([
      run({ source: "startup", preservation: ["branches"], items: [item()] }),
    ]);
    expect(rows[0]!.meta).toContain("Startup cleanup at");
  });

  it("says nothing about preservation for a run that recorded none, or that did nothing", () => {
    expect(preservationHistoryRows([run({ preservation: [], items: [item()] })])).toEqual([]);
    expect(preservationHistoryRows([run({ preservation: ["branches"], items: [] })])).toEqual([]);
  });

  it("dates an open run's preservation note from when it was interrupted, not from a finish that never came", () => {
    const rows = preservationHistoryRows([
      run({
        finishedAt: null,
        interruptedAt: AT + 5_000,
        preservation: ["branches"],
        items: [item()],
      }),
    ]);
    expect(rows[0]!.meta).toContain(new Date(AT + 5_000).toLocaleString());
  });

  it("dates a run with neither a finish nor an interruption stamp from when it started", () => {
    const rows = preservationHistoryRows([
      run({ finishedAt: null, interruptedAt: null, preservation: ["branches"], items: [item()] }),
    ]);
    expect(rows[0]!.meta).toContain(new Date(AT).toLocaleString());
  });
});

describe("an interrupted run", () => {
  // The recovery acceptance: a later launch can display the run WITHOUT
  // treating the items it already completed as still pending.
  it("says what completed, what was skipped, and what was never attempted", () => {
    const interrupted = run({
      finishedAt: null,
      interruptedAt: AT + 5_000,
      items: [
        item({ id: "a", path: "/wt/one", state: "completed" }),
        item({ id: "b", path: "/wt/two", state: "skipped" }),
        item({ id: "c", path: "/wt/three", state: "pending", settledAt: null, startedAt: null }),
      ],
    });

    expect(describeInterrupted(interrupted)).toBe(
      `A cleanup was interrupted on ${new Date(AT + 5_000).toLocaleString()}: 1 completed, 1 skipped, 1 never attempted. Scan again to review what is left.`,
    );
  });

  it("counts failures separately, and dates an unstamped interruption from the run's start", () => {
    expect(describeInterrupted(run({ finishedAt: null, items: [item({ state: "failed" })] }))).toBe(
      `A cleanup was interrupted on ${new Date(AT).toLocaleString()}: 0 completed, 1 failed, 0 never attempted. Scan again to review what is left.`,
    );
  });

  // #6: executing/indeterminate items get their own honest phrase, never
  // folded into "never attempted" — the world genuinely does not know.
  it("says an executing or indeterminate item may or may not have taken effect", () => {
    expect(
      describeInterrupted(
        run({
          finishedAt: null,
          items: [item({ state: "executing" }), item({ id: "b", state: "indeterminate" })],
        }),
      ),
    ).toBe(
      `A cleanup was interrupted on ${new Date(AT).toLocaleString()}: 0 completed, 2 may or may not have taken effect, 0 never attempted. Scan again to review what is left.`,
    );
  });

  it("surfaces only runs that stopped with pending, executing, or indeterminate work left", () => {
    const pending = run({ id: "pending", finishedAt: null, items: [item({ state: "pending" })] });
    const executing = run({
      id: "executing",
      finishedAt: null,
      items: [item({ state: "executing" })],
    });
    const indeterminate = run({
      id: "indeterminate",
      finishedAt: null,
      items: [item({ state: "indeterminate" })],
    });
    const settledButOpen = run({
      id: "settled-open",
      finishedAt: null,
      items: [item({ state: "completed" }), item({ id: "b", state: "skipped" })],
    });
    const finished = run({ id: "finished", finishedAt: AT, items: [item({ state: "pending" })] });

    expect(
      unfinishedRuns([pending, executing, indeterminate, settledButOpen, finished]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["pending", "executing", "indeterminate"]);
  });
});

describe("a run that finished with trouble in it", () => {
  it("is not among the unfinished runs — it settled, it just did not go clean", () => {
    const troubled = run({ finishedAt: AT, items: [item({ state: "failed" })] });
    expect(unfinishedRuns([troubled])).toEqual([]);
    expect(runsWithFailures([troubled]).map((entry) => entry.id)).toEqual(["run-1"]);
  });

  it("counts an indeterminate outcome as trouble too", () => {
    const troubled = run({ finishedAt: AT, items: [item({ state: "indeterminate" })] });
    expect(runsWithFailures([troubled])).toHaveLength(1);
  });

  it("is not reported as troubled once it finished clean", () => {
    expect(
      runsWithFailures([run({ finishedAt: AT, items: [item({ state: "completed" })] })]),
    ).toEqual([]);
  });

  it("is not reported as troubled while it is still open, even with a failure recorded", () => {
    expect(
      runsWithFailures([run({ finishedAt: null, items: [item({ state: "failed" })] })]),
    ).toEqual([]);
  });

  it("names every failed path with its reason, and the one recovery: scan again", () => {
    const troubled = run({
      finishedAt: AT,
      items: [
        item({
          id: "a",
          path: "/wt/one",
          projectName: "Proj One",
          state: "failed",
          detail: "disk busy",
        }),
        item({
          id: "b",
          path: "/wt/two",
          projectName: null,
          state: "indeterminate",
          detail: null,
        }),
      ],
    });

    expect(describeRunFailures(troubled)).toBe(
      `Cleanup at ${new Date(AT).toLocaleString()} — 2 item(s) failed: Proj One: disk busy; /wt/two: no reason recorded. Scan again to review what is left.`,
    );
  });
});

describe("what a finished cleanup says", () => {
  it("summarises a clean run", () => {
    expect(cleanupSummary(run({ items: [item({ state: "completed" })] }))).toBe("1 cleaned up");
  });

  it("counts kept, failed, and uncertain items in the summary", () => {
    expect(
      cleanupSummary(
        run({
          items: [
            item({ id: "a", state: "completed" }),
            item({ id: "b", state: "skipped" }),
            item({ id: "c", state: "failed" }),
            item({ id: "d", state: "indeterminate" }),
          ],
        }),
      ),
    ).toBe("1 cleaned up, 1 kept, 1 failed, 1 uncertain");
  });

  // S2: a run containing failed items must not read as a plain success.
  it("announces a clean run as a success", () => {
    expect(cleanupOutcome(run({ items: [item({ state: "completed" })] }))).toEqual({
      kind: "success",
      message: "Cleanup finished: 1 cleaned up.",
    });
  });

  it("announces a run with a failure as a warning naming the recovery", () => {
    expect(cleanupOutcome(run({ items: [item({ state: "failed" })] }))).toEqual({
      kind: "warning",
      message:
        "Cleanup finished with problems: 0 cleaned up, 1 failed. Scan again to review what is left.",
    });
  });

  it("announces a run with an indeterminate item as a warning too", () => {
    expect(cleanupOutcome(run({ items: [item({ state: "indeterminate" })] })).kind).toBe("warning");
  });
});

describe("a refused cleanup command", () => {
  it("tells the person the scan moved on, and names Scan again as the recovery", () => {
    expect(cleanupRejectionMessage("scan-superseded", "stale revision")).toContain("Scan again");
  });

  it("gives unknown-items its own honest sentence", () => {
    expect(cleanupRejectionMessage("unknown-items", "item rm-9 is not on this scan")).toBe(
      "Couldn't clean up: item rm-9 is not on this scan. Scan again to refresh the plan.",
    );
  });

  it("gives conflict its own honest sentence, without suggesting a rescan", () => {
    expect(cleanupRejectionMessage("conflict", "commandId already ran with a different plan")).toBe(
      "Couldn't clean up: commandId already ran with a different plan.",
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { OrphanCleanupRun } from "../../../../../ipc/contract";
import {
  CLEANUP_PRESERVATION,
  cleanupSummary,
  describeCompleted,
  describeInterrupted,
  describeKept,
  describeMetadata,
  describeRemovable,
  hasCleanupWork,
  historyRows,
  planCleanup,
  retentionNote,
  unfinishedRuns,
  type OrphansScan,
} from "./storage-orphans-model";

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

function scan(overrides: Partial<OrphansScan> = {}): OrphansScan {
  return {
    scannedAt: AT,
    retentionDays: 14,
    prunable: [],
    removable: [],
    keptRecent: [],
    dirty: [],
    runs: [],
    ...overrides,
  };
}

function run(overrides: Partial<OrphanCleanupRun> = {}): OrphanCleanupRun {
  return {
    id: "run-1",
    source: "settings",
    startedAt: AT,
    finishedAt: AT + 1_000,
    interruptedAt: null,
    preservation: [],
    items: [],
    ...overrides,
  };
}

describe("the cleanup plan", () => {
  // The acceptance the audit asks for: the confirmation names every affected
  // path and metadata change, and states what is preserved.
  it("names every directory, every metadata record, and what survives", () => {
    const plan = planCleanup(
      scan({
        removable: [
          {
            path: "/wt/one",
            projectId: "p1",
            branch: "volli/VC-1-x",
            lastTouchedAt: AT - 1,
            removableAt: AT,
          },
        ],
        prunable: [
          {
            projectId: "p1",
            projectPath: "/repo",
            entries: [{ path: "/wt/gone", reason: "gitdir file points to non-existent location" }],
          },
        ],
      }),
    );

    expect(plan.paths).toEqual(["/wt/one"]);
    expect(plan.projectIds).toEqual(["p1"]);
    expect(plan.metadata).toEqual([
      {
        projectPath: "/repo",
        path: "/wt/gone",
        reason: "gitdir file points to non-existent location",
      },
    ]);
    expect(plan.preservation).toBe(CLEANUP_PRESERVATION);
    expect(plan.preservation.join(" ")).toMatch(/branch/i);
    expect(plan.preservation.join(" ")).toMatch(/checked again immediately before/i);
    expect(plan.isEmpty).toBe(false);
    expect(hasCleanupWork(scan({ removable: plan.worktrees }))).toBe(true);
  });

  it("is empty, and offers no cleanup, when the scan found only things to keep", () => {
    const nothingToDo = scan({
      keptRecent: [
        {
          path: "/wt/fresh",
          projectId: "p1",
          branch: null,
          lastTouchedAt: AT,
          removableAt: AT + 1,
          reason: "recently used",
        },
      ],
      dirty: [{ path: "/wt/dirty", reason: "uncommitted or untracked changes" }],
    });

    expect(planCleanup(nothingToDo).isEmpty).toBe(true);
    expect(hasCleanupWork(nothingToDo)).toBe(false);
  });
});

describe("what a row says", () => {
  it("states a candidate as a proposal, with the date it became eligible and the branch that stays", () => {
    expect(
      describeRemovable({
        path: "/wt/one",
        projectId: "p1",
        branch: "volli/VC-1-x",
        lastTouchedAt: AT - 1,
        removableAt: AT,
      }),
    ).toBe(
      `Eligible for cleanup since ${new Date(AT).toLocaleDateString()}. Branch volli/VC-1-x would stay in git.`,
    );
  });

  it("says a candidate has no branch rather than inventing one", () => {
    expect(
      describeRemovable({
        path: "/wt/one",
        projectId: "p1",
        branch: null,
        lastTouchedAt: null,
        removableAt: null,
      }),
    ).toBe("Eligible for cleanup. No branch is checked out here.");
  });

  it("gives a kept folder its deadline, or admits the age is unknown", () => {
    expect(
      describeKept({
        path: "/wt/fresh",
        projectId: "p1",
        branch: null,
        lastTouchedAt: AT,
        removableAt: AT,
        reason: "recently used",
      }),
    ).toBe(`Kept until ${new Date(AT).toLocaleDateString()} — used recently.`);
    expect(
      describeKept({
        path: "/wt/undateable",
        projectId: "p1",
        branch: null,
        lastTouchedAt: null,
        removableAt: null,
        reason: "last use unknown",
      }),
    ).toBe("Kept — Volli can't tell when this was last used.");
  });

  it("distinguishes a stale RECORD from a directory", () => {
    expect(describeMetadata({ path: "/wt/gone", reason: "gitdir file points nowhere" })).toBe(
      "Stale git record — gitdir file points nowhere. Cleanup would prune it; nothing on disk changes.",
    );
  });

  it("shows the retention window the eligibility dates come from", () => {
    expect(retentionNote(14)).toBe("Unused folders become eligible after 14 day(s).");
  });
});

describe("the cleanup history", () => {
  const completed = {
    kind: "worktree" as const,
    path: "/wt/one",
    projectId: "p1",
    branch: "volli/VC-1-x",
    status: "completed" as const,
    detail: "Removed the folder.",
    finishedAt: AT,
  };

  // A02's mislabelling: every removed row said "Removed at launch", including
  // the ones a person had just asked for by hand.
  it("attributes a confirmed cleanup to the cleanup, never to the launch", () => {
    expect(describeCompleted(run(), completed)).toBe(
      `Removed by cleanup at ${new Date(AT).toLocaleString()}. Branch volli/VC-1-x is still in git.`,
    );
  });

  it("attributes a startup-sourced removal to startup", () => {
    expect(describeCompleted(run({ source: "startup" }), completed)).toBe(
      `Removed during startup at ${new Date(AT).toLocaleString()}. Branch volli/VC-1-x is still in git.`,
    );
  });

  it("falls back to the run's start when an item has no finish time of its own", () => {
    expect(describeCompleted(run(), { ...completed, finishedAt: null, branch: null })).toBe(
      `Removed by cleanup at ${new Date(AT).toLocaleString()}. No branch was checked out here.`,
    );
  });

  it("names a pruned record without pretending a folder went with it", () => {
    expect(
      describeCompleted(run(), {
        kind: "metadata",
        path: "/repo",
        projectId: "p1",
        branch: null,
        status: "completed",
        detail: "Pruned stale worktree metadata.",
        finishedAt: AT,
      }),
    ).toContain("Stale git records pruned");
  });

  it("lists only completed removals, newest run first, once per path", () => {
    const rows = historyRows([
      run({
        id: "run-2",
        items: [
          completed,
          { ...completed, path: "/wt/two", status: "skipped", detail: "still dirty" },
          // A pruned record has no directory to show, so it is not a row here.
          { ...completed, kind: "metadata", path: "/repo", branch: null },
        ],
      }),
      // An older run that took the same path: the newer record wins, and a
      // path never appears twice in the list.
      run({ id: "run-1", items: [completed] }),
    ]);

    expect(rows).toEqual([
      {
        key: "run-2:/wt/one",
        path: "/wt/one",
        meta: expect.stringContaining("Removed by cleanup"),
      },
    ]);
  });
});

describe("an interrupted run", () => {
  const interrupted = run({
    finishedAt: null,
    interruptedAt: AT + 5_000,
    items: [
      {
        kind: "worktree",
        path: "/wt/one",
        projectId: "p1",
        branch: null,
        status: "completed",
        detail: "Removed the folder.",
        finishedAt: AT,
      },
      {
        kind: "worktree",
        path: "/wt/two",
        projectId: "p1",
        branch: null,
        status: "skipped",
        detail: "uncommitted or untracked changes",
        finishedAt: AT,
      },
      {
        kind: "worktree",
        path: "/wt/three",
        projectId: "p1",
        branch: null,
        status: "pending",
        detail: null,
        finishedAt: null,
      },
    ],
  });

  // The recovery acceptance: a later launch can display the run WITHOUT
  // treating the items it already completed as still pending.
  it("says what completed, what was skipped, and what was never attempted", () => {
    expect(describeInterrupted(interrupted)).toBe(
      `A cleanup was interrupted on ${new Date(AT + 5_000).toLocaleString()}: 1 completed, 1 skipped, 1 not attempted. Scan again to review what is left.`,
    );
  });

  it("counts failures separately, and dates an unstamped run from its start", () => {
    expect(
      describeInterrupted(
        run({
          finishedAt: null,
          items: [
            {
              kind: "metadata",
              path: "/repo",
              projectId: "p1",
              branch: null,
              status: "failed",
              detail: "not a git repo",
              finishedAt: AT,
            },
          ],
        }),
      ),
    ).toBe(
      `A cleanup was interrupted on ${new Date(AT).toLocaleString()}: 0 completed, 1 failed, 0 not attempted. Scan again to review what is left.`,
    );
  });

  it("surfaces only runs that stopped with work still unaccounted for", () => {
    expect(unfinishedRuns([interrupted, run()]).map((entry) => entry.id)).toEqual(["run-1"]);
    // A run that ended with nothing pending is finished business, even if it
    // was stamped interrupted after the last item landed.
    expect(
      unfinishedRuns([
        run({ finishedAt: null, interruptedAt: AT, items: [interrupted.items[0]!] }),
      ]),
    ).toEqual([]);
  });

  it("summarises a completed run for the toast that follows it", () => {
    expect(cleanupSummary(interrupted)).toBe("1 cleaned up, 1 kept");
    expect(cleanupSummary(run())).toBe("0 cleaned up");
    expect(
      cleanupSummary(
        run({
          items: [
            {
              kind: "worktree",
              path: "/wt/one",
              projectId: "p1",
              branch: null,
              status: "failed",
              detail: "git said no",
              finishedAt: AT,
            },
          ],
        }),
      ),
    ).toBe("0 cleaned up, 1 failed");
  });
});

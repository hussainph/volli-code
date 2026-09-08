/**
 * The confirmed cleanup, held to what it promises: it acts only on the plan it
 * was handed, re-asks every question immediately before it changes anything,
 * serializes against work starting in the directory it is removing, and records
 * an immutable outcome per item.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { OrphanCleanupPlanItem } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { cleanupOrphans } from "./cleanup";
import { DEFAULT_RETENTION_TTL_DAYS, setRetentionTtlDays } from "./retention";
import { createOrphanCleanupEngine, type OrphanCleanupEngine } from "./cleanup-engine";
import { SqliteOrphanCleanupLedger } from "./cleanup-ledger";
import { projectContainerName } from "./containers";
import {
  acquireDeletionLease,
  acquireWorktreeStartLease,
  isUnderDeletion,
  resetDeletionLeasesForTest,
} from "./deletion-lease";
import { scriptedGit } from "./scripted-git";
import type { WorktreeDeps } from "./types";

let ctx: TestDb;
let tempDirs: string[] = [];
let engine: OrphanCleanupEngine;
let minted = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
/** Real-git fixtures spawn a dozen children; the 5s default is a load flake, not a signal. */
const REAL_GIT_TIMEOUT_MS = 30_000;
const now = () => NOW;
/** Command ids are UUIDs everywhere a caller mints one (docs/BOUNDARIES.md rule 1). */
const COMMAND_ID = "6f1a2b3c-4d5e-4f60-8a91-2b3c4d5e6f70";
const SECOND_COMMAND_ID = "7a2b3c4d-5e6f-4071-9b02-3c4d5e6f7081";

beforeEach(() => {
  ctx = openTestDb();
  minted = 0;
  engine = createOrphanCleanupEngine({
    ledger: new SqliteOrphanCleanupLedger(ctx.db),
    now,
    nextId: () => `id-${(minted += 1)}`,
  });
  resetDeletionLeasesForTest();
});

afterEach(() => {
  ctx.cleanup();
  resetDeletionLeasesForTest();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function ageDir(dir: string, days: number): void {
  const seconds = (NOW - days * DAY_MS) / 1000;
  utimesSync(dir, seconds, seconds);
}

/**
 * The git verb, minus the global no-write switch the RE-CHECK prefixes. The
 * removal itself is issued without it — it is the one call that means to write.
 */
function verb(args: readonly string[]): readonly string[] {
  return args[0] === "--no-optional-locks" ? args.slice(1) : args;
}

/** Real git in a temp repo, with an identity so commits do not need the host's. */
function runRepoGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  });
}

/**
 * The branch the fixture's listing reports for a container leaf. A plan item
 * carries the branch the scan SAW, and the cleanup compares it against the
 * branch git reports at mutation time (re-review C1), so a test item that
 * claims the wrong branch is correctly refused — which is why the helper
 * derives it rather than leaving each case to remember.
 */
function branchFor(path: string): string {
  return `volli/${basename(path)}`;
}

/**
 * The same repository name under a different parent — a project folder that
 * MOVED. The container name is derived from the basename, so this is precisely
 * the move the ownership gate cannot notice.
 */
function movedProject(projectPath: string): string {
  const moved = join(tempDir("proj-moved"), basename(projectPath));
  mkdirSync(moved, { recursive: true });
  return moved;
}

/** A plan item for one worktree directory, as a scan would have minted it. */
function worktreeItem(
  path: string,
  projectPath: string,
  branch: string | null = branchFor(path),
  index = 0,
): OrphanCleanupPlanItem {
  return {
    id: `rev1:worktree:${index}`,
    kind: "worktree",
    path,
    projectId: "proj-1",
    projectName: "Volli",
    projectPath,
    branch,
    gitReason: null,
  };
}

/** A plan item for one exact stale git record. */
function metadataItem(path: string, projectPath: string, index = 0): OrphanCleanupPlanItem {
  return {
    id: `rev1:metadata:${index}`,
    kind: "metadata",
    path,
    projectId: "proj-1",
    projectName: "Volli",
    projectPath,
    branch: null,
    gitReason: "gitdir file points to non-existent location",
  };
}

/**
 * One project, its owned container, and stale clean orphans inside it — the
 * fixture every cleanup case starts from. `script` overrides the git answers a
 * case needs to change (a dirty probe, a failing remove); `stale` names the
 * paths the listing reports as prunable records.
 */
function fixture(
  opts: {
    script?: (args: readonly string[], cwd: string) => string | undefined;
    orphans?: string[];
    stale?: string[];
    /** Stale records BY NAME, placed inside this fixture's own owned container. */
    staleNames?: string[];
  } = {},
) {
  const projectPath = tempDir("proj");
  const home = tempDir("home");
  const container = join(home, ".volli", "worktrees", projectContainerName(projectPath, "proj-1"));
  const names = opts.orphans ?? ["VC-1-stale"];
  const paths = names.map((name) => join(container, name));
  for (const path of paths) {
    mkdirSync(path, { recursive: true });
    ageDir(path, 400);
  }
  const stale =
    opts.stale ?? (opts.staleNames ?? ["VC-9-gone"]).map((name) => join(container, name));
  const gitDir = tempDir("gitdir");

  insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

  const removed: string[] = [];
  const pruned: string[] = [];
  const { git, calls } = scriptedGit((rawArgs, cwd) => {
    const args = verb(rawArgs);
    const scripted = opts.script?.(args, cwd);
    if (scripted !== undefined) return scripted;
    if (args[0] === "worktree" && args[1] === "prune") {
      pruned.push(cwd);
      return "";
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return (
        `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
        paths
          .map(
            (path, index) =>
              `worktree ${path}\nHEAD b${index}\nbranch refs/heads/volli/${names[index]}\n`,
          )
          .join("") +
        stale
          .map(
            (path) =>
              `worktree ${path}\nHEAD c\nprunable gitdir file points to non-existent location\n`,
          )
          .join("")
      );
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      removed.push(args[2]!);
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "log" && args[1] === "-1") return String((NOW - 400 * DAY_MS) / 1000);
    return "";
  });

  const deps: WorktreeDeps = { db: ctx.db, git, home, now, blobsRoot: "unused" };
  return { projectPath, home, container, paths, stale, deps, removed, pruned, calls };
}

/**
 * The standard request wrapper — one command id per call unless a case reuses
 * one. `retentionDays` is the window the SCAN measured its proposal against;
 * the executor refuses if the setting has moved since (re-review C1).
 */
function request(items: OrphanCleanupPlanItem[], commandId = COMMAND_ID) {
  return {
    commandId,
    scanRevision: "rev1",
    requestedItemIds: items.map((item) => item.id),
    retentionDays: DEFAULT_RETENTION_TTL_DAYS,
    items,
    source: "settings" as const,
  };
}

describe("cleanupOrphans", () => {
  it("removes the confirmed orphan, keeps its branch, prunes the confirmed record, and records both", async () => {
    const f = fixture();
    const items = [
      metadataItem(f.stale[0]!, f.projectPath),
      worktreeItem(f.paths[0]!, f.projectPath, "volli/VC-1-stale"),
    ];

    const { run, receipt } = await cleanupOrphans({ worktree: f.deps, engine }, request(items));

    expect(f.removed).toEqual(f.paths);
    expect(f.pruned).toEqual([f.projectPath]);
    // The branch survives: cleanup never passes a branch-deleting flag.
    expect(
      f.calls.some((call) => call.args.includes("--force") || call.args.includes("branch")),
    ).toBe(false);
    expect(receipt.status).toBe("completed");
    expect(run.id).toBe(COMMAND_ID);
    expect(run.scanRevision).toBe("rev1");
    expect(run.source).toBe("settings");
    expect(run.finishedAt).toBe(NOW);
    expect(run.items.map((item) => [item.kind, item.path, item.state])).toEqual([
      ["metadata", f.stale[0], "completed"],
      ["worktree", f.paths[0], "completed"],
    ]);
    expect(run.items[1]?.detail).toBe(
      "Removed the folder. Branch volli/VC-1-stale is still in git.",
    );
    // The rules it ran under are recorded with it, as ids.
    expect(run.preservation).toContain("branches");
    expect(run.preservation).toContain("active");
    // The same record is durable, not only returned.
    expect((await engine.recentRuns())[0]).toEqual(run);
  });

  it("records the accepted plan BEFORE the first change, with every item pending", async () => {
    const seen: unknown[] = [];
    const f = fixture({
      script: (args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          seen.push(structuredClone(runSnapshot));
          return "";
        }
        return undefined;
      },
    });
    let runSnapshot: unknown = null;
    // Read the durable run the instant before the mutation lands.
    const original = f.deps.git;
    const deps: WorktreeDeps = {
      ...f.deps,
      git: (args, cwd) => {
        if (verb(args)[0] === "worktree" && verb(args)[1] === "remove") {
          // Synchronous read of what the ledger already holds.
          runSnapshot = ctx.db
            .prepare("SELECT kind FROM worktree_cleanup_facts ORDER BY rowid")
            .all();
        }
        return original(args, cwd);
      },
    };

    await cleanupOrphans(
      { worktree: deps, engine },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      { kind: "command.recorded" },
      { kind: "cleanup.accepted" },
      { kind: "command.receipt.recorded" },
      // Announced before the mutation, so an interruption inside it is legible.
      { kind: "cleanup.item.started" },
    ]);
  });

  it("replays the same command id instead of removing twice", async () => {
    const f = fixture();
    const items = [worktreeItem(f.paths[0]!, f.projectPath, "volli/VC-1-stale")];

    await cleanupOrphans({ worktree: f.deps, engine }, request(items));
    const second = await cleanupOrphans({ worktree: f.deps, engine }, request(items));

    expect(f.removed).toEqual(f.paths);
    expect(second.run.items[0]?.state).toBe("completed");
  });

  it("rechecks each path immediately before the change and skips one that went dirty since the scan", async () => {
    const f = fixture({ orphans: ["VC-1-stale", "VC-2-went-dirty"] });
    const [first, second] = f.paths as [string, string];
    // The second path picks up an edit between the scan and the confirm.
    const dirtied = new Set([second]);
    const deps: WorktreeDeps = {
      ...f.deps,
      git: (args, cwd) => {
        if (verb(args)[0] === "status" && dirtied.has(cwd)) return " M src/app.ts\n";
        return f.deps.git(args, cwd);
      },
    };

    const { run } = await cleanupOrphans(
      { worktree: deps, engine },
      request([
        worktreeItem(first, f.projectPath, "volli/VC-1-stale", 0),
        worktreeItem(second, f.projectPath, "volli/VC-2-went-dirty", 1),
      ]),
    );

    expect(f.removed).toEqual([first]);
    expect(run.items.map((item) => [item.path, item.state, item.detail])).toEqual([
      [first, "completed", expect.stringContaining("Removed")],
      [second, "skipped", expect.stringMatching(/uncommitted or untracked changes/)],
    ]);
  });

  // A live PTY or agent inside the checkout is the protection the orphan sweep
  // never had and the manual Delete always did (A02). One module answers it now,
  // so the two paths cannot drift apart again.
  for (const [surface, refusal] of [
    ["terminal", "A terminal is still running in this worktree. Close it first."],
    ["agent", "An agent is still running in this worktree. Stop it first."],
  ] as const) {
    it(`skips a path a live ${surface} is standing in — the same protection manual Delete uses`, async () => {
      const f = fixture();

      const { run } = await cleanupOrphans(
        {
          worktree: f.deps,
          engine,
          // Reported one level DOWN, the way a PTY reports its own cwd: the
          // guard has to see a directory inside the target as blocking it.
          busyWorktreeSites: async (target) => [{ directory: join(target, "src"), surface }],
        },
        request([worktreeItem(f.paths[0]!, f.projectPath)]),
      );

      expect(f.removed).toEqual([]);
      expect(run.items[0]).toEqual(expect.objectContaining({ state: "skipped", detail: refusal }));
    });
  }

  it("catches work that starts DURING the release await, before it removes anything", async () => {
    const f = fixture();
    // Nothing is live when the first check runs; a terminal appears while the
    // agent bindings are being released. The re-check after every await is what
    // has to see it (review C4).
    let releaseHappened = false;
    const { run } = await cleanupOrphans(
      {
        worktree: f.deps,
        engine,
        busyWorktreeSites: async (target) =>
          releaseHappened ? [{ directory: target, surface: "terminal" as const }] : [],
        releaseAgentSites: async () => {
          releaseHappened = true;
          return { released: [], stillOpen: [] };
        },
      },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/terminal/i) }),
    );
  });

  // The seam the re-review named: a durable write used to sit between the last
  // check and `git worktree remove`, so anything that changed the world inside
  // that write was applied to a verdict taken before it. The `started` fact is
  // now written BEFORE the last look, and these cases change the world from
  // inside that write to prove the gate still catches it.
  describe("the seam between announcing intent and mutating", () => {
    /** Every ordered act of one item, so the shape of the run is the assertion. */
    function timelineEngine(timeline: string[]): OrphanCleanupEngine {
      return {
        ...engine,
        beginItem: async (input) => {
          timeline.push("announced");
          await engine.beginItem(input);
        },
        settleItem: async (input) => {
          timeline.push(`settled:${input.state}`);
          await engine.settleItem(input);
        },
      };
    }

    it("asks what is live, then removes, with no durable write in between", async () => {
      const f = fixture();
      const timeline: string[] = [];
      const deps: WorktreeDeps = {
        ...f.deps,
        git: (args, cwd) => {
          if (verb(args)[0] === "worktree" && verb(args)[1] === "remove") timeline.push("removed");
          return f.deps.git(args, cwd);
        },
      };

      await cleanupOrphans(
        {
          worktree: deps,
          engine: timelineEngine(timeline),
          busyWorktreeSites: async () => {
            timeline.push("asked-what-is-live");
            return [];
          },
          releaseAgentSites: async () => {
            timeline.push("released");
            return { released: [], stillOpen: [] };
          },
        },
        request([worktreeItem(f.paths[0]!, f.projectPath)]),
      );

      // The intent is durable BEFORE the last look, and the last look is the
      // last thing that happens before the folder goes. Nothing — no write, no
      // release, no second question — sits between them.
      expect(timeline).toEqual([
        "asked-what-is-live",
        "released",
        "announced",
        "asked-what-is-live",
        "removed",
        "settled:completed",
      ]);
    });

    it("lists the stale records, then prunes, with no durable write in between", async () => {
      const f = fixture();
      const timeline: string[] = [];
      const deps: WorktreeDeps = {
        ...f.deps,
        git: (args, cwd) => {
          const verbs = verb(args);
          if (verbs[0] === "worktree" && verbs[1] === "list") timeline.push("listed");
          if (verbs[0] === "worktree" && verbs[1] === "prune") timeline.push("pruned");
          return f.deps.git(args, cwd);
        },
      };

      await cleanupOrphans(
        { worktree: deps, engine: timelineEngine(timeline) },
        request([metadataItem(f.stale[0]!, f.projectPath)]),
      );

      // `git worktree prune` cannot be aimed, so the set it will take is
      // re-listed and then pruned in the same turn: a record going stale in
      // between is a record nobody confirmed.
      expect(timeline).toEqual(["announced", "listed", "pruned", "settled:completed"]);
    });

    /** An engine whose `beginItem` write runs `mutate` while it is in flight. */
    function engineThatChangesTheWorldWhileAnnouncing(mutate: () => void): OrphanCleanupEngine {
      return {
        ...engine,
        beginItem: async (input) => {
          await engine.beginItem(input);
          mutate();
        },
      };
    }

    it("catches a ticket that claims the path inside the beginItem write", async () => {
      const f = fixture();
      const path = f.paths[0]!;

      const { run } = await cleanupOrphans(
        {
          worktree: f.deps,
          engine: engineThatChangesTheWorldWhileAnnouncing(() => {
            insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-9", status: "done" }));
            updateTicketFields(ctx.db, "ticket-9", { worktreePath: path }, 1);
          }),
        },
        request([worktreeItem(path, f.projectPath)]),
      );

      expect(f.removed).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/ticket/i) }),
      );
    });

    it("catches a retention window that changes inside the beginItem write", async () => {
      const f = fixture();

      const { run } = await cleanupOrphans(
        {
          worktree: f.deps,
          engine: engineThatChangesTheWorldWhileAnnouncing(() => {
            setRetentionTtlDays(ctx.db, 90, NOW);
          }),
        },
        request([worktreeItem(f.paths[0]!, f.projectPath)]),
      );

      expect(f.removed).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({
          state: "skipped",
          detail: expect.stringMatching(/retention window changed from 14 to 90/i),
        }),
      );
    });

    it("catches a record that goes stale inside the beginItem write, before the prune", async () => {
      // `git worktree prune` is repo-wide, so a record that appears between the
      // confirmation and the prune would be dropped by a prune nobody
      // confirmed. The re-list happens after the announcement, in the same turn
      // as the prune.
      const f = fixture();
      let extraRecord = false;
      const deps: WorktreeDeps = {
        ...f.deps,
        git: (args, cwd) => {
          if (verb(args)[0] === "worktree" && verb(args)[1] === "list" && extraRecord) {
            return (
              `worktree ${f.projectPath}\nHEAD a\nbranch refs/heads/main\n` +
              `${f.stale
                .map(
                  (path) =>
                    `worktree ${path}\nHEAD c\nprunable gitdir file points to non-existent location\n`,
                )
                .join("")}` +
              `worktree ${join(f.container, "VC-11-appeared")}\nHEAD d\nprunable gitdir file points to non-existent location\n`
            );
          }
          return f.deps.git(args, cwd);
        },
      };

      const { run } = await cleanupOrphans(
        {
          worktree: deps,
          engine: engineThatChangesTheWorldWhileAnnouncing(() => {
            extraRecord = true;
          }),
        },
        request([metadataItem(f.stale[0]!, f.projectPath)]),
      );

      expect(f.pruned).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({
          state: "skipped",
          detail: expect.stringMatching(/changed since the scan/i),
        }),
      );
    });

    it("catches a ticket that claims a confirmed record inside the beginItem write", async () => {
      // Set equality alone cannot see this: the stale set is unchanged, but the
      // record is now one the preservation policy protects.
      const f = fixture();

      const { run } = await cleanupOrphans(
        {
          worktree: f.deps,
          engine: engineThatChangesTheWorldWhileAnnouncing(() => {
            insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-8", status: "done" }));
            updateTicketFields(ctx.db, "ticket-8", { worktreePath: f.stale[0]! }, 1);
          }),
        },
        request([metadataItem(f.stale[0]!, f.projectPath)]),
      );

      expect(f.pruned).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({
          state: "skipped",
          detail: expect.stringMatching(/ticket now claims/i),
        }),
      );
    });
  });

  it("skips a folder whose branch is not the branch the confirmation named", async () => {
    // The same address, a different checkout: removed and re-added on another
    // branch between the scan and the click. The dialog named a branch, and a
    // directory holding a different one is not what anybody reviewed.
    const f = fixture();
    const path = f.paths[0]!;

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath, "volli/VC-1-what-was-scanned")]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        state: "skipped",
        detail: expect.stringMatching(
          /was volli\/VC-1-what-was-scanned .* and is volli\/VC-1-stale/i,
        ),
      }),
    );
  });

  it("skips a folder whose project checkout moved since the confirmation", async () => {
    const f = fixture();
    // Moved, but still called the same thing — so the container name is
    // unchanged and the ownership gate cannot see it. Only comparing the
    // project path the plan named can (re-review C1).
    const moved = movedProject(f.projectPath);
    ctx.db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(moved, "proj-1");

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/folder moved/i) }),
    );
  });

  it("skips a stale record whose project checkout moved since the confirmation", async () => {
    const f = fixture();
    const moved = movedProject(f.projectPath);
    ctx.db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(moved, "proj-1");

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([metadataItem(f.stale[0]!, f.projectPath)]),
    );

    expect(f.pruned).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/folder moved/i) }),
    );
  });

  it("skips a stale record that is not inside a folder this install owns", async () => {
    const f = fixture({ stale: [join(tempDir("elsewhere"), "someones-own-worktree")] });

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([metadataItem(f.stale[0]!, f.projectPath)]),
    );

    expect(f.pruned).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        state: "skipped",
        detail: expect.stringMatching(/isn't inside a folder this install owns/i),
      }),
    );
  });

  it("gives up on a release that never settles rather than holding the folder forever", async () => {
    const f = fixture();
    const path = f.paths[0]!;

    const { run } = await cleanupOrphans(
      {
        worktree: f.deps,
        engine,
        // The promise nobody resolves — an executor that will not answer.
        releaseAgentSites: () => new Promise(() => {}),
        releaseTimeoutMs: 10,
      },
      request([worktreeItem(path, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        state: "skipped",
        detail: expect.stringMatching(/couldn't confirm/i),
      }),
    );
    // And the lease is back, so the next scan/cleanup and every terminal start
    // under this path are not refused for the life of the process.
    expect(isUnderDeletion(path)).toBe(false);
  });

  it("will not take a folder something is starting work in, and blocks a start under one it holds", async () => {
    const f = fixture();
    const path = f.paths[0]!;

    // A terminal is mid-start inside the checkout: it passed its own guard and
    // is awaiting harness files. Nothing about it is visible to the activity
    // supplier yet — the lease is the only thing that can see it.
    const starting = acquireWorktreeStartLease(join(path, "src"));
    expect(starting).not.toBeNull();

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/already/i) }),
    );
    starting?.release();

    // And the other direction: while a cleanup holds the folder, a start inside
    // it is refused rather than born into a directory that is going away.
    const deleting = acquireDeletionLease(path);
    expect(acquireWorktreeStartLease(join(path, "src"))).toBeNull();
    deleting?.release();
    expect(acquireWorktreeStartLease(join(path, "src"))).not.toBeNull();
  });

  it("refuses to remove a checkout whose agent binding would not close", async () => {
    const f = fixture();

    const { run } = await cleanupOrphans(
      {
        worktree: f.deps,
        engine,
        releaseAgentSites: async () => ({ released: [], stillOpen: ["session-7"] }),
      },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        state: "skipped",
        detail: expect.stringMatching(/still bound/i),
      }),
    );
  });

  it("holds a deletion lease across the removal, and skips a path something else already holds", async () => {
    const f = fixture();
    const path = f.paths[0]!;
    let leasedDuringRelease = false;

    await cleanupOrphans(
      {
        worktree: f.deps,
        engine,
        releaseAgentSites: async (directory) => {
          // The lease is what stops a terminal being born in this directory
          // while the release is still running.
          leasedDuringRelease = isUnderDeletion(join(directory, "src"));
          return { released: [], stillOpen: [] };
        },
      },
      request([worktreeItem(path, f.projectPath)]),
    );
    expect(leasedDuringRelease).toBe(true);
    // And it is given back once the item settles.
    expect(isUnderDeletion(path)).toBe(false);

    // A path another act is already holding is skipped, not waited on.
    const held = acquireDeletionLease(path);
    expect(held).not.toBeNull();
    const second = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath)], SECOND_COMMAND_ID),
    );
    expect(second.run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/already/i) }),
    );
    held?.release();
  });

  it("ends the structured bindings rooted in a checkout before removing it", async () => {
    const released: string[] = [];
    const f = fixture();

    await cleanupOrphans(
      {
        worktree: f.deps,
        engine,
        releaseAgentSites: async (directory) => {
          released.push(directory);
          return { released: [], stillOpen: [] };
        },
      },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(released).toEqual(f.paths);
  });

  it("skips a path that became recently used since the scan", async () => {
    const f = fixture();
    const path = f.paths[0]!;
    utimesSync(path, NOW / 1000, NOW / 1000); // touched a moment ago

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/recently/i) }),
    );
  });

  it("skips a path whose git state cannot be read", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "status") throw new Error("permission denied");
        return undefined;
      },
    });

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        state: "skipped",
        detail: expect.stringMatching(/could not read git status/),
      }),
    );
  });

  it("skips an old path whose branch-tip date cannot be read", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "log" && args[1] === "-1") throw new Error("cannot read branch tip");
        return undefined;
      },
    });

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/last used/i) }),
    );
  });

  it("refuses a path outside the containers this database owns", async () => {
    const f = fixture();
    const elsewhere = tempDir("personal");

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(elsewhere, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/outside/i) }),
    );
  });

  it("refuses the container directory itself, however stale", async () => {
    const f = fixture();
    ageDir(f.container, 400);

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(f.container, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(expect.objectContaining({ state: "skipped" }));
  });

  it("refuses a path a ticket started pointing at after the scan", async () => {
    const f = fixture();
    const path = f.paths[0]!;
    insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-1", status: "done" }));
    updateTicketFields(ctx.db, "ticket-1", { worktreePath: path, branch: "volli/VC-1-stale" }, 1);

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/ticket/i) }),
    );
  });

  it("records a failed removal as failed, not as completed", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "worktree" && args[1] === "remove") throw new Error("git said no");
        return undefined;
      },
    });

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "failed", detail: expect.stringContaining("git said no") }),
    );
    expect((await engine.recentRuns())[0]?.items[0]?.state).toBe("failed");
  });

  it("records a failed prune per confirmed record without abandoning the worktree behind it", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "worktree" && args[1] === "prune") throw new Error("not a git repo");
        return undefined;
      },
    });

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([metadataItem(f.stale[0]!, f.projectPath), worktreeItem(f.paths[0]!, f.projectPath)]),
    );

    expect(run.items.map((item) => item.state)).toEqual(["failed", "completed"]);
    expect(f.removed).toEqual(f.paths);
  });

  describe("stale git records", () => {
    it("skips every confirmed record when the project's stale set grew since the scan", async () => {
      const f = fixture({ stale: [] });
      const container = f.container;
      // Confirmed one record; the repo now reports a second one as well, so a
      // repo-wide prune would take something nobody confirmed.
      const deps: WorktreeDeps = {
        ...f.deps,
        git: (args, cwd) => {
          if (verb(args)[0] === "worktree" && verb(args)[1] === "list") {
            return (
              `worktree ${f.projectPath}\nHEAD a\nbranch refs/heads/main\n` +
              `worktree ${join(container, "VC-9-gone")}\nHEAD c\nprunable gitdir file points to non-existent location\n` +
              `worktree ${join(container, "VC-10-appeared")}\nHEAD d\nprunable gitdir file points to non-existent location\n`
            );
          }
          return f.deps.git(args, cwd);
        },
      };

      const { run } = await cleanupOrphans(
        { worktree: deps, engine },
        request([metadataItem(join(container, "VC-9-gone"), f.projectPath)]),
      );

      expect(f.pruned).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({
          state: "skipped",
          detail: expect.stringMatching(/changed since the scan/i),
        }),
      );
    });

    it("skips a record that is no longer stale at all", async () => {
      const f = fixture({ stale: [] });

      const { run } = await cleanupOrphans(
        { worktree: f.deps, engine },
        request([metadataItem(join(f.container, "VC-9-gone"), f.projectPath)]),
      );

      expect(f.pruned).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({
          state: "skipped",
          detail: expect.stringMatching(/no longer stale/i),
        }),
      );
    });

    it("gives every confirmed record of one project its own recorded result", async () => {
      const f = fixture({ staleNames: ["VC-9-gone", "VC-10-also-gone"] });
      const [first, second] = f.stale as [string, string];

      const { run } = await cleanupOrphans(
        { worktree: f.deps, engine },
        request([metadataItem(first, f.projectPath, 0), metadataItem(second, f.projectPath, 1)]),
      );

      // One prune, two records, two outcomes — never one lumped "project" row.
      expect(f.pruned).toEqual([f.projectPath]);
      expect(run.items.map((item) => [item.path, item.state])).toEqual([
        [first, "completed"],
        [second, "completed"],
      ]);
    });

    it("skips a record whose project is no longer tracked", async () => {
      const f = fixture();
      ctx.db.prepare("DELETE FROM projects WHERE id = ?").run("proj-1");

      const { run } = await cleanupOrphans(
        { worktree: f.deps, engine },
        request([metadataItem(f.stale[0]!, f.projectPath)]),
      );

      expect(f.pruned).toEqual([]);
      expect(run.items[0]).toEqual(
        expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/no longer/i) }),
      );
    });
  });

  // The whole act, against real git: what the branch looks like afterwards is
  // the claim that matters, and no scripted runner can make it.
  it(
    "takes the directory and leaves the branch, against a real repository",
    async () => {
      const home = tempDir("home");
      const originPath = tempDir("origin");
      runRepoGit(originPath, ["init", "-q", "--bare", "-b", "main"]);
      const projectPath = tempDir("proj");
      runRepoGit(projectPath, ["init", "-q", "-b", "main"]);
      writeFileSync(join(projectPath, "README.md"), "base\n");
      runRepoGit(projectPath, ["add", "."]);
      runRepoGit(projectPath, ["commit", "-q", "-m", "base"]);
      runRepoGit(projectPath, ["remote", "add", "origin", originPath]);
      runRepoGit(projectPath, ["push", "-q", "origin", "main"]);

      const container = join(
        home,
        ".volli",
        "worktrees",
        projectContainerName(projectPath, "proj-1"),
      );
      mkdirSync(container, { recursive: true });
      const orphan = join(container, "VC-5-finished");
      runRepoGit(projectPath, ["worktree", "add", "-q", "-b", "volli/VC-5-finished", orphan]);
      runRepoGit(projectPath, ["push", "-q", "origin", "volli/VC-5-finished"]);

      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
      const { git } = scriptedGit((args, cwd) => runRepoGit(cwd, args));

      const { run } = await cleanupOrphans(
        {
          worktree: {
            db: ctx.db,
            git,
            home,
            // Past the window measured from the fixture's own fresh commit.
            now: () => Date.now() + 400 * DAY_MS,
            blobsRoot: "unused",
          },
          engine,
        },
        request([worktreeItem(orphan, projectPath, "volli/VC-5-finished")]),
      );

      expect(run.items.map((item) => item.state)).toEqual(["completed"]);
      expect(existsSync(orphan)).toBe(false);
      // The branch, its commit, and the remote link all survive the removal.
      expect(runRepoGit(projectPath, ["branch", "--list", "volli/VC-5-finished"])).toContain(
        "volli/VC-5-finished",
      );
      expect(runRepoGit(projectPath, ["worktree", "list", "--porcelain"])).not.toContain(orphan);
    },
    REAL_GIT_TIMEOUT_MS,
  );

  it("leaves completed and never-attempted items legible when the run is interrupted between items", async () => {
    const f = fixture({ orphans: ["VC-1-first", "VC-2-second", "VC-3-third"] });
    const [first, second, third] = f.paths as [string, string, string];

    await expect(
      cleanupOrphans(
        {
          worktree: f.deps,
          engine,
          busyWorktreeSites: async (target) => {
            // Stands in for the process going away between two items.
            if (target === second) throw new Error("app exited");
            return [];
          },
        },
        request([
          worktreeItem(first, f.projectPath, branchFor(first), 0),
          worktreeItem(second, f.projectPath, branchFor(second), 1),
          worktreeItem(third, f.projectPath, branchFor(third), 2),
        ]),
      ),
    ).rejects.toThrow("app exited");

    expect(f.removed).toEqual([first]);
    const [persisted] = await engine.recentRuns();
    expect(persisted?.finishedAt).toBeNull();
    expect(persisted?.items.map((item) => [item.path, item.state])).toEqual([
      [first, "completed"],
      [second, "pending"],
      [third, "pending"],
    ]);
    // And the lease the interrupted item held is not stranded.
    expect(isUnderDeletion(second)).toBe(false);
  });
});

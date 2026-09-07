/**
 * The confirmed cleanup, held to what it promises: it acts only on the plan it
 * was handed, re-asks every question immediately before it changes anything,
 * serializes against work starting in the directory it is removing, and records
 * an immutable outcome per item.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { OrphanCleanupPlanItem } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { cleanupOrphans } from "./cleanup";
import { createOrphanCleanupEngine, type OrphanCleanupEngine } from "./cleanup-engine";
import { SqliteOrphanCleanupLedger } from "./cleanup-ledger";
import { projectContainerName } from "./containers";
import { acquireDeletionLease, isUnderDeletion, resetDeletionLeasesForTest } from "./deletion-lease";
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

/** A plan item for one worktree directory, as a scan would have minted it. */
function worktreeItem(
  path: string,
  projectPath: string,
  branch: string | null,
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
  const stale = opts.stale ?? [join(container, "VC-9-gone")];
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

/** The standard request wrapper — one command id per call unless a case reuses one. */
function request(items: OrphanCleanupPlanItem[], commandId = "cmd-1") {
  return { commandId, scanRevision: "rev1", items, source: "settings" as const };
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
    expect(run.id).toBe("cmd-1");
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
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
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
        request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
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
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ state: "skipped", detail: expect.stringMatching(/terminal/i) }),
    );
  });

  it("refuses to remove a checkout whose agent binding would not close", async () => {
    const f = fixture();

    const { run } = await cleanupOrphans(
      {
        worktree: f.deps,
        engine,
        releaseAgentSites: async () => ({ released: [], stillOpen: ["session-7"] }),
      },
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
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
      request([worktreeItem(path, f.projectPath, null)]),
    );
    expect(leasedDuringRelease).toBe(true);
    // And it is given back once the item settles.
    expect(isUnderDeletion(path)).toBe(false);

    // A path another act is already holding is skipped, not waited on.
    const held = acquireDeletionLease(path);
    expect(held).not.toBeNull();
    const second = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath, null)], "cmd-2"),
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
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
    );

    expect(released).toEqual(f.paths);
  });

  it("skips a path that became recently used since the scan", async () => {
    const f = fixture();
    const path = f.paths[0]!;
    utimesSync(path, NOW / 1000, NOW / 1000); // touched a moment ago

    const { run } = await cleanupOrphans(
      { worktree: f.deps, engine },
      request([worktreeItem(path, f.projectPath, null)]),
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
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
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
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
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
      request([worktreeItem(elsewhere, f.projectPath, null)]),
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
      request([worktreeItem(f.container, f.projectPath, null)]),
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
      request([worktreeItem(path, f.projectPath, null)]),
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
      request([worktreeItem(f.paths[0]!, f.projectPath, null)]),
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
      request([
        metadataItem(f.stale[0]!, f.projectPath),
        worktreeItem(f.paths[0]!, f.projectPath, null),
      ]),
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
      const f = fixture({
        stale: [join(tempDir("home2"), "a"), join(tempDir("home3"), "b")],
      });
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
          worktreeItem(first, f.projectPath, null, 0),
          worktreeItem(second, f.projectPath, null, 1),
          worktreeItem(third, f.projectPath, null, 2),
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

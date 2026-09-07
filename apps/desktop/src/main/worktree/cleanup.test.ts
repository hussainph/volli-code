import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { cleanupOrphans } from "./cleanup";
import { readCleanupRuns } from "./cleanup-log";
import { projectContainerName } from "./containers";
import { scriptedGit } from "./scripted-git";
import type { WorktreeDeps } from "./types";

let ctx: TestDb;
let tempDirs: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
/** Real-git fixtures spawn a dozen children; the 5s default is a load flake, not a signal. */
const REAL_GIT_TIMEOUT_MS = 30_000;
const now = () => NOW;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
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
 * One project, its owned container, and a stale clean orphan inside it — the
 * fixture every cleanup case starts from. `script` overrides the git answers a
 * case needs to change (a dirty probe, a failing remove).
 */
function fixture(
  opts: {
    script?: (args: readonly string[], cwd: string) => string | undefined;
    orphans?: string[];
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
  const gitDir = tempDir("gitdir");

  insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

  const removed: string[] = [];
  const pruned: string[] = [];
  const { git, calls } = scriptedGit((rawArgs, cwd) => {
    const args = verb(rawArgs);
    const scripted = opts.script?.(args, cwd);
    if (scripted !== undefined) return scripted;
    if (args[0] === "worktree" && args[1] === "prune") {
      if (!args.includes("--dry-run")) pruned.push(cwd);
      return "Removing worktrees/gone: gitdir file points to non-existent location\n";
    }
    if (args[0] === "worktree" && args[1] === "list") {
      return (
        `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
        paths
          .map(
            (path, index) =>
              `worktree ${path}\nHEAD b${index}\nbranch refs/heads/volli/${names[index]}\n`,
          )
          .join("")
      );
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      removed.push(args[2]!);
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    return "";
  });

  const deps: WorktreeDeps = { db: ctx.db, git, home, now, blobsRoot: "unused" };
  return { projectPath, home, container, paths, deps, removed, pruned, calls };
}

describe("cleanupOrphans", () => {
  it("removes the confirmed orphan, keeps its branch, prunes the confirmed project's metadata, and records both", async () => {
    const f = fixture();

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: f.paths, projectIds: ["proj-1"], source: "settings" },
    );

    expect(f.removed).toEqual(f.paths);
    expect(f.pruned).toEqual([f.projectPath]);
    // The branch survives: cleanup never passes a branch-deleting flag.
    expect(
      f.calls.some((call) => call.args.includes("--force") || call.args.includes("branch")),
    ).toBe(false);
    expect(run.source).toBe("settings");
    expect(run.startedAt).toBe(NOW);
    expect(run.finishedAt).toBe(NOW);
    expect(run.items).toEqual([
      {
        kind: "metadata",
        path: f.projectPath,
        projectId: "proj-1",
        branch: null,
        status: "completed",
        detail: "Pruned stale worktree metadata.",
        finishedAt: NOW,
      },
      {
        kind: "worktree",
        path: f.paths[0],
        projectId: "proj-1",
        branch: "volli/VC-1-stale",
        status: "completed",
        detail: "Removed the folder. Branch volli/VC-1-stale is still in git.",
        finishedAt: NOW,
      },
    ]);
    // The same record is durable, not only returned.
    expect(readCleanupRuns(ctx.db)).toEqual([run]);
  });

  it("writes the record BEFORE the first change, with every item still pending", async () => {
    const seenWhileRemoving: unknown[] = [];
    const f = fixture({
      script: (args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          seenWhileRemoving.push(structuredClone(readCleanupRuns(ctx.db)));
          return "";
        }
        return undefined;
      },
    });

    await cleanupOrphans(
      { worktree: f.deps },
      { paths: f.paths, projectIds: [], source: "settings" },
    );

    expect(seenWhileRemoving).toHaveLength(1);
    expect(seenWhileRemoving[0]).toEqual([
      expect.objectContaining({
        finishedAt: null,
        items: [expect.objectContaining({ path: f.paths[0], status: "pending" })],
        // What this run promised to preserve, recorded with the run itself.
        preservation: expect.arrayContaining([expect.stringMatching(/branch/i)]),
      }),
    ]);
  });

  it("rechecks each path immediately before the change and skips one that went dirty since the scan", async () => {
    const f = fixture({ orphans: ["VC-1-stale", "VC-2-went-dirty"] });
    const [first, second] = f.paths as [string, string];
    // The second path picks up an edit between the scan and the confirm.
    const dirtied = new Set([second]);
    const deps = {
      ...f.deps,
      git: ((args: readonly string[], cwd: string) => {
        if (verb(args)[0] === "status" && dirtied.has(cwd)) return " M src/app.ts\n";
        return f.deps.git(args, cwd);
      }) as WorktreeDeps["git"],
    };

    const run = await cleanupOrphans(
      { worktree: deps },
      { paths: [first, second], projectIds: [], source: "settings" },
    );

    expect(f.removed).toEqual([first]);
    expect(run.items.map((item) => [item.path, item.status, item.detail])).toEqual([
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
      const path = f.paths[0]!;

      const run = await cleanupOrphans(
        {
          worktree: f.deps,
          // Reported one level DOWN, the way a PTY reports its own cwd: the
          // guard has to see a directory inside the target as blocking it.
          busyWorktreeSites: async (target) => [{ directory: join(target, "src"), surface }],
        },
        { paths: [path], projectIds: [], source: "settings" },
      );

      expect(f.removed).toEqual([]);
      expect(run.items[0]).toEqual(expect.objectContaining({ status: "skipped", detail: refusal }));
    });
  }

  it("ends the structured bindings rooted in a checkout before removing it", async () => {
    const released: string[] = [];
    const f = fixture();

    await cleanupOrphans(
      {
        worktree: f.deps,
        releaseAgentSites: async (directory) => {
          released.push(directory);
          return { released: [], stillOpen: [] };
        },
      },
      { paths: f.paths, projectIds: [], source: "settings" },
    );

    expect(released).toEqual(f.paths);
  });

  it("skips a path that became recently used since the scan", async () => {
    const f = fixture();
    const path = f.paths[0]!;
    utimesSync(path, NOW / 1000, NOW / 1000); // touched a moment ago

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: [path], projectIds: [], source: "settings" },
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ status: "skipped", detail: expect.stringMatching(/recently/i) }),
    );
  });

  it("skips a path whose git state cannot be read", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "status") throw new Error("permission denied");
        return undefined;
      },
    });

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: f.paths, projectIds: [], source: "settings" },
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        status: "skipped",
        detail: expect.stringMatching(/could not read git status/),
      }),
    );
  });

  it("refuses a path outside the containers this database owns", async () => {
    const f = fixture();
    const elsewhere = tempDir("personal");

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: [elsewhere], projectIds: [], source: "settings" },
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({
        status: "skipped",
        detail: expect.stringMatching(/outside/i),
      }),
    );
  });

  it("refuses the container directory itself, however stale", async () => {
    const f = fixture();
    ageDir(f.container, 400);

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: [f.container], projectIds: [], source: "settings" },
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(expect.objectContaining({ status: "skipped" }));
  });

  it("refuses a path a ticket still points at", async () => {
    const f = fixture();
    const path = f.paths[0]!;
    insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-1", status: "done" }));
    updateTicketFields(ctx.db, "ticket-1", { worktreePath: path, branch: "volli/VC-1-stale" }, 1);

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: [path], projectIds: [], source: "settings" },
    );

    expect(f.removed).toEqual([]);
    expect(run.items[0]).toEqual(
      expect.objectContaining({ status: "skipped", detail: expect.stringMatching(/ticket/i) }),
    );
  });

  it("records a failed removal as failed, not as completed", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "worktree" && args[1] === "remove") throw new Error("git said no");
        return undefined;
      },
    });

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: f.paths, projectIds: [], source: "settings" },
    );

    expect(run.items[0]).toEqual(
      expect.objectContaining({ status: "failed", detail: expect.stringContaining("git said no") }),
    );
    expect(readCleanupRuns(ctx.db)[0]?.items[0]?.status).toBe("failed");
  });

  it("records a failed prune without abandoning the worktree items behind it", async () => {
    const f = fixture({
      script: (args) => {
        if (args[0] === "worktree" && args[1] === "prune" && !args.includes("--dry-run")) {
          throw new Error("not a git repo");
        }
        return undefined;
      },
    });

    const run = await cleanupOrphans(
      { worktree: f.deps },
      { paths: f.paths, projectIds: ["proj-1"], source: "settings" },
    );

    expect(run.items.map((item) => item.status)).toEqual(["failed", "completed"]);
    expect(f.removed).toEqual(f.paths);
  });

  // The interruption case: the app stops mid-run. What survives has to say
  // which items were done and which were never attempted — a run that reads as
  // "all pending" on the next launch would re-offer work already carried out.
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

      const run = await cleanupOrphans(
        {
          worktree: {
            db: ctx.db,
            git,
            home,
            // Past the window measured from the fixture's own fresh commit.
            now: () => Date.now() + 400 * DAY_MS,
            blobsRoot: "unused",
          },
        },
        { paths: [orphan], projectIds: ["proj-1"], source: "settings" },
      );

      expect(run.items.map((item) => item.status)).toEqual(["completed", "completed"]);
      expect(existsSync(orphan)).toBe(false);
      // The branch, its commit, and the remote link all survive the removal.
      expect(runRepoGit(projectPath, ["branch", "--list", "volli/VC-5-finished"])).toContain(
        "volli/VC-5-finished",
      );
      expect(runRepoGit(projectPath, ["worktree", "list", "--porcelain"])).not.toContain(orphan);
    },
    REAL_GIT_TIMEOUT_MS,
  );

  it("leaves a durable record of completed and never-attempted items when the run is interrupted", async () => {
    const f = fixture({ orphans: ["VC-1-first", "VC-2-second", "VC-3-third"] });
    const [first, second, third] = f.paths as [string, string, string];

    await expect(
      cleanupOrphans(
        {
          worktree: f.deps,
          busyWorktreeSites: async (target) => {
            // Stands in for the process going away between two items.
            if (target === second) throw new Error("app exited");
            return [];
          },
        },
        { paths: [first, second, third], projectIds: [], source: "settings" },
      ),
    ).rejects.toThrow("app exited");

    expect(f.removed).toEqual([first]);
    const [persisted] = readCleanupRuns(ctx.db);
    expect(persisted?.finishedAt).toBeNull();
    expect(persisted?.items.map((item) => [item.path, item.status])).toEqual([
      [first, "completed"],
      [second, "pending"],
      [third, "pending"],
    ]);
  });
});

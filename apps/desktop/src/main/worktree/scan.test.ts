import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { projectContainerName } from "./containers";
import { canonicalize } from "./paths";
import { scanOrphans } from "./scan";
import { scriptedGit } from "./scripted-git";

let ctx: TestDb;
let tempDirs: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Real-git fixtures spawn a dozen children; the 5s default is a load flake, not a signal. */
const REAL_GIT_TIMEOUT_MS = 30_000;
/** A fixed "now" so the retention gate is judged against a clock the test owns. */
const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
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

/** Backdates a directory's mtime so the scan reads it as untouched for `days`. */
function ageDir(dir: string, days: number): void {
  const seconds = (NOW - days * DAY_MS) / 1000;
  utimesSync(dir, seconds, seconds);
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
 * The git verb, minus the global read-only switch the scan prefixes to every
 * call. Scripted handlers match on the verb; the flag itself is asserted once,
 * where it matters.
 */
function verb(args: readonly string[]): readonly string[] {
  return args[0] === "--no-optional-locks" ? args.slice(1) : args;
}

/**
 * A real repository with a real remote, and the container this database owns
 * for it. The remote matters: without one, EVERY commit is "unreachable from
 * any remote" and the dirty predicate keeps the checkout — correctly, but then
 * the fixture could never show a removable candidate at all.
 */
function realProject(home: string): { projectPath: string; container: string } {
  const originPath = tempDir("origin");
  runRepoGit(originPath, ["init", "-q", "--bare", "-b", "main"]);
  const projectPath = tempDir("proj");
  runRepoGit(projectPath, ["init", "-q", "-b", "main"]);
  writeFileSync(join(projectPath, "README.md"), "base\n");
  runRepoGit(projectPath, ["add", "."]);
  runRepoGit(projectPath, ["commit", "-q", "-m", "base"]);
  runRepoGit(projectPath, ["remote", "add", "origin", originPath]);
  runRepoGit(projectPath, ["push", "-q", "origin", "main"]);
  const container = join(home, ".volli", "worktrees", projectContainerName(projectPath, "proj-1"));
  mkdirSync(container, { recursive: true });
  return { projectPath, container };
}

/** A linked worktree whose branch is pushed — so it reads clean, the way a finished ticket's does. */
function addPushedWorktree(projectPath: string, path: string, branch: string): void {
  runRepoGit(projectPath, ["worktree", "add", "-q", "-b", branch, path]);
  runRepoGit(projectPath, ["push", "-q", "origin", branch]);
}

/** Every file/dir path under `root`, with its mtime — the before/after fingerprint. */
function fingerprint(root: string): Record<string, number> {
  const seen: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      seen[path] = statSync(path).mtimeMs;
      if (entry.isDirectory()) walk(path);
    }
  };
  if (existsSync(root)) walk(root);
  return seen;
}

describe("scanOrphans is read-only", () => {
  // The A02 acceptance test: the inspection a person reaches for must be
  // answerable without changing anything. Real git, a real container, a real
  // linked worktree — because the claim is about what git's ADMIN DATA looks
  // like afterwards, and a scripted runner cannot testify to that.
  it(
    "leaves the fixture container, the checkout, and git's worktree metadata exactly as it found them",
    async () => {
      const home = tempDir("home");
      const { projectPath, container } = realProject(home);
      const orphan = join(container, "VC-1-abandoned");
      addPushedWorktree(projectPath, orphan, "volli/VC-1-abandoned");
      // Stale by the measure the scan takes: the dir mtime. (Its branch tip is
      // fresh, which is why this case moves the clock rather than the commit.)
      ageDir(orphan, 400);
      // A second registered worktree whose directory a user deleted by hand: its
      // admin entry is exactly what `git worktree prune` would delete.
      const stranded = join(container, "VC-2-deleted-by-hand");
      addPushedWorktree(projectPath, stranded, "volli/VC-2-deleted");
      rmSync(stranded, { recursive: true, force: true });

      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

      const adminDir = join(projectPath, ".git", "worktrees");
      const before = { admin: fingerprint(adminDir), container: fingerprint(container) };
      const { git, calls } = scriptedGit((args, cwd) => runRepoGit(cwd, args));

      const report = await scanOrphans({
        db: ctx.db,
        git,
        home,
        // The fixture's branch tip is committed NOW, and the newer of dir mtime
        // and tip is what dates an orphan — so the clock has to stand past the
        // retention window from that tip for this checkout to read as stale.
        now: () => Date.now() + 400 * DAY_MS,
        blobsRoot: "unused",
      });

      // Nothing moved: not the checkout, not git's admin data for either entry.
      expect(fingerprint(adminDir)).toEqual(before.admin);
      expect(fingerprint(container)).toEqual(before.container);
      expect(existsSync(orphan)).toBe(true);
      expect(existsSync(join(adminDir, "VC-2-deleted-by-hand"))).toBe(true);

      // …and it ran no mutating git verb. `prune --dry-run` is the only prune
      // shape allowed here; `worktree remove` may not appear at all. Every call
      // also carries git's own no-write switch — without it, `status` rewrites
      // the worktree index and the assertions above fail.
      const issued = calls.map((call) => call.args.join(" "));
      expect(issued.every((line) => line.startsWith("--no-optional-locks "))).toBe(true);
      expect(issued.some((line) => line.includes("worktree remove"))).toBe(false);
      expect(issued.some((line) => line.includes("worktree prune"))).toBe(false);

      // …and it wrote no cleanup history either: a scan is not an act.
      expect(
        ctx.db.prepare("SELECT COUNT(*) AS n FROM worktree_cleanup_commands").get(),
      ).toEqual({ n: 0 });
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM worktree_cleanup_facts").get()).toEqual({
        n: 0,
      });

      // The report still says everything a cleanup would need to act on.
      expect(report.removable.map((entry) => canonicalize(entry.path))).toEqual([
        canonicalize(orphan),
      ]);
      expect(report.prunable).toEqual([
        {
          id: `${report.revision}:metadata:0`,
          projectId: "proj-1",
          projectName: expect.any(String),
          projectPath,
          path: expect.stringContaining("VC-2-deleted-by-hand"),
          reason: expect.stringMatching(/gitdir|non-existent/i),
        },
      ]);
      // The plan is the proposal a cleanup command may select from, and it
      // carries everything that command needs — no client supplies a path.
      expect(report.plan.map((item) => [item.kind, item.id])).toEqual([
        ["metadata", `${report.revision}:metadata:0`],
        ["worktree", `${report.revision}:worktree:0`],
      ]);
      expect(report.revision).not.toHaveLength(0);
      expect(report.retentionDays).toBe(14);
      expect(report.scannedAt).toBeGreaterThan(0);
      // Real git: init, commit, remote, push, two worktree adds, then the scan's
      // own children. Comfortably under a second alone, past the 5s default when
      // the whole suite runs in parallel.
    },
    REAL_GIT_TIMEOUT_MS,
  );

  it(
    "dates a clean orphan by its branch tip when the directory mtime is older, and keeps it inside the window",
    async () => {
      const home = tempDir("home");
      const { projectPath, container } = realProject(home);
      const orphan = join(container, "VC-3-just-committed");
      addPushedWorktree(projectPath, orphan, "volli/VC-3");
      ageDir(orphan, 400); // ancient dir, fresh commit — the newer of the two wins

      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

      const { git } = scriptedGit((args, cwd) => runRepoGit(cwd, args));
      const report = await scanOrphans({
        db: ctx.db,
        git,
        home,
        now: () => Date.now(),
        blobsRoot: "unused",
      });

      expect(report.removable).toEqual([]);
      expect(report.keptRecent).toEqual([
        expect.objectContaining({ branch: "volli/VC-3", reason: "recently-used" }),
      ]);
      expect(report.keptRecent.map((entry) => canonicalize(entry.path))).toEqual([
        canonicalize(orphan),
      ]);
      expect(existsSync(orphan)).toBe(true);
    },
    REAL_GIT_TIMEOUT_MS,
  );
});

describe("scanOrphans report", () => {
  it("names the removal candidate, the metadata to prune, and the reason every other path is kept", async () => {
    const projectPath = tempDir("proj");
    const knownWt = tempDir("known"); // has a DB row → ticket-linked, never a candidate
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const cleanOrphan = join(container, "clean"); // no DB row, clean, stale → candidate
    const dirtyOrphan = join(container, "dirty"); // no DB row, dirty → kept
    mkdirSync(cleanOrphan, { recursive: true });
    mkdirSync(dirtyOrphan, { recursive: true });
    ageDir(cleanOrphan, 30);
    const gitDir = tempDir("gitdir"); // empty: no sequencer files

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-1", status: "doing" }));
    updateTicketFields(ctx.db, "ticket-1", { worktreePath: knownWt, branch: "volli/VC-1-x" }, 1);

    const listPorcelain =
      `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
      `worktree ${knownWt}\nHEAD b\nbranch refs/heads/volli/VC-1-x\n` +
      `worktree ${cleanOrphan}\nHEAD c\nbranch refs/heads/orphan-clean\n` +
      `worktree ${dirtyOrphan}\nHEAD d\nbranch refs/heads/orphan-dirty\n` +
      `worktree ${join(container, "gone")}\nHEAD e\nbranch refs/heads/orphan-gone\n` +
      `prunable gitdir file points to non-existent location\n`;

    const listCalls: string[] = [];
    const { git, calls } = scriptedGit((rawArgs, cwd) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        listCalls.push(cwd);
        return listPorcelain;
      }
      // dirty probes, keyed by cwd: only the dirty orphan reports changes.
      if (args[0] === "status") return cwd === dirtyOrphan ? "?? junk\n" : "";
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
      if (args[0] === "log" && args[1] === "-1") return String((NOW - 40 * DAY_MS) / 1000);
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([
      {
        id: `${report.revision}:worktree:0`,
        path: cleanOrphan,
        projectId: "proj-1",
        projectName: expect.any(String),
        branch: "orphan-clean",
        lastTouchedAt: NOW - 30 * DAY_MS,
        // The fixture ages the directory and the tip to the same instant, and
        // a tie reads as the directory — the report says which either way
        // (review C6).
        ageBasis: "directory",
        removableAt: NOW - 30 * DAY_MS + 14 * DAY_MS,
      },
    ]);
    expect(report.prunable).toEqual([
      {
        id: `${report.revision}:metadata:0`,
        projectId: "proj-1",
        projectName: expect.any(String),
        projectPath,
        path: join(container, "gone"),
        reason: "gitdir file points to non-existent location",
      },
    ]);
    expect(report.dirty).toEqual([
      {
        path: dirtyOrphan,
        projectId: "proj-1",
        projectName: expect.any(String),
        reason: expect.stringMatching(/untracked/),
      },
    ]);
    // Read-only, even under the scripted runner: neither `worktree remove` nor
    // `worktree prune` is ever issued — the stale record is READ off the listing.
    expect(calls.some((call) => call.args.includes("remove"))).toBe(false);
    expect(calls.some((call) => call.args.includes("prune"))).toBe(false);
    // The dirty check reuses the project's one listing — never a per-orphan
    // re-spawn from the worktree cwd.
    expect(listCalls).toEqual([projectPath]);
  });

  // Every one of these keeps the directory in place, and each says why. They
  // are the safeguards VC-113 bought; A02 keeps them under the read-only scan.
  const dirtyCases: {
    name: string;
    script: (orphan: string, gitDir: string) => (args: readonly string[], cwd: string) => string;
    reason: RegExp;
  }[] = [
    {
      name: "changed files",
      script: (orphan, gitDir) => (args, cwd) => {
        if (args[0] === "status") return cwd === orphan ? " M src/app.ts\n" : "";
        if (args[0] === "rev-parse") return gitDir;
        return "";
      },
      reason: /uncommitted or untracked changes/,
    },
    {
      name: "untracked files",
      script: (orphan, gitDir) => (args, cwd) => {
        if (args[0] === "status") return cwd === orphan ? "?? notes.md\n" : "";
        if (args[0] === "rev-parse") return gitDir;
        return "";
      },
      reason: /uncommitted or untracked changes/,
    },
    {
      name: "unpushed commits",
      script: (orphan, gitDir) => (args, cwd) => {
        if (args[0] === "rev-parse") return gitDir;
        if (args[0] === "log" && cwd === orphan) return "abc123\n";
        return "";
      },
      reason: /not reachable from the base or any remote/,
    },
    {
      name: "inaccessible git state",
      script: (orphan) => (args, cwd) => {
        if (args[0] === "status" && cwd === orphan) throw new Error("permission denied");
        return "";
      },
      reason: /could not read git status/,
    },
    {
      name: "submodule drift",
      script: (orphan, gitDir) => (args, cwd) => {
        if (args[0] === "rev-parse") return gitDir;
        if (args[0] === "submodule" && cwd === orphan) return "+abc123 vendor/lib (v1)\n";
        return "";
      },
      reason: /submodule drift/,
    },
  ];

  for (const testCase of dirtyCases) {
    it(`keeps a stale orphan with ${testCase.name}, and says so`, async () => {
      const projectPath = tempDir("proj");
      const home = tempDir("home");
      const container = join(
        home,
        ".volli",
        "worktrees",
        projectContainerName(projectPath, "proj-1"),
      );
      const orphan = join(container, "VC-9-dirty");
      mkdirSync(orphan, { recursive: true });
      ageDir(orphan, 400);
      const gitDir = tempDir("gitdir");

      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

      const inner = testCase.script(orphan, gitDir);
      const { git } = scriptedGit((rawArgs, cwd) => {
        const args = verb(rawArgs);
        if (args[0] === "worktree" && args[1] === "list") {
          return (
            `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
            `worktree ${orphan}\nHEAD b\nbranch refs/heads/volli/VC-9-dirty\n`
          );
        }
        if (args[0] === "worktree" && args[1] === "prune") return "";
        return inner(args, cwd);
      });

      const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

      expect(report.removable).toEqual([]);
      expect(report.dirty).toEqual([
        {
          path: orphan,
          projectId: "proj-1",
          projectName: expect.any(String),
          reason: expect.stringMatching(testCase.reason),
        },
      ]);
    });
  }

  it("keeps a LOCKED clean orphan, however stale", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const orphan = join(container, "VC-10-locked");
    mkdirSync(orphan, { recursive: true });
    ageDir(orphan, 400);
    const gitDir = tempDir("gitdir");

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${orphan}\nHEAD b\nbranch refs/heads/volli/VC-10-locked\nlocked\n`
        );
      }
      if (args[0] === "rev-parse") return gitDir;
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.dirty).toEqual([
      {
        path: orphan,
        projectId: "proj-1",
        projectName: expect.any(String),
        reason: expect.stringMatching(/locked/),
      },
    ]);
  });

  it("keeps a clean orphan whose age it cannot read, and says the age is unknown", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    // Never created on disk and no branch tip to read: the age is unknowable.
    const orphan = join(container, "VC-11-undateable");
    mkdirSync(container, { recursive: true });
    const gitDir = tempDir("gitdir");

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${orphan}\nHEAD b\nbranch refs/heads/volli/VC-11\n`
        );
      }
      if (args[0] === "rev-parse") return gitDir;
      // Only the DATE read fails; the dirty predicate's own `log` still answers,
      // so this case is about an unknowable age and nothing else.
      if (args[0] === "log" && args[1] === "-1") throw new Error("no such ref");
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.keptRecent).toEqual([
      {
        path: orphan,
        projectId: "proj-1",
        projectName: expect.any(String),
        branch: "volli/VC-11",
        lastTouchedAt: null,
        ageBasis: null,
        removableAt: null,
        reason: "age-unknown",
        detail: null,
      },
    ]);
  });

  it("keeps an old directory when its branch-tip date cannot be read", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const orphan = join(container, "VC-12-unreadable-tip");
    mkdirSync(orphan, { recursive: true });
    ageDir(orphan, 400);
    const gitDir = tempDir("gitdir");

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${orphan}\nHEAD b\nbranch refs/heads/volli/VC-12\n`
        );
      }
      if (args[0] === "rev-parse") return gitDir;
      // The unreachable-commit probe succeeds, but the distinct date read
      // fails. Falling back to the old directory mtime would wrongly offer the
      // path for cleanup even though the newer half of the clock is unknown.
      if (args[0] === "log" && args[1] === "-1") throw new Error("cannot read branch tip");
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.keptRecent).toEqual([
      expect.objectContaining({
        path: orphan,
        lastTouchedAt: null,
        removableAt: null,
        reason: "age-unknown",
      }),
    ]);
  });

  it("spares a clean orphan touched inside the retention window, with the date it becomes eligible", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const justPushed = join(container, "VC-7-just-pushed");
    mkdirSync(justPushed, { recursive: true });
    ageDir(justPushed, 2);

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${justPushed}\nHEAD b\nbranch refs/heads/volli/VC-7-just-pushed\n`
        );
      }
      if (args[0] === "log" && args[1] === "-1") return String((NOW - 40 * DAY_MS) / 1000);
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.keptRecent).toEqual([
      {
        path: justPushed,
        projectId: "proj-1",
        projectName: expect.any(String),
        branch: "volli/VC-7-just-pushed",
        lastTouchedAt: NOW - 2 * DAY_MS,
        // The folder was touched two days ago, later than the 40-day-old tip.
        ageBasis: "directory",
        removableAt: NOW - 2 * DAY_MS + 14 * DAY_MS,
        reason: "recently-used",
        detail: null,
      },
    ]);
  });

  // VC-113: two installs of Volli own two containers under one shared root.
  it("never reports ANOTHER INSTALL's container under the same worktree root", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const root = join(home, ".volli", "worktrees");
    const ourContainer = join(root, projectContainerName(projectPath, "proj-1"));
    const theirWorktree = join(
      root,
      projectContainerName(projectPath, "f8e04558-dev"),
      "VC-99-their-ticket",
    );
    mkdirSync(ourContainer, { recursive: true });
    mkdirSync(theirWorktree, { recursive: true });
    ageDir(theirWorktree, 400);

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${theirWorktree}\nHEAD b\nbranch refs/heads/volli/VC-99-their-ticket\n`
        );
      }
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.keptRecent).toEqual([]);
    expect(report.dirty).toEqual([]);
  });

  it("never proposes a worktree registered AT the container itself", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    mkdirSync(container, { recursive: true });
    ageDir(container, 400);

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${container}\nHEAD b\nbranch refs/heads/container-as-worktree\n`
        );
      }
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.keptRecent).toEqual([]);
    expect(report.dirty).toEqual([]);
  });

  it("leaves a git-registered worktree OUTSIDE the app root out of the report entirely", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const personalWt = tempDir("personal");

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
          `worktree ${personalWt}\nHEAD b\nbranch refs/heads/feature\n`
        );
      }
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.removable).toEqual([]);
    expect(report.dirty).toEqual([]);
  });

  it("reports a DB-known directory that git no longer registers", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const strandedWt = join(container, "VC-82-stranded");
    mkdirSync(strandedWt, { recursive: true });

    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
    insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-82", status: "done" }));
    updateTicketFields(ctx.db, "ticket-82", { worktreePath: strandedWt, branch: "volli/VC-82" }, 1);

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") {
        return `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n`;
      }
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.dirty).toEqual([
      {
        path: strandedWt,
        projectId: "proj-1",
        projectName: expect.any(String),
        reason: expect.stringMatching(/ticket still points here/i),
      },
    ]);
    expect(report.removable).toEqual([]);
  });

  // Review C5: a project whose listing fails used to be skipped in silence,
  // which made every checkout in its container read as "not registered with
  // git" — a different, and wrong, statement.
  it("REPORTS a project whose git can't be read instead of skipping it in silence", async () => {
    const home = tempDir("home");
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo" }));
    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") throw new Error("not a git repo");
      return "";
    });
    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });
    expect(report).toEqual({
      revision: expect.any(String),
      scannedAt: NOW,
      retentionDays: 14,
      prunable: [],
      keptMetadata: [],
      removable: [],
      keptRecent: [],
      unreadableProjects: [
        {
          projectId: "proj-1",
          projectName: expect.any(String),
          projectPath: "/repo",
          error: expect.stringContaining("not a git repo"),
        },
      ],
      dirty: [],
      plan: [],
    });
  });

  it("does not describe an unreadable project's own checkouts as unregistered", async () => {
    const projectPath = tempDir("proj");
    const home = tempDir("home");
    const container = join(
      home,
      ".volli",
      "worktrees",
      projectContainerName(projectPath, "proj-1"),
    );
    const orphan = join(container, "VC-13-unknowable");
    mkdirSync(orphan, { recursive: true });
    insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));

    const { git } = scriptedGit((rawArgs) => {
      const args = verb(rawArgs);
      if (args[0] === "worktree" && args[1] === "list") throw new Error("index.lock exists");
      return "";
    });

    const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

    expect(report.unreadableProjects).toHaveLength(1);
    // The container's leaves are NOT re-described as forgotten by git; the one
    // honest statement is that the project could not be read.
    expect(report.dirty).toEqual([]);
    expect(report.removable).toEqual([]);
  });
  // Review C5: the sweep's activity guard used to live only in the destructive
  // half, so a checkout somebody was working in was PROPOSED and then refused
  // after the confirmation. The report is where that has to be said.
  describe("live work", () => {
    function activeFixture() {
      const projectPath = tempDir("proj");
      const home = tempDir("home");
      const container = join(
        home,
        ".volli",
        "worktrees",
        projectContainerName(projectPath, "proj-1"),
      );
      const orphan = join(container, "VC-20-busy");
      mkdirSync(orphan, { recursive: true });
      ageDir(orphan, 400);
      const gitDir = tempDir("gitdir");
      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
      const { git } = scriptedGit((rawArgs) => {
        const args = verb(rawArgs);
        if (args[0] === "worktree" && args[1] === "list") {
          return (
            `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
            `worktree ${orphan}\nHEAD b\nbranch refs/heads/volli/VC-20\n`
          );
        }
        if (args[0] === "rev-parse") return gitDir;
        if (args[0] === "log" && args[1] === "-1") return String((NOW - 400 * DAY_MS) / 1000);
        return "";
      });
      return { git, home, orphan };
    }

    for (const [surface, refusal] of [
      ["terminal", /terminal/i],
      ["agent", /agent/i],
    ] as const) {
      it(`keeps a stale clean orphan a live ${surface} is standing in, and says so`, async () => {
        const f = activeFixture();

        const report = await scanOrphans(
          { db: ctx.db, git: f.git, home: f.home, now, blobsRoot: "unused" },
          { busyWorktreeSites: async (target) => [{ directory: target, surface }] },
        );

        expect(report.removable).toEqual([]);
        expect(report.plan).toEqual([]);
        expect(report.keptRecent).toEqual([
          expect.objectContaining({
            path: f.orphan,
            reason: "active",
            detail: expect.stringMatching(refusal),
          }),
        ]);
      });
    }

    it("keeps a checkout whose occupancy cannot be established", async () => {
      const f = activeFixture();

      const report = await scanOrphans(
        { db: ctx.db, git: f.git, home: f.home, now, blobsRoot: "unused" },
        {
          busyWorktreeSites: async () => {
            throw new Error("the runtime is unreadable");
          },
        },
      );

      expect(report.removable).toEqual([]);
      expect(report.keptRecent[0]).toEqual(
        expect.objectContaining({ reason: "active", detail: expect.stringMatching(/couldn/i) }),
      );
    });

    it("proposes it when nothing is live in it", async () => {
      const f = activeFixture();

      const report = await scanOrphans(
        { db: ctx.db, git: f.git, home: f.home, now, blobsRoot: "unused" },
        { busyWorktreeSites: async () => [] },
      );

      expect(report.removable.map((entry) => entry.path)).toEqual([f.orphan]);
    });
  });

  // Review C2: prunable records were collected before the ownership and ticket
  // gates the directories go through, so the confirmation could offer to prune
  // a record that is not this flow's to touch.
  describe("stale git records", () => {
    function staleFixture(recordPath: string) {
      const projectPath = tempDir("proj");
      const home = tempDir("home");
      const container = join(
        home,
        ".volli",
        "worktrees",
        projectContainerName(projectPath, "proj-1"),
      );
      mkdirSync(container, { recursive: true });
      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
      const { git } = scriptedGit((rawArgs) => {
        const args = verb(rawArgs);
        if (args[0] === "worktree" && args[1] === "list") {
          return (
            `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
            `worktree ${recordPath}\nHEAD b\nprunable gitdir file points to non-existent location\n`
          );
        }
        return "";
      });
      return { git, home, container, projectPath };
    }

    it("proposes a stale record inside a container this database owns", async () => {
      const projectPath = tempDir("proj");
      const home = tempDir("home");
      const container = join(
        home,
        ".volli",
        "worktrees",
        projectContainerName(projectPath, "proj-1"),
      );
      const record = join(container, "VC-30-gone");
      mkdirSync(container, { recursive: true });
      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
      const { git } = scriptedGit((rawArgs) => {
        const args = verb(rawArgs);
        if (args[0] === "worktree" && args[1] === "list") {
          return (
            `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
            `worktree ${record}\nHEAD b\nprunable gitdir file points to non-existent location\n`
          );
        }
        return "";
      });

      const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

      expect(report.prunable.map((entry) => entry.path)).toEqual([record]);
      expect(report.keptMetadata).toEqual([]);
      expect(report.plan.map((item) => item.kind)).toEqual(["metadata"]);
    });

    it("keeps a stale record pointing OUTSIDE the containers this database owns", async () => {
      const personal = tempDir("personal");
      const f = staleFixture(personal);

      const report = await scanOrphans({
        db: ctx.db,
        git: f.git,
        home: f.home,
        now,
        blobsRoot: "unused",
      });

      expect(report.prunable).toEqual([]);
      expect(report.plan).toEqual([]);
      expect(report.keptMetadata).toEqual([
        expect.objectContaining({ path: personal, reason: "not-owned" }),
      ]);
    });

    it("keeps a stale record a ticket still points at", async () => {
      const projectPath = tempDir("proj");
      const home = tempDir("home");
      const container = join(
        home,
        ".volli",
        "worktrees",
        projectContainerName(projectPath, "proj-1"),
      );
      const record = join(container, "VC-31-ticket");
      mkdirSync(container, { recursive: true });
      insertProject(ctx.db, testProject({ id: "proj-1", path: projectPath }));
      insertTicket(ctx.db, testTicket("proj-1", { id: "ticket-31", status: "done" }));
      updateTicketFields(ctx.db, "ticket-31", { worktreePath: record, branch: "volli/VC-31" }, 1);
      const { git } = scriptedGit((rawArgs) => {
        const args = verb(rawArgs);
        if (args[0] === "worktree" && args[1] === "list") {
          return (
            `worktree ${projectPath}\nHEAD a\nbranch refs/heads/main\n` +
            `worktree ${record}\nHEAD b\nprunable gitdir file points to non-existent location\n`
          );
        }
        return "";
      });

      const report = await scanOrphans({ db: ctx.db, git, home, now, blobsRoot: "unused" });

      expect(report.prunable).toEqual([]);
      expect(report.keptMetadata).toEqual([
        expect.objectContaining({ path: record, reason: "ticket-linked" }),
      ]);
    });
  });
});

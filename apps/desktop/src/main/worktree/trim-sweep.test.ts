/**
 * The manual trim across a whole install (VC-340), against a real repository with
 * real `git worktree add` checkouts under a fake `~`. Scripted git could not
 * carry this one: the acceptance the ticket asks for is that `.git/worktrees`
 * ends up agreeing with what is on disk, and only real git metadata can be wrong
 * about that in the first place.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields } from "../db/tickets-repo";
import { runGitCapturing, runGitCapturingAsync } from "./git";
import { projectContainerName } from "./containers";
import { canonicalize } from "./paths";
import { scanTrimTargets, trimAllWorktrees } from "./trim-sweep";
import { setTrimSettings } from "./trim-settings";

let ctx: TestDb;
const temporaryRoots: string[] = [];

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
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

function write(root: string, relative: string, contents = "x\n"): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

interface Install {
  /** The fake `~` the worktree module reads through `deps.home`. */
  home: string;
  projectPath: string;
  container: string;
}

/** A project checkout that ignores `node_modules/` and `.env`, plus its container dir. */
function seedInstall(): Install {
  const home = mkdtempSync(join(tmpdir(), "volli-trim-home-"));
  temporaryRoots.push(home);
  const projectPath = join(home, "repo");
  mkdirSync(projectPath, { recursive: true });
  git(projectPath, ["init", "-q", "-b", "main"]);
  write(projectPath, ".gitignore", "node_modules/\n.env\n");
  write(projectPath, "package.json", "{}\n");
  git(projectPath, ["add", "-A"]);
  git(projectPath, ["commit", "-q", "-m", "base"]);
  insertProject(ctx.db, testProject({ id: PROJECT_ID, path: projectPath }));
  const container = join(
    home,
    ".volli",
    "worktrees",
    projectContainerName(projectPath, PROJECT_ID),
  );
  mkdirSync(container, { recursive: true });
  return { home, projectPath, container };
}

/** A real worktree in the install's container, carrying artifacts and a `.env`. */
function addWorktree(
  install: Install,
  name: string,
  opts: { ticketId?: string; artifacts?: boolean } = {},
): string {
  // Canonicalized, because git reports canonical paths and macOS aliases /tmp
  // to /private/tmp — the same aliasing `paths.ts` exists to neutralize.
  const path = canonicalize(join(install.container, name));
  git(install.projectPath, ["worktree", "add", "-q", "-b", `volli/${name}`, path]);
  if (opts.artifacts !== false) {
    write(path, "node_modules/left-pad/index.js", "module.exports = 1;\n");
    write(path, ".env", "TOKEN=secret\n");
  }
  if (opts.ticketId !== undefined) {
    insertTicket(ctx.db, testTicket(PROJECT_ID, { id: opts.ticketId, status: "done" }));
    updateTicketFields(
      ctx.db,
      opts.ticketId,
      { worktreePath: path, branch: `volli/${name}`, baseBranch: "main" },
      1,
    );
  }
  return path;
}

function deps(install: Install, busy: { directory: string; surface?: "agent" }[] = []) {
  return {
    worktree: {
      db: ctx.db,
      git: runGitCapturing,
      gitAsync: runGitCapturingAsync,
      home: install.home,
      blobsRoot: "unused",
    },
    busySites: async () => busy,
  };
}

/** How many admin entries `.git/worktrees` holds for the project. */
function metadataEntries(install: Install): string[] {
  const dir = join(install.projectPath, ".git", "worktrees");
  return existsSync(dir) ? readdirSync(dir).toSorted() : [];
}

describe("scanTrimTargets — the Settings table's read", () => {
  it("reports each owned worktree, its ticket, and whether it carries artifacts", async () => {
    const install = seedInstall();
    const withArtifacts = addWorktree(install, "VC-1-a", { ticketId: "t1" });
    const clean = addWorktree(install, "VC-2-b", { artifacts: false });

    const scan = await scanTrimTargets(deps(install));

    expect(scan.worktrees).toEqual([
      {
        path: withArtifacts,
        projectId: PROJECT_ID,
        ticketId: "t1",
        branch: "volli/VC-1-a",
        artifactCount: 1, // node_modules/ — the .env is preserved, so it doesn't count
        activeReason: null,
      },
      {
        path: clean,
        projectId: PROJECT_ID,
        ticketId: null,
        branch: "volli/VC-2-b",
        artifactCount: 0,
        activeReason: null,
      },
    ]);
  });

  it("names the worktree that is off limits instead of hiding it", async () => {
    const install = seedInstall();
    const busyPath = addWorktree(install, "VC-3-c");

    const scan = await scanTrimTargets(deps(install, [{ directory: busyPath, surface: "agent" }]));

    expect(scan.worktrees[0]?.activeReason).toBe(
      "An agent is still running in this worktree. Stop it first.",
    );
  });

  it("never leaves the containers this database owns", async () => {
    const install = seedInstall();
    addWorktree(install, "VC-4-d");
    // Somebody's own worktree, outside the app's container entirely.
    const personal = canonicalize(join(install.home, "review"));
    git(install.projectPath, ["worktree", "add", "-q", "-b", "review", personal]);
    write(personal, "node_modules/x/index.js");

    const scan = await scanTrimTargets(deps(install));

    expect(scan.worktrees.map((entry) => entry.path)).not.toContain(personal);
    expect(scan.worktrees).toHaveLength(1);
  });
});

describe("trimAllWorktrees — the Settings action", () => {
  it("trims every non-active worktree, keeps their config, and totals the result", async () => {
    const install = seedInstall();
    const first = addWorktree(install, "VC-5-e");
    const second = addWorktree(install, "VC-6-f");

    const report = await trimAllWorktrees(deps(install));

    expect(report.worktrees).toHaveLength(2);
    expect(report.removedCount).toBe(2);
    expect(report.totalBytes).toBeGreaterThan(0);
    expect(report.skipped).toEqual([]);
    expect(report.pruned).toEqual([PROJECT_ID]);
    for (const path of [first, second]) {
      expect(existsSync(join(path, "node_modules"))).toBe(false);
      expect(existsSync(join(path, ".env"))).toBe(true);
      expect(existsSync(join(path, "package.json"))).toBe(true);
    }
    // Every worktree report names what it kept, so the action can show it.
    expect(report.worktrees[0]?.kept.map((entry) => entry.path)).toEqual([".env"]);
  });

  it("refuses a worktree with a live Session and says which, trimming the rest", async () => {
    const install = seedInstall();
    const busyPath = addWorktree(install, "VC-7-g");
    const other = addWorktree(install, "VC-8-h");

    const report = await trimAllWorktrees(
      deps(install, [{ directory: busyPath, surface: "agent" }]),
    );

    expect(report.skipped).toEqual([
      { path: busyPath, reason: "An agent is still running in this worktree. Stop it first." },
    ]);
    expect(existsSync(join(busyPath, "node_modules"))).toBe(true);
    expect(existsSync(join(other, "node_modules"))).toBe(false);
  });

  it("refuses a worktree with uncommitted changes to tracked files", async () => {
    const install = seedInstall();
    const dirty = addWorktree(install, "VC-9-i");
    write(dirty, "package.json", '{"edited":true}\n');

    const report = await trimAllWorktrees(deps(install));

    expect(report.skipped).toEqual([
      { path: dirty, reason: "This worktree has uncommitted changes to tracked files." },
    ]);
    expect(existsSync(join(dirty, "node_modules"))).toBe(true);
  });

  it("leaves .git/worktrees agreeing with what is on disk", async () => {
    const install = seedInstall();
    addWorktree(install, "VC-10-j");
    const vanished = addWorktree(install, "VC-11-k");
    // A checkout removed behind git's back — one of the 28 stale admin entries
    // the audit found, reproduced exactly.
    rmSync(vanished, { recursive: true, force: true });
    expect(metadataEntries(install)).toHaveLength(2);

    const report = await trimAllWorktrees(deps(install));

    expect(report.pruned).toEqual([PROJECT_ID]);
    expect(metadataEntries(install)).toEqual(["VC-10-j"]);
    expect(
      readdirSync(install.container, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      ),
    ).toHaveLength(1);
  });

  it("measures without removing under dryRun, and leaves git metadata alone", async () => {
    const install = seedInstall();
    const path = addWorktree(install, "VC-12-l");
    const vanished = addWorktree(install, "VC-13-m");
    rmSync(vanished, { recursive: true, force: true });

    const report = await trimAllWorktrees(deps(install), { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.removedCount).toBe(1);
    expect(report.totalBytes).toBeGreaterThan(0);
    expect(report.pruned).toEqual([]);
    expect(existsSync(join(path, "node_modules"))).toBe(true);
    expect(metadataEntries(install)).toHaveLength(2);
  });

  it("honours an extended allowlist across the whole pass", async () => {
    const install = seedInstall();
    const path = addWorktree(install, "VC-14-n");
    write(path, ".gitignore", "node_modules/\n.env\n*.sqlite\n");
    write(path, "fixtures.sqlite", "binary\n");
    // The edited .gitignore is a tracked change, so commit it — the trim would
    // otherwise (correctly) refuse the whole worktree.
    git(path, ["commit", "-qam", "ignore sqlite"]);
    setTrimSettings(ctx.db, { keepPatterns: [".env", "*.sqlite"] }, 1);

    const report = await trimAllWorktrees(deps(install));

    expect(existsSync(join(path, "fixtures.sqlite"))).toBe(true);
    expect(existsSync(join(path, ".env"))).toBe(true);
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    expect(report.worktrees[0]?.kept.map((entry) => entry.path).toSorted()).toEqual([
      ".env",
      "fixtures.sqlite",
    ]);
  });
});

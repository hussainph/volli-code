import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { importBlob } from "../blob-import";
import { blobsRoot, removeBlob } from "../blob-store";
import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { getTicketRow, insertTicket } from "../db/tickets-repo";
import { ensure } from "./ensure";
import { runGitCapturing, runGitCapturingAsync } from "./git";
import { resetPhasesForTest } from "./phase";
import { readWorktreeStatus } from "./read";
import { scriptedGit } from "./scripted-git";
import type { WorktreePhase } from "./types";

let ctx: TestDb;
let tempDirs: string[] = [];

beforeEach(() => {
  ctx = openTestDb();
  resetPhasesForTest();
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

const BRANCH = "volli/VC-12-mcp-server";

// The sync runner is `execFileSync` in production: one call from the ensure
// pipeline freezes every window (VC-16's rainbow wheel). Poisoning it is the
// seam-level statement that ensure never touches it.
const poisonedSyncGit = (): string => {
  throw new Error("ensure must not use the blocking sync git runner");
};

/** Seeds a doing ticket in a real temp project dir with `base_branch = main`. */
function seed(projectPath: string) {
  const project = testProject({ id: "proj-abcdef12", path: projectPath, baseBranch: "main" });
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id, {
    id: "ticket-1",
    ticketNumber: 12,
    title: "MCP server",
    status: "doing",
  });
  insertTicket(ctx.db, ticket);
  return { project, ticket };
}

/** A git that green-lights a fresh worktree: empty worktree list, new branch, local `main` base. */
function happyGit(projectPath: string) {
  return scriptedGit((args) => {
    if (args[0] === "worktree" && args[1] === "list") {
      return `worktree ${projectPath}\nHEAD abc\nbranch refs/heads/main\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (args[3] === "refs/heads/main") return "sha\n";
      throw new Error("no such ref"); // ticket branch doesn't exist → new branch
    }
    return ""; // worktree add / prune
  });
}

describe("ensure — success", () => {
  it("materializes the worktree through the async git runner alone — the sync runner would block the main process", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { gitAsync, countMatching } = happyGit(projectPath);

    const result = await ensure(
      { db: ctx.db, git: poisonedSyncGit, gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(true);
      expect(result.value.identity.branch).toBe(BRANCH);
    }
    expect(countMatching(["worktree", "add", "-b", BRANCH])).toBe(1);
  });

  it("runs the pipeline, transitions phases, persists identity, and returns it", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { git, gitAsync, countMatching } = happyGit(projectPath);
    const phases: WorktreePhase[] = [];

    const result = await ensure(
      {
        db: ctx.db,
        git,
        gitAsync,
        home,
        onPhase: (_, phase) => phases.push(phase),
        blobsRoot: "unused",
      },
      "ticket-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // A fresh `git worktree add` ran → created true (gates the setup command).
      expect(result.value.created).toBe(true);
      const identity = result.value.identity;
      expect(identity.branch).toBe(BRANCH);
      expect(identity.baseBranch).toBe("main");
      // <container>-<short-id(8)>/<DISPLAY-ID>-<slug>
      expect(identity.worktreePath).toContain("/.volli/worktrees/");
      expect(identity.worktreePath?.endsWith("-proj-abc/VC-12-mcp-server")).toBe(true);
    }
    expect(phases).toEqual(["creating", "copying", "ready"]);

    // Add ran exactly once, with -b for a new branch.
    expect(countMatching(["worktree", "add", "-b", BRANCH])).toBe(1);

    // Identity persisted on the row + a worktree_changed event emitted.
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.branch).toBe(BRANCH);
    expect(row.base_branch).toBe("main");
    expect(row.worktree_path).toContain("/.volli/worktrees/");
    const kinds = listTicketEvents(ctx.db, "ticket-1").map((e) => e.payload.kind);
    expect(kinds).toContain("worktree_changed");
  });

  it("skips the Main-checkout copy walk on a reuse boot — the walk belongs to creation only", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");

    // First ensure materializes the identity (git faked — create the dir it stamped).
    const first = happyGit(projectPath);
    const created = await ensure(
      { db: ctx.db, git: first.git, gitAsync: first.gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const worktreePath = created.value.identity.worktreePath!;
    mkdirSync(worktreePath, { recursive: true });

    // A NEW include-matched file lands in the Main checkout afterwards…
    writeFileSync(join(projectPath, ".env"), "SECRET=1");

    // …and a later Session boots into the EXISTING worktree. That boot ran the
    // full Main-checkout walk on every start — the multisecond stall the ticket's
    // follow-up comment reports — so the copy step must not run here at all.
    const reuse = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return (
          `worktree ${projectPath}\nHEAD abc\nbranch refs/heads/main\n` +
          `worktree ${worktreePath}\nHEAD def\nbranch refs/heads/${BRANCH}\n`
        );
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return "sha\n";
      return "";
    });
    const result = await ensure(
      { db: ctx.db, git: reuse.git, gitAsync: reuse.gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.created).toBe(false);
    expect(reuse.countMatching(["worktree", "add"])).toBe(0);
    // The new .env stays untransported — the copy step is a creation step.
    expect(existsSync(join(worktreePath, ".env"))).toBe(false);
  });

  it("is single-flight: two concurrent ensures run the pipeline once, and only the leader reports created", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { git, gitAsync, countMatching } = happyGit(projectPath);
    const deps = { db: ctx.db, git, gitAsync, home, blobsRoot: "unused" };

    const [a, b] = await Promise.all([ensure(deps, "ticket-1"), ensure(deps, "ticket-1")]);

    expect(countMatching(["worktree", "add"])).toBe(1);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Same materialized worktree, but `created` (the setup-command gate) fires
      // exactly once — the leader reports it, the joiner sees created:false so
      // it never re-runs a created-only side effect (fix 7).
      expect(a.value.identity).toEqual(b.value.identity);
      expect(a.value.created).toBe(true);
      expect(b.value.created).toBe(false);
    }
  });
});

describe("ensure — failure", () => {
  it("records worktree_failed (stage create) and does not persist identity on a reconcile collision", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const phases: WorktreePhase[] = [];
    // The ticket branch is checked out elsewhere → hard fail at the create stage.
    const { git, gitAsync } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return `worktree ${projectPath}\nHEAD abc\nbranch refs/heads/main\nworktree /elsewhere\nHEAD def\nbranch refs/heads/${BRANCH}\n`;
      }
      return "";
    });

    const result = await ensure(
      {
        db: ctx.db,
        git,
        gitAsync,
        home,
        onPhase: (_, phase) => phases.push(phase),
        blobsRoot: "unused",
      },
      "ticket-1",
    );

    expect(result.ok).toBe(false);
    expect(phases).toEqual(["creating", "failed"]);

    const events = listTicketEvents(ctx.db, "ticket-1");
    const failed = events.find((e) => e.payload.kind === "worktree_failed");
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "create" });

    // Never persisted, never launched in the main checkout.
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
  });

  it("records worktree_failed (stage copy) when the copy step throws", async () => {
    // A non-existent project dir: git is faked through `add`, but the copy
    // step's walk of the main checkout throws ENOENT → copy-stage failure.
    seed("/volli-nonexistent-project-dir");
    const home = tempDir("home");
    const { git, gitAsync } = happyGit("/volli-nonexistent-project-dir");

    const result = await ensure(
      { db: ctx.db, git, gitAsync, home, blobsRoot: "unused" },
      "ticket-1",
    );

    expect(result.ok).toBe(false);
    const failed = listTicketEvents(ctx.db, "ticket-1").find(
      (e) => e.payload.kind === "worktree_failed",
    );
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "copy" });
  });

  it("errors on an unknown ticket without touching phases", async () => {
    const { git, gitAsync } = scriptedGit(() => "");
    const result = await ensure({ db: ctx.db, git, gitAsync, blobsRoot: "unused" }, "nope");
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
  });
});

describe("ensure — attachments stage", () => {
  it("materializes the ticket's file attachments into the fresh worktree, post-copy", async () => {
    const projectPath = tempDir("proj");
    const { ticket } = seed(projectPath);
    const home = tempDir("home");
    const { git, gitAsync } = happyGit(projectPath);
    const blobsRootDir = blobsRoot(tempDir("userdata"));

    importBlob(
      ctx.db,
      blobsRootDir,
      {
        fileName: "spec.png",
        bytes: Buffer.from("spec bytes"),
        owner: { ticketId: ticket.id },
      },
      100,
    );

    const result = await ensure(
      { db: ctx.db, git, gitAsync, home, blobsRoot: blobsRootDir },
      "ticket-1",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const worktreePath = result.value.identity.worktreePath!;
    const destPath = join(worktreePath, ".volli", "attachments", "spec.png");
    expect(readFileSync(destPath, "utf8")).toBe("spec bytes");
  });

  it("records worktree_failed (stage attachments) when a file attachment's stored bytes are missing", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { git, gitAsync } = happyGit(projectPath);
    const blobsRootDir = blobsRoot(tempDir("userdata"));

    const link = importBlob(
      ctx.db,
      blobsRootDir,
      { fileName: "spec.png", bytes: Buffer.from("spec bytes"), owner: { ticketId: "ticket-1" } },
      100,
    );
    // Bytes deleted out from under the row — the missing-source guard fires.
    removeBlob(blobsRootDir, link.blobHash);

    const result = await ensure(
      { db: ctx.db, git, gitAsync, home, blobsRoot: blobsRootDir },
      "ticket-1",
    );

    expect(result.ok).toBe(false);
    const failed = listTicketEvents(ctx.db, "ticket-1").find(
      (e) => e.payload.kind === "worktree_failed",
    );
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "attachments" });

    // The create + copy stages already ran, but a stage failure after them
    // must still leave identity unpersisted (fail() runs before the persist
    // step regardless of which stage aborted).
    const row = getTicketRow(ctx.db, "ticket-1")!;
    expect(row.worktree_path).toBeNull();
  });

  it("is a no-op when the ticket has no attachments (unchanged pipeline behavior)", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { git, gitAsync } = happyGit(projectPath);
    const blobsRootDir = blobsRoot(tempDir("userdata"));

    const result = await ensure(
      { db: ctx.db, git, gitAsync, home, blobsRoot: blobsRootDir },
      "ticket-1",
    );

    expect(result.ok).toBe(true);
  });
});

/** Real git against a real repo — identity pinned so a bare CI checkout can commit. */
function runRepoGit(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, {
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

describe("ensure → worktree status, against a real repository (VC-98)", () => {
  it("turns a worktree-less ticket into one `volli worktree status` can report", async () => {
    const projectPath = tempDir("real-repo");
    runRepoGit(projectPath, ["init", "-b", "main"]);
    writeFileSync(join(projectPath, "README.md"), "# repo\n");
    runRepoGit(projectPath, ["add", "README.md"]);
    runRepoGit(projectPath, ["commit", "-m", "initial"]);

    const home = tempDir("real-home");
    insertProject(
      ctx.db,
      testProject({ id: "p1", path: projectPath, ticketPrefix: "VC", baseBranch: "main" }),
    );
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t1",
        ticketNumber: 12,
        title: "MCP server",
        usesWorktree: true,
      }),
    );
    const deps = {
      db: ctx.db,
      git: runGitCapturing,
      gitAsync: runGitCapturingAsync,
      home,
      blobsRoot: blobsRoot(tempDir("real-userdata")),
    };

    // The state VC-81 was left in: scoped to a worktree, with no worktree, and
    // the read verb refusing every question an agent asks about its work.
    expect(readWorktreeStatus(deps, "t1")).toMatchObject({
      kind: "no-worktree",
      usesWorktree: true,
    });

    const outcome = await ensure(deps, "t1");

    expect(outcome).toMatchObject({ ok: true });
    // Real git, real directory: the persisted identity is a fact on disk, not
    // a stamp the read verb has to take on trust.
    const row = getTicketRow(ctx.db, "t1");
    expect(row?.worktree_path).not.toBeNull();
    expect(row?.branch).toBe("volli/VC-12-mcp-server");
    expect(row?.base_branch).toBe("main");
    expect(existsSync(row!.worktree_path!)).toBe(true);
    expect(readWorktreeStatus(deps, "t1")).toMatchObject({
      kind: "ok",
      displayId: "VC-12",
      branch: "volli/VC-12-mcp-server",
      baseBranch: "main",
    });
  });
});

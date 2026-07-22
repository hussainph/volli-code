import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { attachmentsRoot, importAttachmentFile } from "../attachment-store";
import { createAttachment } from "../db/attachments-repo";
import { listTicketEvents } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { getTicketRow, insertTicket } from "../db/tickets-repo";
import { ensure } from "./ensure";
import { resetPhasesForTest } from "./phase";
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
  it("runs the pipeline, transitions phases, persists identity, and returns it", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { git, countMatching } = happyGit(projectPath);
    const phases: WorktreePhase[] = [];

    const result = await ensure(
      {
        db: ctx.db,
        git,
        home,
        onPhase: (_, phase) => phases.push(phase),
        attachmentsRoot: "unused",
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

  it("is single-flight: two concurrent ensures run the pipeline once, and only the leader reports created", async () => {
    const projectPath = tempDir("proj");
    seed(projectPath);
    const home = tempDir("home");
    const { git, countMatching } = happyGit(projectPath);
    const deps = { db: ctx.db, git, home, attachmentsRoot: "unused" };

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
    const { git } = scriptedGit((args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return `worktree ${projectPath}\nHEAD abc\nbranch refs/heads/main\nworktree /elsewhere\nHEAD def\nbranch refs/heads/${BRANCH}\n`;
      }
      return "";
    });

    const result = await ensure(
      {
        db: ctx.db,
        git,
        home,
        onPhase: (_, phase) => phases.push(phase),
        attachmentsRoot: "unused",
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
    const { git } = happyGit("/volli-nonexistent-project-dir");

    const result = await ensure({ db: ctx.db, git, home, attachmentsRoot: "unused" }, "ticket-1");

    expect(result.ok).toBe(false);
    const failed = listTicketEvents(ctx.db, "ticket-1").find(
      (e) => e.payload.kind === "worktree_failed",
    );
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "copy" });
  });

  it("errors on an unknown ticket without touching phases", async () => {
    const { git } = scriptedGit(() => "");
    const result = await ensure({ db: ctx.db, git, attachmentsRoot: "unused" }, "nope");
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
  });
});

describe("ensure — attachments stage", () => {
  it("materializes the ticket's file attachments into the fresh worktree, post-copy", async () => {
    const projectPath = tempDir("proj");
    const { ticket } = seed(projectPath);
    const home = tempDir("home");
    const { git } = happyGit(projectPath);
    const attachmentsRootDir = attachmentsRoot(tempDir("userdata"));

    const attachment = createAttachment(
      ctx.db,
      { ticketId: ticket.id, kind: "file", fileName: "spec.png" },
      100,
    );
    const source = join(tempDir("source"), "spec.png");
    writeFileSync(source, "spec bytes");
    importAttachmentFile(attachmentsRootDir, attachment.id, source, "spec.png");

    const result = await ensure(
      { db: ctx.db, git, home, attachmentsRoot: attachmentsRootDir },
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
    const { git } = happyGit(projectPath);
    const attachmentsRootDir = attachmentsRoot(tempDir("userdata"));

    createAttachment(ctx.db, { ticketId: "ticket-1", kind: "file", fileName: "spec.png" }, 100);
    // Bytes never imported — the missing-source guard fires.

    const result = await ensure(
      { db: ctx.db, git, home, attachmentsRoot: attachmentsRootDir },
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
    const { git } = happyGit(projectPath);
    const attachmentsRootDir = attachmentsRoot(tempDir("userdata"));

    const result = await ensure(
      { db: ctx.db, git, home, attachmentsRoot: attachmentsRootDir },
      "ticket-1",
    );

    expect(result.ok).toBe(true);
  });
});

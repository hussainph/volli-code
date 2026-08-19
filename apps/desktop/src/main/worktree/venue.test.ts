import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { venueFileTotal } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { GitError } from "./git";
import { scriptedGit } from "./scripted-git";
import { readVenue, venueSnapshot } from "./venue";

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

/** Join NUL-terminated git -z fields without octal-escape hazards (`\03` ≠ NUL+"3"). */
function z(...fields: string[]): string {
  return fields.length === 0 ? "" : `${fields.join("\0")}\0`;
}

/** A `1 ` porcelain-v2 entry: eight fixed fields, then the path. */
function tracked(code: string, path: string): string {
  return `1 ${code} N... 100644 100644 100644 aaaa bbbb ${path}`;
}

/**
 * Scripted git for a venue with a base: `main` resolves to `basesha`, and the
 * status/numstat payloads are whatever the case under test needs.
 */
function scriptedVenueGit(opts: { branch?: string; status?: string; numstat?: string }) {
  return scriptedGit((args) => {
    if (args[0] === "branch") return `${opts.branch ?? "volli/VC-81-auto-title"}\n`;
    if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
    if (args[0] === "merge-base") return "basesha\n";
    if (args[0] === "status") return opts.status ?? "";
    if (args[0] === "diff") return opts.numstat ?? "";
    return "";
  });
}

describe("venueSnapshot", () => {
  it("reads the branch, and calls it null on a detached HEAD", async () => {
    const onBranch = await venueSnapshot(scriptedVenueGit({ branch: "main" }).gitAsync, {
      path: "/repo",
      kind: "main-checkout",
      baseBranch: null,
    });
    const detached = await venueSnapshot(scriptedVenueGit({ branch: "" }).gitAsync, {
      path: "/repo",
      kind: "main-checkout",
      baseBranch: null,
    });

    expect(onBranch.ok && onBranch.value.branch).toBe("main");
    expect(detached.ok && detached.value.branch).toBe(null);
  });

  it("partitions dirty files into the three loose states", async () => {
    const { gitAsync } = scriptedVenueGit({
      status: z(
        tracked(".M", "src/edited.ts"),
        tracked("A.", "src/new.ts"),
        tracked("AM", "src/new-and-edited.ts"),
        tracked("D.", "src/gone.ts"),
        "? notes/scratch.md",
      ),
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/repo",
      kind: "main-checkout",
      baseBranch: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files).toEqual({
      committed: 0,
      modified: 2,
      added: 2,
      untracked: 1,
    });
  });

  it("counts a file that is both committed and dirty once, as dirty", async () => {
    const { gitAsync } = scriptedVenueGit({
      status: z(tracked(".M", "src/both.ts")),
      numstat: z("10\t2\tsrc/both.ts", "4\t0\tsrc/committed.ts"),
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/wt",
      kind: "worktree",
      baseBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bar claims its segments sum to the total it prints; double-counting
    // `src/both.ts` is exactly what broke that claim in the prototype.
    expect(result.value.files).toEqual({
      committed: 1,
      modified: 1,
      added: 0,
      untracked: 0,
    });
    expect(venueFileTotal(result.value.files)).toBe(2);
  });

  it("measures lines against the base and names it", async () => {
    const { gitAsync, calls } = scriptedVenueGit({
      numstat: z("96\t12\tsrc/a.ts", "-\t-\tassets/logo.png", "14\t3\tsrc/b.ts"),
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/wt",
      kind: "worktree",
      baseBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Binary contributes a file and no lines — a `0` there would read as
    // "unchanged" rather than "uncounted".
    expect(result.value.diff).toEqual({ added: 110, removed: 15, base: "main" });
    expect(result.value.files.committed).toBe(3);
    const diff = calls.find((call) => call.args[0] === "diff");
    expect(diff?.args).toContain("basesha");
    expect(diff?.args).toContain("-z");
    expect(diff?.args).toContain("-M");
  });

  it("drops the diff entirely when the venue has no base to measure against", async () => {
    const { gitAsync, calls } = scriptedVenueGit({ status: z("? loose.md") });

    const result = await venueSnapshot(gitAsync, {
      path: "/repo",
      kind: "main-checkout",
      baseBranch: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff).toBeNull();
    expect(result.value.files.committed).toBe(0);
    // And never asks git for one: an absent base is not a failed lookup.
    expect(calls.some((call) => call.args[0] === "diff")).toBe(false);
  });

  it("drops the diff when the base branch cannot be resolved at all", async () => {
    const { gitAsync } = scriptedGit((args) => {
      if (args[0] === "branch") return "volli/VC-9\n";
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no such ref");
      if (args[0] === "merge-base") throw new GitError("failed", "fatal: no merge base", args);
      if (args[0] === "rev-parse") return "";
      return "";
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/wt",
      kind: "worktree",
      baseBranch: "gone",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff).toBeNull();
  });

  it("keeps NUL-delimited paths with spaces intact, and consumes a rename's second token", async () => {
    const { gitAsync } = scriptedVenueGit({
      // `2 ` entries carry the original path as their own NUL-terminated token
      // — read as an entry of its own, `? staged rename` would become an
      // untracked file that does not exist.
      status: z(
        `2 R. N... 100644 100644 100644 aaaa bbbb R100 docs/new name.md`,
        "? old name.md",
        "? notes/my notes.md",
      ),
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/repo",
      kind: "main-checkout",
      baseBranch: null,
    });

    expect(result.ok && result.value.files).toEqual({
      committed: 0,
      modified: 1,
      added: 0,
      untracked: 1,
    });
  });

  it("reads an unmerged path as in play rather than dropping it", async () => {
    const { gitAsync } = scriptedVenueGit({
      status: z("u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts"),
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/wt",
      kind: "worktree",
      baseBranch: null,
    });

    expect(result.ok && result.value.files.modified).toBe(1);
  });

  it("surfaces git's own message rather than a silently empty venue", async () => {
    const { gitAsync } = scriptedGit(() => {
      throw new GitError("failed", "fatal: not a git repository", ["status"]);
    });

    const result = await venueSnapshot(gitAsync, {
      path: "/nowhere",
      kind: "main-checkout",
      baseBranch: null,
    });

    expect(result).toEqual({ ok: false, error: "fatal: not a git repository" });
  });
});

describe("readVenue", () => {
  let ctx: TestDb | null = null;

  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  function setup(): TestDb {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "project", path: "/repo" }));
    return ctx;
  }

  it("measures the project's main checkout for a Session with no ticket", async () => {
    const { db } = setup();
    const { gitAsync, calls } = scriptedVenueGit({});

    const result = await readVenue({ db, gitAsync }, { projectId: "project", ticketId: null });

    expect(result.ok && result.value.kind).toBe("main-checkout");
    expect(result.ok && result.value.path).toBe("/repo");
    expect(calls.every((call) => call.cwd === "/repo")).toBe(true);
  });

  it("measures a ticket's worktree against the base it was branched from", async () => {
    const { db } = setup();
    insertTicket(
      db,
      testTicket("project", {
        id: "ticket",
        worktreePath: "/worktrees/ticket",
        branch: "volli/VC-1-x",
        baseBranch: "main",
      }),
    );
    const { gitAsync, calls } = scriptedVenueGit({});

    const result = await readVenue({ db, gitAsync }, { projectId: "project", ticketId: "ticket" });

    expect(result.ok && result.value.kind).toBe("worktree");
    expect(result.ok && result.value.path).toBe("/worktrees/ticket");
    expect(result.ok && result.value.diff?.base).toBe("main");
    expect(calls.every((call) => call.cwd === "/worktrees/ticket")).toBe(true);
  });

  it("measures the main checkout for a ticket that has no worktree of its own", async () => {
    const { db } = setup();
    insertTicket(db, testTicket("project", { id: "ticket" }));
    const { gitAsync } = scriptedVenueGit({});

    const result = await readVenue({ db, gitAsync }, { projectId: "project", ticketId: "ticket" });

    // Exactly where the Session runtime binds such a Session — and with no
    // hairline, because a main checkout has no branch of its own to measure.
    expect(result.ok && result.value.kind).toBe("main-checkout");
    expect(result.ok && result.value.diff).toBeNull();
  });

  it("refuses an unknown project, an unknown ticket, and a ticket from elsewhere", async () => {
    const { db } = setup();
    const other = testProject({ id: "other", path: "/other", ticketPrefix: "OT" });
    insertProject(db, other);
    insertTicket(db, testTicket(other.id, { id: "foreign" }));
    const { gitAsync } = scriptedVenueGit({});

    await expect(
      readVenue({ db, gitAsync }, { projectId: "missing", ticketId: null }),
    ).resolves.toEqual({ ok: false, error: "Unknown project" });
    await expect(
      readVenue({ db, gitAsync }, { projectId: "project", ticketId: "missing" }),
    ).resolves.toEqual({ ok: false, error: "Unknown ticket" });
    await expect(
      readVenue({ db, gitAsync }, { projectId: "project", ticketId: "foreign" }),
    ).resolves.toEqual({ ok: false, error: "Ticket belongs to another project" });
  });
});

describe("venueSnapshot — against real git", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("partitions a real tree the way the drawing claims", async () => {
    const dir = mkdtempSync(join(tmpdir(), "volli-venue-"));
    tempDirs.push(dir);
    runRepoGit(dir, ["init", "-q"]);
    runRepoGit(dir, ["checkout", "-q", "-b", "main"]);
    writeFileSync(join(dir, "committed.ts"), "one\n");
    writeFileSync(join(dir, "both.ts"), "both\n");
    writeFileSync(join(dir, "edited.ts"), "edited\n");
    runRepoGit(dir, ["add", "."]);
    runRepoGit(dir, ["commit", "-q", "-m", "base"]);

    runRepoGit(dir, ["checkout", "-q", "-b", "volli/VC-1-venue"]);
    writeFileSync(join(dir, "committed.ts"), "one\ntwo\nthree\n");
    writeFileSync(join(dir, "both.ts"), "both\ncommitted\n");
    runRepoGit(dir, ["add", "."]);
    runRepoGit(dir, ["commit", "-q", "-m", "work"]);

    // …and then the tree moves on: one committed file edited again, one tracked
    // file edited, one file staged as new, one never added at all.
    writeFileSync(join(dir, "both.ts"), "both\ncommitted\nand dirty\n");
    writeFileSync(join(dir, "edited.ts"), "edited\nagain\n");
    writeFileSync(join(dir, "staged-new.ts"), "new\n");
    runRepoGit(dir, ["add", "staged-new.ts"]);
    writeFileSync(join(dir, "scratch.md"), "notes\n");

    const { runGitCapturingAsync } = await import("./git");
    const result = await venueSnapshot(runGitCapturingAsync, {
      path: dir,
      kind: "worktree",
      baseBranch: "main",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.branch).toBe("volli/VC-1-venue");
    expect(result.value.files).toEqual({
      committed: 1, // committed.ts — changed on this branch, clean now
      modified: 2, // both.ts, edited.ts
      added: 1, // staged-new.ts
      untracked: 1, // scratch.md
    });
    expect(venueFileTotal(result.value.files)).toBe(5);
    expect(result.value.diff?.base).toBe("main");
    expect(result.value.diff?.added).toBeGreaterThan(0);
  });
});

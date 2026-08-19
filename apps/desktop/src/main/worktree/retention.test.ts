import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { recordTicketEvent } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { getTicketRow, insertTicket, updateTicketFields } from "../db/tickets-repo";
import {
  archiveAndClean,
  DEFAULT_RETENTION_TTL_DAYS,
  doneEntryTimestamp,
  getRetentionTtlDays,
  reclaimIfStale,
  setRetentionTtlDays,
} from "./retention";
import { listTicketEvents } from "../db/events-repo";
import { scriptedGit } from "./scripted-git";

// `computeArchiveReadiness` (+ its ArchiveReadiness*/ types) moved to
// `@volli/shared` (K2, pure/dependency-free domain logic) along with its unit
// tests — see packages/shared/src/retention.test.ts. This module re-exports it
// unchanged, so nothing else here needed to move.

let ctx: TestDb;
let tempDirs: string[] = [];

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

describe("retention TTL setting", () => {
  it("defaults to 14 days when unset", () => {
    expect(getRetentionTtlDays(ctx.db)).toBe(DEFAULT_RETENTION_TTL_DAYS);
    expect(DEFAULT_RETENTION_TTL_DAYS).toBe(14);
  });

  it("round-trips a set value", () => {
    setRetentionTtlDays(ctx.db, 30, 1);
    expect(getRetentionTtlDays(ctx.db)).toBe(30);
  });

  it("clamps a zero/negative TTL to at least 1 day", () => {
    expect(setRetentionTtlDays(ctx.db, 0, 1)).toBe(1);
    expect(getRetentionTtlDays(ctx.db)).toBe(1);
  });

  it("falls back to the default on a corrupt stored blob", () => {
    // Write junk directly under the key; a bad setting must not disable retention.
    ctx.db
      .prepare(
        "INSERT INTO app_state (key, value, updated_at) VALUES ('volli:retention', 'not json', 1)",
      )
      .run();
    expect(getRetentionTtlDays(ctx.db)).toBe(DEFAULT_RETENTION_TTL_DAYS);
  });
});

describe("doneEntryTimestamp", () => {
  beforeEach(() => {
    insertProject(ctx.db, testProject({ id: "p1" }));
    insertTicket(ctx.db, testTicket("p1", { id: "t1", status: "done" }));
  });

  it("returns null when the log records no Done entry", () => {
    expect(doneEntryTimestamp(ctx.db, "t1")).toBeNull();
  });

  it("returns the timestamp of a status_changed into done", () => {
    recordTicketEvent(
      ctx.db,
      "t1",
      { kind: "status_changed", from: "needs_review", to: "done" },
      5000,
    );
    expect(doneEntryTimestamp(ctx.db, "t1")).toBe(5000);
  });

  it("uses the LATEST done entry when the ticket bounced out and back", () => {
    recordTicketEvent(
      ctx.db,
      "t1",
      { kind: "status_changed", from: "needs_review", to: "done" },
      1000,
    );
    recordTicketEvent(ctx.db, "t1", { kind: "status_changed", from: "done", to: "doing" }, 2000);
    recordTicketEvent(ctx.db, "t1", { kind: "status_changed", from: "doing", to: "done" }, 9000);
    expect(doneEntryTimestamp(ctx.db, "t1")).toBe(9000);
  });

  it("recognizes a ticket created directly in done", () => {
    recordTicketEvent(ctx.db, "t1", { kind: "created", status: "done", title: "T" }, 42);
    expect(doneEntryTimestamp(ctx.db, "t1")).toBe(42);
  });
});

/** A git reporting the worktree clean (or dirty), used by remove inside archiveAndClean. */
function statusGit(wt: string, gitDir: string, dirty = false) {
  return scriptedGit((args) => {
    if (args[0] === "status") return dirty ? "?? junk\n" : "";
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return gitDir;
    if (args[0] === "log") return "";
    if (args[0] === "worktree" && args[1] === "list") {
      return `worktree ${wt}\nHEAD abc\nbranch refs/heads/volli/VC-1-x\n`;
    }
    if (args[0] === "submodule") return "";
    return "";
  });
}

describe("archiveAndClean", () => {
  function seed(worktreePath: string | null, status = "done") {
    insertProject(ctx.db, testProject({ id: "p1", path: "/repo" }));
    insertTicket(ctx.db, testTicket("p1", { id: "t1", status: status as "done" }));
    if (worktreePath) {
      updateTicketFields(
        ctx.db,
        "t1",
        { worktreePath, branch: "volli/VC-1-x", baseBranch: "main" },
        1,
      );
    }
  }

  it("removes a clean worktree and archives the ticket", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, false);

    const result = await archiveAndClean({ db: ctx.db, git, blobsRoot: "unused" }, "t1");
    expect(result.ok).toBe(true);

    const row = getTicketRow(ctx.db, "t1")!;
    expect(row.archived_at).not.toBeNull();
    expect(row.worktree_path).toBeNull();
    // Branch identity survives (retained forever — #16).
    expect(row.branch).toBe("volli/VC-1-x");
    expect(calls.some((c) => c.args[1] === "remove")).toBe(true);
  });

  it("refuses a dirty worktree and does NOT archive (human resolves first)", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seed(wt);
    const { git, calls } = statusGit(wt, gitDir, true);

    const result = await archiveAndClean({ db: ctx.db, git, blobsRoot: "unused" }, "t1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("uncommitted work");

    const row = getTicketRow(ctx.db, "t1")!;
    // Nothing destroyed: worktree stays, ticket stays on the board.
    expect(row.archived_at).toBeNull();
    expect(row.worktree_path).toBe(wt);
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
  });

  it("archives a PR-less ticket with no worktree (nothing to remove)", async () => {
    seed(null);
    const { git } = scriptedGit(() => "");
    const result = await archiveAndClean({ db: ctx.db, git, blobsRoot: "unused" }, "t1");
    expect(result.ok).toBe(true);
    expect(getTicketRow(ctx.db, "t1")!.archived_at).not.toBeNull();
  });
});

// VC-113. The complaint was never "Volli reclaims disk", it was WHEN: a branch
// reads clean the instant it is pushed, so the old sweep could take a checkout
// away at the exact moment its review started. Dwell replaces tidiness as the
// signal, and the reclaim takes the DIRECTORY only — ticket, branch, commits
// and PR url all survive, so every one of these is undoable by recreating.
describe("reclaimIfStale", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_000_000_000_000;

  /** A Done ticket with a worktree, entered Done `daysAgo` days ago. */
  function seedDone(
    worktreePath: string,
    daysAgo: number,
    opts: { keep?: boolean; noDoneEntry?: boolean } = {},
  ) {
    insertProject(ctx.db, testProject({ id: "p1", path: "/repo" }));
    insertTicket(ctx.db, testTicket("p1", { id: "t1", status: "done" }));
    updateTicketFields(
      ctx.db,
      "t1",
      { worktreePath, branch: "volli/VC-1-x", baseBranch: "main" },
      1,
    );
    if (opts.keep === true) {
      ctx.db.prepare("UPDATE tickets SET retention_keep = 1 WHERE id = 't1'").run();
    }
    if (opts.noDoneEntry !== true) {
      recordTicketEvent(
        ctx.db,
        "t1",
        { kind: "status_changed", from: "needs_review", to: "done" },
        NOW - daysAgo * DAY,
      );
    }
  }

  function deps(git: ReturnType<typeof scriptedGit>["git"], busy: string[] = []) {
    return {
      worktree: { db: ctx.db, git, blobsRoot: "unused" },
      now: () => NOW,
      busyWorktreeSites: async () => busy.map((directory) => ({ directory })),
    };
  }

  function reclaimEvents() {
    return listTicketEvents(ctx.db, "t1").filter((e) => e.payload.kind === "worktree_reclaimed");
  }

  it("reclaims the directory after the TTL, keeping the ticket, branch, and PR url", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 20);
    updateTicketFields(ctx.db, "t1", { prUrl: "https://gh/pr/1" }, 2);
    const { git, calls } = statusGit(wt, gitDir, false);

    const outcome = await reclaimIfStale(deps(git), "t1", "merged");

    expect(outcome).toEqual({ kind: "reclaimed", branch: "volli/VC-1-x", daysInDone: 20 });
    expect(calls.some((c) => c.args[1] === "remove")).toBe(true);
    const row = getTicketRow(ctx.db, "t1")!;
    expect(row.worktree_path).toBeNull(); // the folder is what went
    expect(row.archived_at).toBeNull(); // the ticket stays on the board
    expect(row.branch).toBe("volli/VC-1-x"); // and stays recreatable
    expect(row.pr_url).toBe("https://gh/pr/1");
  });

  it("records ONE event that says why, and what it kept", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 15);
    const { git } = statusGit(wt, gitDir, false);

    await reclaimIfStale(deps(git), "t1", null);

    expect(reclaimEvents()).toEqual([
      expect.objectContaining({
        actor: "automation",
        payload: { kind: "worktree_reclaimed", branch: "volli/VC-1-x", daysInDone: 15 },
      }),
    ]);
  });

  // The heart of VC-113: merging is an EVENT, not a dwell. An agent that merges
  // its own PR must not take the checkout with it — that is the "insta delete"
  // that made the Open-PR button feel dangerous.
  it("does NOT reclaim a freshly merged PR — only the prompt reacts to a merge", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 0);
    const { git, calls } = statusGit(wt, gitDir, false);

    const outcome = await reclaimIfStale(deps(git), "t1", "merged");

    expect(outcome).toEqual({ kind: "skipped", reason: "not stale enough" });
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    expect(getTicketRow(ctx.db, "t1")!.worktree_path).toBe(wt);
  });

  it("does NOT reclaim while the PR is still open, however long it has sat", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 90);
    updateTicketFields(ctx.db, "t1", { prUrl: "https://gh/pr/1" }, 2);
    const { git } = statusGit(wt, gitDir, false);

    expect(await reclaimIfStale(deps(git), "t1", "open")).toEqual({
      kind: "skipped",
      reason: "not stale enough",
    });
    expect(getTicketRow(ctx.db, "t1")!.worktree_path).toBe(wt);
  });

  it("does NOT reclaim before the TTL has run out", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 13); // TTL is 14
    const { git } = statusGit(wt, gitDir, false);

    expect(await reclaimIfStale(deps(git), "t1", null)).toEqual({
      kind: "skipped",
      reason: "not stale enough",
    });
  });

  it("never reclaims a Keep-pinned worktree", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 200, { keep: true });
    const { git } = statusGit(wt, gitDir, false);

    expect(await reclaimIfStale(deps(git), "t1", "merged")).toEqual({
      kind: "skipped",
      reason: "kept",
    });
    expect(getTicketRow(ctx.db, "t1")!.worktree_path).toBe(wt);
  });

  it("refuses a Done ticket it cannot date — the dwell is the evidence, and there is none", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 200, { noDoneEntry: true }); // Done, old, clean — but no dated entry
    const { git, calls } = statusGit(wt, gitDir, false);

    expect(await reclaimIfStale(deps(git), "t1", null)).toEqual({
      kind: "skipped",
      reason: "cannot date the Done entry",
    });
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    expect(getTicketRow(ctx.db, "t1")!.worktree_path).toBe(wt);
  });

  it("refuses a dirty worktree — the same predicate the manual remove runs", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 60);
    const { git, calls } = statusGit(wt, gitDir, true);

    const outcome = await reclaimIfStale(deps(git), "t1", null);

    expect(outcome.kind).toBe("skipped");
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
    expect(getTicketRow(ctx.db, "t1")!.worktree_path).toBe(wt);
    expect(reclaimEvents()).toEqual([]);
  });

  it("refuses while work is in flight in the directory", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 60);
    const { git, calls } = statusGit(wt, gitDir, false);

    const outcome = await reclaimIfStale(deps(git, [wt]), "t1", null);

    expect(outcome).toEqual({ kind: "skipped", reason: "work in flight" });
    expect(calls.some((c) => c.args[1] === "remove")).toBe(false);
  });

  it("leaves a ticket that is not in Done alone", async () => {
    const wt = tempDir("wt");
    const gitDir = tempDir("gitdir");
    seedDone(wt, 60);
    ctx.db.prepare("UPDATE tickets SET status = 'doing' WHERE id = 't1'").run();
    const { git } = statusGit(wt, gitDir, false);

    expect(await reclaimIfStale(deps(git), "t1", null)).toEqual({
      kind: "skipped",
      reason: "not stale enough",
    });
  });

  it("leaves the stamp alone when the directory is already gone", async () => {
    const wt = join(tmpdir(), "volli-never-existed-vc113");
    seedDone(wt, 60);
    const { git, calls } = scriptedGit(() => "");

    expect(await reclaimIfStale(deps(git), "t1", null)).toEqual({
      kind: "skipped",
      reason: "worktree already missing",
    });
    // The pointer is the only thing left to recreate from, so nothing clears it.
    expect(getTicketRow(ctx.db, "t1")!.worktree_path).toBe(wt);
    expect(calls).toEqual([]);
  });
});

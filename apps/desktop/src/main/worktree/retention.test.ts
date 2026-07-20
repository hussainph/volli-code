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
  computeArchiveReadiness,
  DEFAULT_RETENTION_TTL_DAYS,
  doneEntryTimestamp,
  getRetentionTtlDays,
  setRetentionTtlDays,
} from "./retention";
import { scriptedGit } from "./scripted-git";

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

const DAY = 24 * 60 * 60 * 1000;

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

describe("computeArchiveReadiness", () => {
  const base = {
    status: "done" as const,
    keep: false,
    dismissed: false,
    prState: null,
    doneEntryAt: 0,
    now: 100 * DAY,
    ttlMs: 14 * DAY,
  };

  it("flags a merged PR as archive-ready in any column (reason pr-merged)", () => {
    expect(
      computeArchiveReadiness({
        ...base,
        status: "needs_review",
        prState: "merged",
        doneEntryAt: null,
      }),
    ).toEqual({ archiveReady: true, reason: "pr-merged" });
  });

  it("does not TTL a ticket whose Done entry is younger than the TTL", () => {
    expect(computeArchiveReadiness({ ...base, doneEntryAt: 99 * DAY })).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  it("flags a Done, PR-less ticket past its TTL (reason ttl-expired)", () => {
    expect(computeArchiveReadiness({ ...base, doneEntryAt: 80 * DAY })).toEqual({
      archiveReady: true,
      reason: "ttl-expired",
    });
  });

  it("never TTLs a ticket with an OPEN PR — it waits for the merge", () => {
    expect(computeArchiveReadiness({ ...base, prState: "open", doneEntryAt: 1 })).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  it("TTLs a Done ticket whose PR was closed (not merged) once expired", () => {
    expect(computeArchiveReadiness({ ...base, prState: "closed", doneEntryAt: 1 })).toEqual({
      archiveReady: true,
      reason: "ttl-expired",
    });
  });

  it("suppresses the prompt when dismissed, but still reports the reason", () => {
    expect(computeArchiveReadiness({ ...base, prState: "merged", dismissed: true })).toEqual({
      archiveReady: false,
      reason: "pr-merged",
    });
  });

  // The Vibe-Kanban bug, encoded: a kept ticket is exempt from BOTH paths.
  it("Keep exempts a merged-PR ticket (merge path)", () => {
    expect(computeArchiveReadiness({ ...base, prState: "merged", keep: true })).toEqual({
      archiveReady: false,
      reason: null,
    });
  });

  it("Keep exempts an expired Done ticket (TTL path)", () => {
    expect(computeArchiveReadiness({ ...base, doneEntryAt: 1, keep: true })).toEqual({
      archiveReady: false,
      reason: null,
    });
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

    const result = await archiveAndClean({ db: ctx.db, git }, "t1");
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

    const result = await archiveAndClean({ db: ctx.db, git }, "t1");
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
    const result = await archiveAndClean({ db: ctx.db, git }, "t1");
    expect(result.ok).toBe(true);
    expect(getTicketRow(ctx.db, "t1")!.archived_at).not.toBeNull();
  });
});

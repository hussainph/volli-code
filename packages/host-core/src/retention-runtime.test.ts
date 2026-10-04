import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getRetentionWatcher, resetRetentionWatcherForTest } from "./retention-runtime";
import { HEADLESS_ATTENTION } from "./ports";
import { worktreeDeps } from "./worktree-runtime";
import { insertProject } from "./db/projects-repo";
import { insertTicket, updateTicketFields } from "./db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";

vi.mock("./worktree", async (original) => ({
  ...(await original<typeof import("./worktree")>()),
  runNet: vi.fn(async () => ({
    stdout: JSON.stringify({
      state: "MERGED",
      mergedAt: "2026-07-20T00:00:00Z",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
    }),
    stderr: "",
  })),
}));

let ctx: TestDb | undefined;
afterEach(() => {
  resetRetentionWatcherForTest();
  ctx?.cleanup();
});

function fixture() {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo" }));
  insertTicket(
    ctx.db,
    testTicket("p1", {
      id: "t1",
      status: "needs_review",
      branch: "volli/VC-1-x",
      worktreePath: "/repo/wt",
    }),
  );
  updateTicketFields(ctx.db, "t1", { prUrl: "https://example.com/pull/1" }, 1);
  const events = { publish: vi.fn() };
  const attention = { ...HEADLESS_ATTENTION, deliver: vi.fn(HEADLESS_ATTENTION.deliver) };
  const worktree = () => worktreeDeps(ctx!.db, { events }, { dataDir: dirname(ctx!.dbPath) });
  return { db: ctx.db, events, attention, worktree };
}

describe("retention runtime ports", () => {
  it("polls and publishes with no window and unsupported attention delivery", async () => {
    const { db, events, attention, worktree } = fixture();
    const watch = getRetentionWatcher(db, { events, attention }, worktree);
    watch.triggerNow();
    await vi.waitFor(() => expect(events.publish).toHaveBeenCalledWith("data-changed", {}));
    expect(attention.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ producer: "pull-request-merged" }),
    );
    expect(watch.getState("t1")?.prState).toBe("merged");
  });

  it("keeps the first lazy singleton and dismissal across desktop IPC and host reads", () => {
    const { db, events, attention, worktree } = fixture();
    const watch = getRetentionWatcher(db, { events, attention }, worktree);
    watch.dismiss("t1");
    const laterWorktree = vi.fn(worktree);
    expect(getRetentionWatcher(db, { events, attention }, laterWorktree, {})).toBe(watch);
    expect(laterWorktree).not.toHaveBeenCalled();
    expect(watch.getState("t1")?.dismissed).toBe(true);
  });
});

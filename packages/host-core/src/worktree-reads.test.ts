/**
 * The host's worktree read service (VC-788): what it adds over the pieces it
 * composes — the watch's ticket resolution, the teardown that retires a
 * vanished checkout's answers, and the untargeted invalidation. The pieces'
 * own rules are pinned by `worktree/snapshot.test.ts` (the snapshot and the
 * flip, through this service), `worktree/coalesce.test.ts` and
 * `worktree/change-set-watch.test.ts`; the doors' sharing by
 * `agent-commands.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";
import type { HostClientEventSink } from "./ports";
import { createWorktreeReadService, type WorktreeReadService } from "./worktree-reads";
import type { WorktreeWatchFn } from "./worktree/change-set-watch";
import { scriptedReadOnlyGit, type ScriptedGit } from "./worktree/scripted-git";

const TICKET = "t1";

let ctx: TestDb;
let worktreePath: string;
let service: WorktreeReadService;
let watchers: { close: () => void }[];
let git: ScriptedGit;

const client: HostClientEventSink = {
  id: "window-1",
  publish: vi.fn(),
  isClosed: () => false,
  onceClosed: vi.fn(),
  removeCloseListener: vi.fn(),
};

beforeEach(() => {
  ctx = openTestDb();
  worktreePath = mkdtempSync(join(tmpdir(), "volli-reads-wt-"));
  insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC", baseBranch: "main" }));
  insertTicket(
    ctx.db,
    testTicket("p1", {
      id: TICKET,
      ticketNumber: 788,
      worktreePath,
      branch: "volli/VC-788-x",
      baseBranch: "main",
      usesWorktree: true,
    }),
  );
  git = scriptedReadOnlyGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify") return "base-sha\n";
    if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t0\n";
    if (args[0] === "rev-list") return "0\n";
    return "";
  });
  watchers = [];
  const watch: WorktreeWatchFn = () => {
    const watcher = { close: vi.fn<() => void>(), on: vi.fn() };
    watchers.push(watcher);
    return watcher;
  };
  service = createWorktreeReadService({
    deps: () => ({ db: ctx.db, gitAsync: git.gitAsync }),
    watch: { watch, git: async () => "", gitPathIsDirectory: () => false },
  });
});

afterEach(() => {
  service.releaseTicket(TICKET);
  ctx.cleanup();
  rmSync(worktreePath, { recursive: true, force: true });
});

/** Counts the status reads that reached git. */
const statusReads = () => git.countMatching(["status", "--porcelain"]);

it("resolves the watched worktree from the ticket, and answers the read verbs' failure arms", async () => {
  expect(await service.watch(client, TICKET)).toEqual({ kind: "ok", result: { ok: true } });
  expect(watchers).toHaveLength(1);

  expect(await service.watch(client, "nobody")).toEqual({ kind: "missing-ticket" });
  rmSync(worktreePath, { recursive: true, force: true });
  expect(await service.watch(client, TICKET)).toMatchObject({ kind: "missing-on-disk" });
});

it("pauses and resumes one client's watch", async () => {
  expect(service.pause(client, TICKET)).toEqual({
    ok: false,
    error: "This worktree watch is not subscribed.",
  });
  await service.watch(client, TICKET);
  expect(service.pause(client, TICKET)).toEqual({ ok: true });
  expect(await service.resume(client, TICKET)).toEqual({ ok: true });
});

it("serves a covered answer until the checkout is released, then reads fresh", async () => {
  await service.watch(client, TICKET);
  await service.readStatus(TICKET);
  await service.readStatus(TICKET);
  expect(statusReads()).toBe(1);

  // The checkout goes away (remove, archive-clean): every watch on it closes
  // and nothing it held is served again.
  service.releaseTicket(TICKET);
  expect(watchers[0]!.close).toHaveBeenCalled();
  await service.readStatus(TICKET);
  expect(statusReads()).toBe(2);
});

it("retires every ticket's answer on an untargeted act, and one ticket's on a targeted one", async () => {
  await service.watch(client, TICKET);
  await service.readStatus(TICKET);
  service.invalidate(TICKET);
  await service.readStatus(TICKET);
  expect(statusReads()).toBe(2);

  service.invalidateAll();
  await service.readStatus(TICKET);
  expect(statusReads()).toBe(3);
});

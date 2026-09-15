/**
 * The rail's last-known snapshot (VC-372): the cache's own rules, and the
 * acceptance counts on the real read verbs.
 *
 * The integration half runs a real `WorktreeChangeWatchManager` over a fake
 * `fs.watch` and the real ticketId-in read verbs over a scripted git, wired the
 * way `data-ipc.ts` wires them — so "zero git children across a Now↔Diffs flip"
 * is a count on the runner itself, not on a seam that could agree while
 * production still spawns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import {
  WATCH_REWATCH_GRACE_MS,
  WorktreeChangeWatchManager,
  type WorktreeWatchFn,
} from "./change-set-watch";
import {
  readWorktreeBaseFile,
  readWorktreeChangeSet,
  readWorktreeStatus,
  type WorktreeChangeSetRead,
  type WorktreeStatusRead,
} from "./read";
import { scriptedGit, type ScriptedGit } from "./scripted-git";
import {
  createWorktreeSnapshotCache,
  getWorktreeSnapshots,
  resetWorktreeSnapshotsForTest,
} from "./snapshot";

const TICKET_ID = "t1";

/** A clean status report, the shape every "ok" read carries. */
const OK_STATUS: WorktreeStatusRead = {
  kind: "ok",
  displayId: "VC-1",
  worktreePath: "/wt/t1",
  branch: "volli/VC-1-x",
  baseBranch: "main",
  status: {
    uncommitted: false,
    sequencerActive: false,
    aheadOfBase: 0,
    behindBase: 0,
    unpushed: null,
  },
};

function okLoad(): () => Promise<WorktreeStatusRead> {
  return async () => OK_STATUS;
}

describe("createWorktreeSnapshotCache (VC-372)", () => {
  it("serves a covered, uninvalidated answer without loading again", async () => {
    const cache = createWorktreeSnapshotCache();
    cache.noteCovered(TICKET_ID);
    const load = vi.fn(okLoad());

    const first = await cache.readStatus(TICKET_ID, load);
    const second = await cache.readStatus(TICKET_ID, load);

    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops serving an answer once its TTL has passed", async () => {
    let clock = 0;
    const cache = createWorktreeSnapshotCache({ ttlMs: 1000, now: () => clock });
    cache.noteCovered(TICKET_ID);
    const load = vi.fn(okLoad());

    await cache.readStatus(TICKET_ID, load);
    clock = 999;
    await cache.readStatus(TICKET_ID, load);
    expect(load).toHaveBeenCalledTimes(1);

    // A `git commit` typed in a terminal reaches neither the watcher (a linked
    // worktree's `.git` is a file, so its bookkeeping lands in the main repo)
    // nor any verb, so an answer may not be served forever.
    clock = 1000;
    await cache.readStatus(TICKET_ID, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never serves while no watcher covers the ticket", async () => {
    const cache = createWorktreeSnapshotCache();
    const load = vi.fn(okLoad());

    await cache.readStatus(TICKET_ID, load);
    await cache.readStatus(TICKET_ID, load);

    // A ticket nobody is watching can have changed invisibly; it reads fresh.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retires the answer when coverage ends, so a later watch cannot revive it", async () => {
    const cache = createWorktreeSnapshotCache();
    const load = vi.fn(okLoad());
    cache.noteCovered(TICKET_ID);
    await cache.readStatus(TICKET_ID, load);

    cache.noteUncovered(TICKET_ID);
    cache.noteCovered(TICKET_ID);
    await cache.readStatus(TICKET_ID, load);

    // The blind gap between the two coverages could have hidden a change.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("makes the next read load again after an invalidation", async () => {
    const cache = createWorktreeSnapshotCache();
    const load = vi.fn(okLoad());
    cache.noteCovered(TICKET_ID);
    await cache.readStatus(TICKET_ID, load);

    cache.invalidate(TICKET_ID);
    await cache.readStatus(TICKET_ID, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never stores a read that started before an invalidation landed", async () => {
    const cache = createWorktreeSnapshotCache();
    cache.noteCovered(TICKET_ID);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return OK_STATUS;
    });

    const inFlight = cache.readStatus(TICKET_ID, load);
    cache.invalidate(TICKET_ID);
    release();
    await inFlight;
    await cache.readStatus(TICKET_ID, load);

    // The first answer describes a world the invalidation retired; it must not
    // be served to the second read.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retires every ticket on an untargeted invalidation", async () => {
    const cache = createWorktreeSnapshotCache();
    const loadA = vi.fn(okLoad());
    const loadB = vi.fn(okLoad());
    cache.noteCovered("a");
    cache.noteCovered("b");
    await cache.readStatus("a", loadA);
    await cache.readStatus("b", loadB);

    cache.invalidateAll();
    await cache.readStatus("a", loadA);
    await cache.readStatus("b", loadB);

    expect(loadA).toHaveBeenCalledTimes(2);
    expect(loadB).toHaveBeenCalledTimes(2);
  });

  it("keeps no failure arm — a transient fault must not pin the rail", async () => {
    const cache = createWorktreeSnapshotCache();
    cache.noteCovered(TICKET_ID);
    const load = vi.fn(async (): Promise<WorktreeStatusRead> => ({ kind: "missing-ticket" }));

    await cache.readStatus(TICKET_ID, load);
    await cache.readStatus(TICKET_ID, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("tracks the status and Change Set halves independently", async () => {
    const cache = createWorktreeSnapshotCache();
    cache.noteCovered(TICKET_ID);
    const statusLoad = vi.fn(okLoad());
    const changeSetLoad = vi.fn(async () => ({
      kind: "ok" as const,
      displayId: "VC-1",
      changeSet: {
        baseRevision: "base",
        headRevision: "head",
        files: [],
        insertions: 0,
        deletions: 0,
        revision: "rev",
        truncated: false,
        totalCount: 0,
      },
    }));

    await cache.readStatus(TICKET_ID, statusLoad);
    await cache.readChangeSet(TICKET_ID, changeSetLoad);
    cache.invalidate(TICKET_ID);

    // The invalidation retires both halves; nothing else would.
    await cache.readStatus(TICKET_ID, statusLoad);
    await cache.readChangeSet(TICKET_ID, changeSetLoad);
    expect(statusLoad).toHaveBeenCalledTimes(2);
    expect(changeSetLoad).toHaveBeenCalledTimes(2);
  });
});

interface FakeWatcher {
  close: ReturnType<typeof vi.fn<() => void>>;
  on: ReturnType<typeof vi.fn<(event: "error", listener: (error: Error) => void) => void>>;
}

interface WatchCall {
  path: string;
  cb: (eventType: string, filename: string | null) => void;
  watcher: FakeWatcher;
}

describe("the rail across a Now↔Diffs flip (VC-372)", () => {
  let ctx: TestDb;
  let tempDirs: string[] = [];
  let managers: WorktreeChangeWatchManager[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    resetWorktreeSnapshotsForTest();
    ctx = openTestDb();
  });

  afterEach(() => {
    // Release every root before the cache is thrown away, so no timer or
    // handle outlives its test (and no late coverage report lands in the next).
    for (const manager of managers.splice(0)) manager.unwatchTicket(TICKET_ID);
    resetWorktreeSnapshotsForTest();
    vi.useRealTimers();
    ctx.cleanup();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The production composition, one panel at a time: the singleton cache wraps
   * the ticketId-in read verbs, and the real watch manager reports coverage and
   * changes into it exactly as `data-ipc.ts` wires them.
   */
  function railHarness(): {
    git: ScriptedGit;
    manager: WorktreeChangeWatchManager;
    webContents: object;
    watchCalls: WatchCall[];
    armCalls: string[][];
    statusLoads: () => number;
    changeSetLoads: () => number;
    readStatus(): Promise<WorktreeStatusRead>;
    readChangeSet(): Promise<WorktreeChangeSetRead>;
    mount(): Promise<void>;
    flip(): Promise<void>;
    fireChange(filename: string): void;
  } {
    const worktreePath = mkdtempSync(join(tmpdir(), "volli-snapshot-wt-"));
    tempDirs.push(worktreePath);
    insertProject(ctx.db, testProject({ id: "p1", ticketPrefix: "VC", baseBranch: "main" }));
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: TICKET_ID,
        ticketNumber: 372,
        worktreePath,
        branch: "volli/VC-372-x",
        baseBranch: "main",
        usesWorktree: true,
      }),
    );

    const git = scriptedGit((args) => {
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return ".git\n";
      if (args[0] === "rev-parse" && args[1] === "--verify") return "base-sha\n";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "head-sha\n";
      if (args[0] === "merge-base") return "base-sha\n";
      if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t0\n";
      if (args[0] === "rev-list" && args[1] === "--count") return "0\n";
      return "";
    });

    const watchCalls: WatchCall[] = [];
    const armCalls: string[][] = [];
    const watchFn: WorktreeWatchFn = (path, _options, cb) => {
      const watcher: FakeWatcher = {
        close: vi.fn<() => void>(),
        on: vi.fn<(event: "error", listener: (error: Error) => void) => void>(),
      };
      watchCalls.push({ path, cb, watcher });
      return watcher;
    };

    const manager = new WorktreeChangeWatchManager({
      watch: watchFn,
      git: async (args) => {
        armCalls.push([...args]);
        return "";
      },
      gitPathIsDirectory: () => false,
      onCoverageChange: (ticketId, covered) => {
        const snapshots = getWorktreeSnapshots();
        if (covered) snapshots.noteCovered(ticketId);
        else snapshots.noteUncovered(ticketId);
      },
      onRelevantChange: (ticketIds) => {
        const snapshots = getWorktreeSnapshots();
        for (const ticketId of ticketIds) snapshots.invalidate(ticketId);
      },
    });
    managers.push(manager);

    const webContents = {
      id: 1,
      send: vi.fn(),
      isDestroyed: () => false,
      once: vi.fn(),
      removeListener: vi.fn(),
    };

    let statusLoads = 0;
    let changeSetLoads = 0;
    const readStatus = () =>
      getWorktreeSnapshots().readStatus(TICKET_ID, async () => {
        statusLoads += 1;
        return readWorktreeStatus({ db: ctx.db, gitAsync: git.gitAsync }, TICKET_ID);
      });
    const readChangeSet = () =>
      getWorktreeSnapshots().readChangeSet(TICKET_ID, async () => {
        changeSetLoads += 1;
        return readWorktreeChangeSet({ db: ctx.db, gitAsync: git.gitAsync }, TICKET_ID);
      });

    return {
      git,
      manager,
      webContents,
      watchCalls,
      armCalls,
      statusLoads: () => statusLoads,
      changeSetLoads: () => changeSetLoads,
      readStatus,
      readChangeSet,
      // A panel mounting: it reads the pair, then subscribes (the real order —
      // the mount effect that fetches is declared above the one that watches).
      async mount() {
        await readStatus();
        await readChangeSet();
        await manager.watch(webContents as never, TICKET_ID, worktreePath);
      },
      // A rail page flip: the outgoing panel releases, the incoming one reads
      // and subscribes, all in one render commit.
      async flip() {
        manager.unwatch(webContents as never, TICKET_ID);
        await readStatus();
        await readChangeSet();
        await manager.watch(webContents as never, TICKET_ID, worktreePath);
      },
      fireChange(filename: string) {
        watchCalls[0]!.cb("change", filename);
      },
    };
  }

  it("spawns zero git children between the panels of a Now↔Diffs→Now flip", async () => {
    const rail = railHarness();
    await rail.mount();
    const mountCalls = rail.git.calls.length;
    expect(mountCalls).toBeGreaterThan(0);
    expect(rail.statusLoads()).toBe(1);
    expect(rail.changeSetLoads()).toBe(1);

    await rail.flip();
    await rail.flip();

    // The two flips — and their unwatch/watch handoffs — spawn nothing: the
    // last-known pair is served, and the swap reused the armed watcher.
    expect(rail.git.calls.length).toBe(mountCalls);
    expect(rail.statusLoads()).toBe(1);
    expect(rail.changeSetLoads()).toBe(1);
    expect(rail.watchCalls).toHaveLength(1);
    expect(rail.armCalls).toHaveLength(1);
  });

  it("costs exactly one status and one Change Set read after the watcher reports a change", async () => {
    const rail = railHarness();
    await rail.mount();
    const mountCalls = rail.git.calls.length;
    expect(rail.git.calls.length).toBeGreaterThan(0);

    rail.fireChange("src/edited.ts");
    await rail.flip();

    expect(rail.statusLoads()).toBe(2);
    expect(rail.changeSetLoads()).toBe(2);
    // One more of each — never a second behind the first, and never nothing.
    expect(rail.git.calls.length - mountCalls).toBe(mountCalls);
    expect(rail.git.countMatching(["status", "--porcelain"])).toBe(2);
    expect(rail.git.countMatching(["diff", "--raw", "--numstat"])).toBe(2);
  });

  it("asks only for the base read when a diff tab opens over the Diffs page's snapshot", async () => {
    const rail = railHarness();
    await rail.mount();
    const mountCalls = rail.git.calls.length;

    // The Diffs page's row was clicked: the tab finds its row and its
    // `baseRevision` in the snapshot the page already read, so the only
    // worktree read it needs is the base blob itself — not the Change Set.
    await rail.readChangeSet();
    const base = await readWorktreeBaseFile(
      { db: ctx.db, gitAsync: rail.git.gitAsync },
      TICKET_ID,
      "src/a.ts",
      "base-sha",
    );

    expect(base.kind).toBe("ok");
    expect(rail.changeSetLoads()).toBe(1);
    // `cat-file -e` + `show`: the base read, and nothing of a Change Set read.
    expect(rail.git.calls.length - mountCalls).toBe(2);
    expect(rail.git.countMatching(["cat-file"])).toBe(1);
    expect(rail.git.countMatching(["show"])).toBe(1);
  });

  it("reads fresh once the released watcher's grace expires with no replacement", async () => {
    const rail = railHarness();
    await rail.mount();
    const mountCalls = rail.git.calls.length;

    // The panel closes for good: nothing re-watches within the grace, so the
    // root is really torn down and no coverage remains.
    rail.manager.unwatch(rail.webContents as never, TICKET_ID);
    vi.advanceTimersByTime(WATCH_REWATCH_GRACE_MS);
    await rail.flip();

    // Coverage ended, so the next mount pays for its own reads again.
    expect(rail.git.calls.length).toBeGreaterThan(mountCalls);
    expect(rail.statusLoads()).toBe(2);
    expect(rail.changeSetLoads()).toBe(2);
  });
});

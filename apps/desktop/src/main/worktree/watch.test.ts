import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { listTicketEvents, recordTicketEvent } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import {
  getTicketRow,
  insertTicket,
  setTicketRetentionKeep,
  updateTicketFields,
} from "../db/tickets-repo";
import type { RunNet } from "./net";
import { setRetentionTtlDays } from "./retention";
import { netFailure, scriptedNet } from "./scripted-net";
import {
  createRetentionStore,
  getRetentionState,
  nextBackoffDelay,
  pollRetention,
  retentionConfigFromEnv,
  RetentionWatcher,
  RETENTION_MAX_BACKOFF_MS,
  RETENTION_POLL_INTERVAL_MS,
  type RetentionPollDeps,
} from "./watch";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});
afterEach(() => {
  ctx.cleanup();
});

const DAY = 24 * 60 * 60 * 1000;

interface Notified {
  title: string;
  body: string;
}

/** Poll deps over the test db: scripted net + fixed clock + notify/onChange spies. */
function makeDeps(
  handler: Parameters<typeof scriptedNet>[0],
  now = 1000,
): { deps: RetentionPollDeps; notifications: Notified[]; changes: { n: number } } {
  const { run } = scriptedNet(handler);
  const notifications: Notified[] = [];
  const changes = { n: 0 };
  return {
    deps: {
      db: ctx.db,
      net: run,
      now: () => now,
      notify: (title, body) => notifications.push({ title, body }),
      onChange: () => {
        changes.n += 1;
      },
    },
    notifications,
    changes,
  };
}

function seedProject(): void {
  insertProject(ctx.db, testProject({ id: "p1", path: "/repo" }));
}

/** Inserts a candidate ticket (worktree + branch), optionally with a stored pr_url and Done entry. */
function seedTicket(opts: {
  status?: "needs_review" | "done";
  prUrl?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  doneAt?: number;
}): void {
  const t = testTicket("p1", {
    id: "t1",
    status: opts.status ?? "needs_review",
    worktreePath: opts.worktreePath === undefined ? "/repo/wt" : opts.worktreePath,
    branch: opts.branch === undefined ? "volli/VC-1-x" : opts.branch,
  });
  insertTicket(ctx.db, t);
  if (opts.prUrl) updateTicketFields(ctx.db, "t1", { prUrl: opts.prUrl }, 1);
  if (opts.doneAt !== undefined) {
    recordTicketEvent(
      ctx.db,
      "t1",
      { kind: "status_changed", from: "needs_review", to: "done" },
      opts.doneAt,
    );
  }
}

function prView(over: Record<string, unknown> = {}): { stdout: string } {
  return {
    stdout: JSON.stringify({
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
      ...over,
    }),
  };
}

/**
 * Wraps a real db so `.transaction(...)` throws — every other call passes
 * through, rebound to the real instance (better-sqlite3's native methods
 * require the real `this`, not the proxy). Simulates a durable-write failure
 * (F7) without needing a real constraint violation.
 */
function dbWithBrokenTransaction(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return () => {
          throw new Error("simulated write failure");
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database.Database;
}

/** A promise plus its externally-callable resolver — for pausing a scripted net call mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("pollRetention — discovery", () => {
  it("stamps a discovered pr_url and records a pr_opened automation event", async () => {
    seedProject();
    seedTicket({ prUrl: null });
    const { deps } = makeDeps((_file, args) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([{ url: "https://x/pull/9", state: "OPEN", updatedAt: "z" }]),
        };
      }
      if (args[1] === "view") return prView();
      return { stdout: "" };
    });

    await pollRetention(deps, createRetentionStore());

    expect(getTicketRow(ctx.db, "t1")!.pr_url).toBe("https://x/pull/9");
    const opened = listTicketEvents(ctx.db, "t1").find((e) => e.payload.kind === "pr_opened");
    expect(opened).toBeDefined();
    expect(opened!.actor).toBe("automation");
  });

  it("clears a stale observation and stays silent when no PR is found", async () => {
    seedProject();
    seedTicket({ prUrl: null });
    const { deps, notifications } = makeDeps(() => ({ stdout: "[]" }));
    const store = createRetentionStore();
    await pollRetention(deps, store);
    expect(store.observations.has("t1")).toBe(false);
    expect(notifications).toHaveLength(0);
  });
});

describe("pollRetention — merge", () => {
  it("records ONE pr_merged event + ONE notification on first merge, deduped after", async () => {
    seedProject();
    seedTicket({ prUrl: "https://x/pull/7" });
    const { deps, notifications, changes } = makeDeps(() =>
      prView({ state: "MERGED", mergedAt: "2026-07-20T00:00:00Z" }),
    );
    const store = createRetentionStore();

    await pollRetention(deps, store);
    await pollRetention(deps, store);
    await pollRetention(deps, store);

    const merged = listTicketEvents(ctx.db, "t1").filter((e) => e.payload.kind === "pr_merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.actor).toBe("automation");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Pull request merged");
    // Broadcast only on the cycle that changed things.
    expect(changes.n).toBe(1);
  });

  it("does not re-notify on a fresh store (restart) when a pr_merged event already exists", async () => {
    seedProject();
    seedTicket({ prUrl: "https://x/pull/7" });
    recordTicketEvent(ctx.db, "t1", { kind: "pr_merged", url: "https://x/pull/7" }, 1, {
      kind: "automation",
    });
    const { deps, notifications } = makeDeps(() => prView({ state: "MERGED" }));

    await pollRetention(deps, createRetentionStore());

    expect(notifications).toHaveLength(0);
    expect(
      listTicketEvents(ctx.db, "t1").filter((e) => e.payload.kind === "pr_merged"),
    ).toHaveLength(1);
  });
});

describe("pollRetention — F3: per-ticket isolation on the merge one-shot", () => {
  it("a throw recording one ticket's pr_merged event doesn't poison notifiedMerged nor abort the rest of the cycle", async () => {
    seedProject();
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t1",
        status: "needs_review",
        worktreePath: "/repo/wt1",
        branch: "volli/VC-1-x",
      }),
    );
    updateTicketFields(ctx.db, "t1", { prUrl: "https://x/pull/1" }, 1);
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t2",
        status: "needs_review",
        worktreePath: "/repo/wt2",
        branch: "volli/VC-2-y",
      }),
    );
    updateTicketFields(ctx.db, "t2", { prUrl: "https://x/pull/2" }, 1);

    const { deps, notifications } = makeDeps((_file, args) => {
      if (args[1] === "view") {
        if (args[2] === "https://x/pull/1") {
          // Simulate a concurrent delete racing the poll: t1's ticket row is
          // gone by the time its merge event tries to write, so the FK insert
          // throws.
          ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run("t1");
        }
        return prView({ state: "MERGED" });
      }
      return { stdout: "" };
    });
    const store = createRetentionStore();

    const result = await pollRetention(deps, store);

    // notifiedMerged was never poisoned by an add-before-success: t1's write
    // threw, so it was never added.
    expect(store.notifiedMerged.has("t1")).toBe(false);
    // t2's own merge event + notification still landed — one ticket's throw
    // didn't abort the whole candidate loop.
    expect(
      listTicketEvents(ctx.db, "t2").filter((e) => e.payload.kind === "pr_merged"),
    ).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Pull request merged");
    expect(result.changed).toBe(true);
  });
});

describe("pollRetention — checks & conflicts surfacing", () => {
  it("surfaces merge conflicts and failing checks; an open conflicted PR is not archive-ready", async () => {
    seedProject();
    seedTicket({ prUrl: "https://x/pull/7" });
    const { deps } = makeDeps(() =>
      prView({
        mergeStateStatus: "DIRTY",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }),
    );
    const store = createRetentionStore();
    await pollRetention(deps, store);

    const state = getRetentionState(deps, store, "t1")!;
    expect(state.hasConflicts).toBe(true);
    expect(state.failingChecks).toEqual(["lint"]);
    expect(state.prState).toBe("open");
    expect(state.archiveReady).toBe(false);
  });
});

describe("pollRetention — background read failures are silent", () => {
  it("counts a failure for backoff, fires no notification", async () => {
    seedProject();
    seedTicket({ prUrl: "https://x/pull/7" });
    const { deps, notifications } = makeDeps(() => {
      throw Object.assign(new Error("offline"), { stderr: "could not resolve host", code: 1 });
    });
    const result = await pollRetention(deps, createRetentionStore());
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(notifications).toHaveLength(0);
  });
});

describe("pollRetention — F5: ghCwd falls back to the project checkout", () => {
  it("uses the project path when worktree_path doesn't exist on disk", async () => {
    // A real, existing directory (the test db's own tmp dir) stands in for
    // the project checkout; the worktree path is a sibling that was never
    // created — the documented "removed on archive" case.
    const realProjectDir = dirname(ctx.dbPath);
    insertProject(ctx.db, testProject({ id: "p1", path: realProjectDir }));
    const missingWorktree = join(realProjectDir, "gone-worktree");
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t1",
        status: "needs_review",
        worktreePath: missingWorktree,
        branch: "volli/VC-1-x",
      }),
    );
    updateTicketFields(ctx.db, "t1", { prUrl: "https://x/pull/7" }, 1);

    const { run, calls } = scriptedNet(() => prView());
    const deps: RetentionPollDeps = {
      db: ctx.db,
      net: run,
      now: () => 1000,
      notify: () => {},
    };
    await pollRetention(deps, createRetentionStore());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe(realProjectDir);
  });
});

describe("pollRetention — F6: a discovery stamp counts as a change even if the following status fetch fails", () => {
  it("sets result.changed when the pr_url write lands, before the status fetch fails", async () => {
    seedProject();
    seedTicket({ prUrl: null });
    const { deps } = makeDeps((_file, args) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([{ url: "https://x/pull/9", state: "OPEN", updatedAt: "z" }]),
        };
      }
      if (args[1] === "view") {
        throw netFailure({ stderr: "network blip", code: 1 });
      }
      return { stdout: "" };
    });

    const result = await pollRetention(deps, createRetentionStore());

    // The stamp durably wrote pr_url...
    expect(getTicketRow(ctx.db, "t1")!.pr_url).toBe("https://x/pull/9");
    // ...and that write is reflected even though the immediately-following
    // status fetch for the same ticket, same cycle, failed.
    expect(result.changed).toBe(true);
    expect(result.failed).toBe(1);
  });
});

describe("pollRetention — F7: a failed PR-url stamp is isolated, surfaced, and retryable", () => {
  it("notifies on a stamp failure, leaves pr_url null for DISCOVER to retry, and doesn't poison the cycle", async () => {
    seedProject();
    seedTicket({ prUrl: null });
    const { deps, notifications } = makeDeps((_file, args) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([{ url: "https://x/pull/9", state: "OPEN", updatedAt: "z" }]),
        };
      }
      return { stdout: "" };
    });
    const brokenDeps: RetentionPollDeps = { ...deps, db: dbWithBrokenTransaction(ctx.db) };

    const result = await pollRetention(brokenDeps, createRetentionStore());

    // Surfaced via the same native-notification seam the merge one-shot uses
    // — the only user-visible surface a background poll has.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Couldn't save discovered PR");
    // Retry path: the write never landed, so pr_url is still null — DISCOVER
    // tries the stamp again next poll.
    expect(getTicketRow(ctx.db, "t1")!.pr_url).toBeNull();
    expect(listTicketEvents(ctx.db, "t1")).toHaveLength(0);
    // The failure didn't poison the rest of the cycle: the poll still
    // returns cleanly.
    expect(result.changed).toBe(false);
  });
});

describe("RetentionWatcher — F4: schedule() never leaves a second timer chain", () => {
  it("stop() during an in-flight poll, then start(), leaves exactly one self-perpetuating chain", async () => {
    vi.useFakeTimers();
    try {
      seedProject();
      seedTicket({ prUrl: "https://x/pull/7" });
      let callCount = 0;
      const gate = deferred<{ stdout: string; stderr: string }>();
      const net: RunNet = async () => {
        callCount += 1;
        if (callCount === 1) return gate.promise;
        return { stdout: prView().stdout, stderr: "" };
      };
      const deps: RetentionPollDeps = {
        db: ctx.db,
        net,
        now: () => 1000,
        notify: () => {},
      };
      const config = { intervalMs: 1000, maxBackoffMs: 60_000 };
      const watcher = new RetentionWatcher(deps, config);

      watcher.start();
      // Fire the first scheduled poll — it calls net and suspends on `gate`.
      await vi.advanceTimersByTimeAsync(1000);
      expect(callCount).toBe(1);

      // stop() while the poll is in flight, then start() again: the bug lets
      // the in-flight run's `finally` reschedule a SECOND chain that stop()
      // can no longer reach (it only clears the last-written timer id).
      watcher.stop();
      watcher.start();

      // Let the in-flight poll resolve; its `finally` reschedules too.
      gate.resolve({ stdout: prView().stdout, stderr: "" });
      await vi.advanceTimersByTimeAsync(0);

      // Advance exactly one more interval. With the fix, only ONE chain is
      // alive, so exactly one more poll runs (2 total). The bug would run
      // TWO (3 total) — start()'s chain AND the orphaned finally chain.
      await vi.advanceTimersByTimeAsync(1000);
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getRetentionState — Keep exempts BOTH paths (the Vibe-Kanban bug)", () => {
  it("keep=false: a merged PR is archive-ready (merge path fires)", async () => {
    seedProject();
    seedTicket({ status: "done", prUrl: "https://x/pull/7", doneAt: 0 });
    const { deps } = makeDeps(() => prView({ state: "MERGED" }), 100 * DAY);
    const store = createRetentionStore();
    await pollRetention(deps, store);
    const state = getRetentionState(deps, store, "t1")!;
    expect(state.archiveReady).toBe(true);
    expect(state.reason).toBe("pr-merged");
  });

  it("keep=true: the SAME merged PR is exempt (merge path suppressed)", async () => {
    seedProject();
    seedTicket({ status: "done", prUrl: "https://x/pull/7", doneAt: 0 });
    setTicketRetentionKeep(ctx.db, "t1", true, 1);
    const { deps } = makeDeps(() => prView({ state: "MERGED" }), 100 * DAY);
    const store = createRetentionStore();
    await pollRetention(deps, store);
    const state = getRetentionState(deps, store, "t1")!;
    expect(state.archiveReady).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.keep).toBe(true);
  });

  it("keep=true: an expired Done PR-less ticket is exempt (TTL path suppressed)", async () => {
    seedProject();
    setRetentionTtlDays(ctx.db, 14, 0);
    seedTicket({ status: "done", prUrl: null, doneAt: 0 });
    setTicketRetentionKeep(ctx.db, "t1", true, 1);
    const { deps } = makeDeps(() => ({ stdout: "[]" }), 100 * DAY);
    const store = createRetentionStore();
    await pollRetention(deps, store);
    const state = getRetentionState(deps, store, "t1")!;
    expect(state.archiveReady).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("keep=false: an expired Done PR-less ticket IS archive-ready (TTL path fires)", async () => {
    seedProject();
    setRetentionTtlDays(ctx.db, 14, 0);
    seedTicket({ status: "done", prUrl: null, doneAt: 0 });
    const { deps } = makeDeps(() => ({ stdout: "[]" }), 100 * DAY);
    const store = createRetentionStore();
    await pollRetention(deps, store);
    const state = getRetentionState(deps, store, "t1")!;
    expect(state.archiveReady).toBe(true);
    expect(state.reason).toBe("ttl-expired");
  });
});

describe("getRetentionState — F1: an unpolled PR blocks the TTL path", () => {
  it("a Done-past-TTL ticket with a stamped pr_url but no observation yet is NOT archive-ready", () => {
    seedProject();
    setRetentionTtlDays(ctx.db, 14, 0);
    seedTicket({ status: "done", prUrl: "https://x/pull/7", doneAt: 0 });
    // No pollRetention: the PR's state is UNKNOWN (offline, gh missing, or
    // simply before the first interval) — "an open PR waits for its merge,
    // never a TTL" must hold in that window too.
    const { deps } = makeDeps(() => ({ stdout: "[]" }), 100 * DAY);
    const state = getRetentionState(deps, createRetentionStore(), "t1")!;
    expect(state.archiveReady).toBe(false);
    expect(state.reason).toBeNull();
  });
});

describe("getRetentionState — dismissal is launch-scoped", () => {
  it("suppresses the prompt after dismiss, still reporting the reason", async () => {
    seedProject();
    seedTicket({ prUrl: "https://x/pull/7" });
    const { deps } = makeDeps(() => prView({ state: "MERGED" }));
    const store = createRetentionStore();
    await pollRetention(deps, store);

    expect(getRetentionState(deps, store, "t1")!.archiveReady).toBe(true);
    store.dismissed.add("t1");
    const state = getRetentionState(deps, store, "t1")!;
    expect(state.archiveReady).toBe(false);
    expect(state.dismissed).toBe(true);
    expect(state.reason).toBe("pr-merged");
  });
});

describe("RetentionWatcher — driver surface (no timers)", () => {
  it("composes state for a never-polled ticket (keep from db, prState null) and dismiss suppresses", () => {
    seedProject();
    seedTicket({ status: "done", prUrl: "https://x/pull/7", doneAt: 0 });
    const { deps } = makeDeps(() => ({ stdout: "" }));
    const watcher = new RetentionWatcher(deps, { intervalMs: 60_000, maxBackoffMs: 900_000 });

    const state = watcher.getState("t1")!;
    // No poll ran, so the PR observation is unknown but the stored url shows through.
    expect(state.prUrl).toBe("https://x/pull/7");
    expect(state.prState).toBeNull();
    expect(state.keep).toBe(false);

    watcher.dismiss("t1");
    expect(watcher.getState("t1")!.dismissed).toBe(true);
    expect(watcher.getState("unknown")).toBeNull();
  });

  it("stop() before start() is a safe no-op", () => {
    const { deps } = makeDeps(() => ({ stdout: "" }));
    const watcher = new RetentionWatcher(deps, { intervalMs: 60_000, maxBackoffMs: 900_000 });
    expect(() => watcher.stop()).not.toThrow();
  });
});

describe("nextBackoffDelay + config", () => {
  const config = { intervalMs: 60_000, maxBackoffMs: 900_000 };

  it("returns the base interval when healthy", () => {
    expect(nextBackoffDelay(0, config)).toBe(60_000);
  });

  it("doubles per consecutive failure", () => {
    expect(nextBackoffDelay(1, config)).toBe(120_000);
    expect(nextBackoffDelay(2, config)).toBe(240_000);
  });

  it("caps at maxBackoffMs", () => {
    expect(nextBackoffDelay(20, config)).toBe(900_000);
  });

  it("reads env overrides, falling back to the defaults", () => {
    expect(retentionConfigFromEnv({})).toEqual({
      intervalMs: RETENTION_POLL_INTERVAL_MS,
      maxBackoffMs: RETENTION_MAX_BACKOFF_MS,
    });
    expect(retentionConfigFromEnv({ VOLLI_RETENTION_INTERVAL_MS: "500" }).intervalMs).toBe(500);
    expect(retentionConfigFromEnv({ VOLLI_RETENTION_INTERVAL_MS: "0" }).intervalMs).toBe(
      RETENTION_POLL_INTERVAL_MS,
    );
  });
});

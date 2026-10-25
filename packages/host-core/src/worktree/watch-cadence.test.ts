/**
 * The retention watch's cadence (VC-686): an always-on host pays for what moved
 * on the board, not for the board's size. Each ticket's PR read carries its own
 * schedule, ticket changes wake the driver, and the trim backfill remembers
 * what it already walked.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { recordTicketEvent } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields, updateTicketPositionStatus } from "../db/tickets-repo";
import { captureHostLog } from "../testing/log";
import { netFailure, scriptedNet } from "./scripted-net";
import {
  createRetentionStore,
  nextCycleDelay,
  pollRetention,
  RETENTION_CHANGE_DEBOUNCE_MS,
  RETENTION_POLL_INTERVAL_MS,
  RETENTION_QUIET_MAX_MS,
  RETENTION_TRIM_SETTLED_RECHECK_MS,
  RetentionWatcher,
  type RetentionPollPorts,
  type RetentionWatchConfig,
} from "./watch";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Well past the Done discovery grace, so Done tickets without a PR read nothing. */
const T0 = 100 * DAY;
const CONFIG: RetentionWatchConfig = {
  intervalMs: RETENTION_POLL_INTERVAL_MS,
  maxBackoffMs: 15 * MINUTE,
  quietMaxMs: RETENTION_QUIET_MAX_MS,
};

let ctx: TestDb;
let root: string;

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-watch-cadence-"));
  insertProject(ctx.db, testProject({ id: "p1", path: root }));
});

afterEach(() => {
  vi.useRealTimers();
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

let seeded = 0;

/** One candidate ticket; `onDisk` makes its worktree a real (empty) directory. */
function seed(opts: {
  status: "backlog" | "needs_review" | "done";
  prUrl?: string;
  merged?: boolean;
  onDisk?: boolean;
}): string {
  seeded += 1;
  const id = `t${seeded}`;
  const worktreePath = join(root, `wt-${id}`);
  if (opts.onDisk === true) mkdirSync(worktreePath);
  insertTicket(
    ctx.db,
    testTicket("p1", { id, status: opts.status, worktreePath, branch: `volli/${id}` }),
  );
  if (opts.prUrl !== undefined) updateTicketFields(ctx.db, id, { prUrl: opts.prUrl }, 1);
  if (opts.status === "done") {
    recordTicketEvent(ctx.db, id, { kind: "status_changed", from: "needs_review", to: "done" }, 1);
  }
  if (opts.merged === true && opts.prUrl !== undefined) {
    recordTicketEvent(ctx.db, id, { kind: "pr_merged", url: opts.prUrl }, 1, {
      kind: "automation",
    });
  }
  return id;
}

function prView(state: string, checks: unknown[] = []): { stdout: string } {
  return {
    stdout: JSON.stringify({
      state,
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: checks,
    }),
  };
}

/** A network that finds no PR for any branch and reads every PR as open (or closed). */
function quietNet() {
  return scriptedNet((_file, args) => {
    if (args[1] === "list") return { stdout: "[]" };
    return prView(String(args[2]).includes("/closed-") ? "CLOSED" : "OPEN");
  });
}

/** Trim seams over a git that reports a clean worktree with nothing ignored. */
function countingTrim(busy: () => boolean = () => false) {
  const git: string[] = [];
  return {
    git,
    seams: {
      worktree: {
        db: ctx.db,
        gitAsync: async (args: readonly string[]) => {
          git.push(args.join(" "));
          return "";
        },
        blobsRoot: "unused",
      },
      now: () => Date.now(),
      busySites: async (path: string) =>
        busy() ? [{ directory: path, surface: "terminal" as const }] : [],
    },
  };
}

/** Advances fake time in one-second steps, letting each poll's real I/O land. */
async function runFor(watcher: RetentionWatcher, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await vi.advanceTimersByTimeAsync(1000);
    await watcher.settled();
  }
}

function fakeClock(): void {
  vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "Date"] });
}

describe("nextCycleDelay", () => {
  it("backs off on failure, follows the earliest due read, and stays inside the interval and the ceiling", () => {
    expect(nextCycleDelay(2, 0, CONFIG)).toBe(4 * MINUTE);
    expect(nextCycleDelay(0, null, CONFIG)).toBe(RETENTION_QUIET_MAX_MS);
    expect(nextCycleDelay(0, 0, CONFIG)).toBe(MINUTE);
    expect(nextCycleDelay(0, 7 * MINUTE, CONFIG)).toBe(7 * MINUTE);
    expect(nextCycleDelay(0, 2 * HOUR, CONFIG)).toBe(RETENTION_QUIET_MAX_MS);
    // A ceiling configured below the interval never makes the cycle faster.
    expect(nextCycleDelay(0, null, { ...CONFIG, quietMaxMs: 1000 })).toBe(MINUTE);
  });
});

describe("pollRetention — per-ticket read schedule", () => {
  function deps(net: ReturnType<typeof scriptedNet>, clock: { now: number }): RetentionPollPorts {
    return { db: ctx.db, net: net.run, now: () => clock.now, notify: () => {} };
  }

  it("doubles a quiet ticket's delay up to the ceiling, and reads a changed row at once", async () => {
    const id = seed({ status: "backlog" });
    const net = quietNet();
    const clock = { now: T0 };
    const store = createRetentionStore();
    const readsAt: number[] = [];
    for (let minute = 0; minute <= 40; minute += 1) {
      const before = net.calls.length;
      await pollRetention(deps(net, clock), store);
      if (net.calls.length > before) readsAt.push(minute);
      clock.now += MINUTE;
    }
    expect(readsAt).toEqual([0, 1, 3, 7, 15, 30]);

    // A move rewrites the row: the next cycle reads it, whatever the backoff.
    updateTicketPositionStatus(ctx.db, id, "needs_review", 0, clock.now);
    const before = net.calls.length;
    await pollRetention(deps(net, clock), store);
    expect(net.calls.length).toBe(before + 1);
  });

  it("keeps an open PR with a running check on the active interval", async () => {
    seed({ status: "needs_review", prUrl: "https://x/pull/1" });
    const net = scriptedNet(() =>
      prView("OPEN", [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }]),
    );
    const clock = { now: T0 };
    const store = createRetentionStore();
    for (let minute = 0; minute < 5; minute += 1) {
      await pollRetention(deps(net, clock), store);
      clock.now += MINUTE;
    }
    expect(net.calls).toHaveLength(5);
  });

  it("reads a ticket whose read failed again on the next cycle", async () => {
    seed({ status: "needs_review", prUrl: "https://x/pull/1" });
    let fail = true;
    const net = scriptedNet(() => {
      if (fail) throw netFailure({ stderr: "offline", code: 1 });
      return prView("OPEN");
    });
    const clock = { now: T0 };
    const store = createRetentionStore();
    await pollRetention(deps(net, clock), store);
    fail = false;
    clock.now += 1000;
    const result = await pollRetention(deps(net, clock), store);
    expect(net.calls).toHaveLength(2);
    expect(result.nextDueInMs).toBe(MINUTE);
  });

  it("a present poll reads what is older than the interval, never what was just read", async () => {
    seed({ status: "backlog" });
    const net = quietNet();
    const clock = { now: T0 };
    const store = createRetentionStore();
    await pollRetention(deps(net, clock), store);
    clock.now += MINUTE;
    await pollRetention(deps(net, clock), store);
    // Backed off to two minutes; thirty seconds later a person looks.
    clock.now += 30_000;
    await pollRetention(deps(net, clock), store, { present: true });
    expect(net.calls).toHaveLength(2);
    // Past the interval, a person looking reads it before its backoff would.
    clock.now += 30_000;
    await pollRetention(deps(net, clock), store);
    expect(net.calls).toHaveLength(2);
    await pollRetention(deps(net, clock), store, { present: true });
    expect(net.calls).toHaveLength(3);
  });

  it("holds no schedule for a ticket with nothing left to read", async () => {
    seed({ status: "done", prUrl: "https://x/pull/m", merged: true });
    seed({ status: "done" });
    seed({ status: "done", prUrl: "https://x/pull/closed-1" });
    const net = quietNet();
    const clock = { now: T0 };
    const store = createRetentionStore();
    const first = await pollRetention(deps(net, clock), store);
    // Only the closed PR is read, once; a closed PR is terminal, so it is not
    // scheduled again.
    expect(net.calls).toHaveLength(1);
    expect(first.nextDueInMs).toBeNull();
    clock.now += HOUR;
    await pollRetention(deps(net, clock), store);
    expect(net.calls).toHaveLength(1);
    expect(store.reads.size).toBe(0);
  });
});

describe("pollRetention — the trim backfill's memo", () => {
  it("walks a finished worktree once, again when its ticket changes, and again after the recheck", async () => {
    const id = seed({ status: "done", onDisk: true });
    const trim = countingTrim();
    const clock = { now: T0 };
    const store = createRetentionStore();
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: quietNet().run,
      now: () => clock.now,
      notify: () => {},
      trim: { ...trim.seams, now: () => clock.now },
    };

    expect((await pollRetention(deps, store)).trimWalks).toBe(1);
    const walked = trim.git.length;
    expect(walked).toBeGreaterThan(0);
    clock.now += MINUTE;
    expect((await pollRetention(deps, store)).trimWalks).toBe(0);

    updateTicketFields(ctx.db, id, { title: "renamed" }, clock.now);
    expect((await pollRetention(deps, store)).trimWalks).toBe(1);

    clock.now += RETENTION_TRIM_SETTLED_RECHECK_MS - 1;
    expect((await pollRetention(deps, store)).trimWalks).toBe(0);
    clock.now += 1;
    expect((await pollRetention(deps, store)).trimWalks).toBe(1);
  });

  it("asks a refused trim again once the quiet ceiling passes", async () => {
    seed({ status: "done", onDisk: true });
    let busy = true;
    const trim = countingTrim(() => busy);
    const clock = { now: T0 };
    const store = createRetentionStore();
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: quietNet().run,
      now: () => clock.now,
      notify: () => {},
      trim: { ...trim.seams, now: () => clock.now },
    };

    expect((await pollRetention(deps, store)).trimWalks).toBe(1);
    busy = false;
    clock.now += RETENTION_QUIET_MAX_MS - 1;
    expect((await pollRetention(deps, store)).trimWalks).toBe(0);
    clock.now += 1;
    expect((await pollRetention(deps, store)).trimWalks).toBe(1);
  });
});

describe("RetentionWatcher — idle load on a quiet board", () => {
  it("an hour of a quiet board costs a bounded number of reads, walks and cycles", async () => {
    fakeClock();
    for (let i = 0; i < 12; i += 1) seed({ status: "backlog" });
    for (let i = 0; i < 4; i += 1) seed({ status: "needs_review", prUrl: `https://x/pull/o${i}` });
    for (let i = 0; i < 40; i += 1) {
      seed({ status: "done", prUrl: `https://x/pull/m${i}`, merged: true, onDisk: i < 10 });
    }
    for (let i = 0; i < 3; i += 1) {
      seed({ status: "done", prUrl: `https://x/pull/closed-${i}`, onDisk: true });
    }
    for (let i = 0; i < 20; i += 1) seed({ status: "done", onDisk: i < 5 });
    const net = quietNet();
    const trim = countingTrim();
    const log = captureHostLog();
    const cycles = (): number =>
      log.of("worktree-watch").filter((record) => record.msg === "retention cycle").length;
    const watcher = new RetentionWatcher(
      { db: ctx.db, net: net.run, now: () => Date.now(), notify: () => {}, trim: trim.seams },
      CONFIG,
    );
    watcher.start();

    // The first hour settles in: every ticket is read, every walk happens once.
    await runFor(watcher, HOUR);
    const firstHourReads = net.calls.length;
    const firstHourGit = trim.git.length;
    // Polled every minute, the same hour would have cost 16 reads a cycle.
    expect(firstHourReads).toBeLessThan(16 * 60 * 0.15);

    // The second hour is the steady state: each quiet ticket is read once per
    // ceiling, no worktree is walked again, and the driver sleeps in between
    // instead of waking every minute.
    const firstHourCycles = cycles();
    await runFor(watcher, HOUR);
    watcher.stop();
    await watcher.settled();
    log.restore();
    expect(net.calls.length - firstHourReads).toBe(16 * (HOUR / RETENTION_QUIET_MAX_MS));
    expect(trim.git.length - firstHourGit).toBe(0);
    expect(cycles() - firstHourCycles).toBe(HOUR / RETENTION_QUIET_MAX_MS);
  });
});

/** A ticket change source a test fires by hand. */
function changeSource() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

const noop = (): void => {};

describe("RetentionWatcher — ticket changes drive the reads", () => {
  it("reads a changed ticket within the debounce, not at the next scheduled cycle", async () => {
    fakeClock();
    const quiet = seed({ status: "backlog" });
    const moved = seed({ status: "backlog" });
    const net = quietNet();
    const changes = changeSource();
    const watcher = new RetentionWatcher(
      { db: ctx.db, net: net.run, now: () => Date.now(), notify: () => {} },
      CONFIG,
      changes.subscribe,
    );
    watcher.start();
    expect(changes.size).toBe(1);
    await runFor(watcher, 20 * MINUTE);
    const before = net.calls.length;

    updateTicketPositionStatus(ctx.db, moved, "needs_review", 0, Date.now());
    changes.fire();
    changes.fire();
    await runFor(watcher, RETENTION_CHANGE_DEBOUNCE_MS);
    const read = net.calls.slice(before).map((call) => call.args[3]);
    expect(read).toEqual([`volli/${moved}`]);
    expect(read).not.toContain(`volli/${quiet}`);

    watcher.stop();
    expect(changes.size).toBe(0);
  });

  it("a change that lands mid-poll is read once that poll finishes", async () => {
    fakeClock();
    const id = seed({ status: "backlog" });
    let release: (() => void) | null = null;
    let fireChange: () => void = noop;
    const calls: string[] = [];
    const watcher = new RetentionWatcher(
      {
        db: ctx.db,
        net: async (_file, args) => {
          calls.push(String(args[3]));
          if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
          return { stdout: "[]", stderr: "" };
        },
        now: () => Date.now(),
        notify: () => {},
      },
      CONFIG,
      (listener) => {
        fireChange = listener;
        return () => {};
      },
    );
    watcher.start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls).toHaveLength(1);

    updateTicketPositionStatus(ctx.db, id, "needs_review", 0, Date.now());
    fireChange();
    release!();
    await watcher.settled();
    await vi.advanceTimersByTimeAsync(RETENTION_CHANGE_DEBOUNCE_MS);
    await watcher.settled();
    expect(calls).toHaveLength(2);
    watcher.stop();
  });

  it("ignores a change once stopped", async () => {
    fakeClock();
    seed({ status: "backlog" });
    const net = quietNet();
    let fire: () => void = noop;
    const watcher = new RetentionWatcher(
      { db: ctx.db, net: net.run, now: () => Date.now(), notify: () => {} },
      CONFIG,
      (listener) => {
        fire = listener;
        return () => {};
      },
    );
    watcher.start();
    fire();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(net.calls).toHaveLength(0);
  });
});

describe("RetentionWatcher — load accounting", () => {
  it("writes each cycle at debug and an hourly summary of reads, walks and scan time", async () => {
    fakeClock();
    const log = captureHostLog();
    try {
      seed({ status: "backlog" });
      seed({ status: "done", onDisk: true });
      const net = quietNet();
      const trim = countingTrim();
      const watcher = new RetentionWatcher(
        { db: ctx.db, net: net.run, now: () => Date.now(), notify: () => {}, trim: trim.seams },
        CONFIG,
      );
      watcher.start();
      await runFor(watcher, HOUR + 2 * MINUTE);
      watcher.stop();

      const records = log.of("worktree-watch");
      expect(records).toContainEqual(
        expect.objectContaining({ level: "debug", msg: "retention cycle", ghReads: 1 }),
      );
      const summaries = records.filter((record) => record.msg === "retention load");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toEqual(
        expect.objectContaining({
          level: "info",
          ghReads: net.calls.length,
          ghFailures: 0,
          trimWalks: 1,
        }),
      );
    } finally {
      log.restore();
    }
  });
});

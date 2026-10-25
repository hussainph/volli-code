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
import { listTicketEvents } from "../db/events-repo";
import { captureHostLog } from "../testing/log";
import { setRetentionTtlDays } from "./retention";
import { netFailure, scriptedNet } from "./scripted-net";
import {
  createRetentionStore,
  pollRetention,
  retentionConfigFromEnv,
  RetentionWatcher,
  type RetentionPollPorts,
  type RetentionWatchConfig,
} from "./watch";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Well past the Done discovery grace, so Done tickets without a PR read nothing. */
const T0 = 100 * DAY;
/** The shipped timings: a one-minute interval, a fifteen-minute quiet ceiling. */
const CONFIG: RetentionWatchConfig = retentionConfigFromEnv({});
const QUIET_MAX = CONFIG.quietMaxMs;
const DEBOUNCE = CONFIG.changeDebounceMs;

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

it("runs on the shipped timings these cases are written against", () => {
  expect(CONFIG.intervalMs).toBe(MINUTE);
  expect(QUIET_MAX).toBe(15 * MINUTE);
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

  it("backs a failing read off on its own, and retries the first failure after one interval", async () => {
    seed({ status: "needs_review", prUrl: "https://x/pull/1" });
    seed({ status: "backlog" });
    const net = scriptedNet((_file, args) => {
      if (args[1] === "view") throw netFailure({ stderr: "not found", code: 1 });
      return { stdout: "[]" };
    });
    const clock = { now: T0 };
    const store = createRetentionStore();
    // A cycle where one read fails and another succeeds still wakes in a minute.
    const first = await pollRetention(deps(net, clock), store);
    expect(first.failed).toBe(1);
    expect(first.nextDueInMs).toBe(MINUTE);

    const failedAt: number[] = [0];
    for (let minute = 1; minute <= 40; minute += 1) {
      clock.now += MINUTE;
      const before = net.calls.filter((call) => call.args[1] === "view").length;
      await pollRetention(deps(net, clock), store);
      if (net.calls.filter((call) => call.args[1] === "view").length > before) {
        failedAt.push(minute);
      }
    }
    expect(failedAt).toEqual([0, 1, 3, 7, 15, 30]);
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

describe("pollRetention — what a skipped read may still decide", () => {
  /** A Done ticket inside the discovery grace and past a one-day TTL: reclaimable by dwell. */
  function reclaimable(): {
    id: string;
    reclaimAsks: { n: number };
    reclaim: RetentionPollPorts["reclaim"];
  } {
    setRetentionTtlDays(ctx.db, 1, T0);
    const id = "r1";
    const worktreePath = join(root, "wt-r1");
    mkdirSync(worktreePath);
    insertTicket(
      ctx.db,
      testTicket("p1", { id, status: "done", worktreePath, branch: "volli/r1" }),
    );
    recordTicketEvent(
      ctx.db,
      id,
      { kind: "status_changed", from: "needs_review", to: "done" },
      T0 - 2 * DAY,
    );
    const reclaimAsks = { n: 0 };
    return {
      id,
      reclaimAsks,
      reclaim: {
        worktree: { db: ctx.db, gitAsync: async () => "", blobsRoot: "unused" },
        now: () => T0,
        // Asked only once the verdict says reclaim; answering "busy" keeps the
        // folder, so the count is exactly how often a deletion was on the table.
        busyWorktreeSites: async (directory) => {
          reclaimAsks.n += 1;
          return [{ directory, surface: "terminal" }];
        },
      },
    };
  }

  it('does not reclaim on an earlier cycle\'s "no PR": only on the cycle whose discovery is fresh', async () => {
    const { reclaimAsks, reclaim } = reclaimable();
    const net = quietNet();
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
      reclaim,
    };
    const store = createRetentionStore();
    await pollRetention(deps, store);
    expect(reclaimAsks.n).toBe(1);
    clock.now += 30_000;
    await pollRetention(deps, store);
    expect(net.calls).toHaveLength(1);
    expect(reclaimAsks.n).toBe(1);
    clock.now += 30_000;
    await pollRetention(deps, store);
    expect(net.calls).toHaveLength(2);
    expect(reclaimAsks.n).toBe(2);
  });

  it("never reclaims while a discovered PR could not be stamped, focus poll or not", async () => {
    const { reclaimAsks, reclaim } = reclaimable();
    const net = scriptedNet(() => ({
      stdout: JSON.stringify([{ url: "https://x/pull/9", state: "OPEN", updatedAt: "2026-01-01" }]),
    }));
    const broken = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === "transaction") {
          return () => {
            throw new Error("simulated write failure");
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: broken,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
      reclaim,
    };
    const store = createRetentionStore();
    await pollRetention(deps, store, { present: true });
    for (const step of [30_000, 30_000, 30_000]) {
      clock.now += step;
      await pollRetention(deps, store);
    }
    expect(net.calls.length).toBeGreaterThan(1);
    expect(reclaimAsks.n).toBe(0);
  });

  it("re-reads a merge whose one-shot write failed, even before the ticket's read is due", async () => {
    const insert = (): void => {
      insertTicket(
        ctx.db,
        testTicket("p1", {
          id: "m1",
          status: "needs_review",
          worktreePath: join(root, "wt-m1"),
          branch: "volli/m1",
        }),
      );
      updateTicketFields(ctx.db, "m1", { prUrl: "https://x/pull/m1" }, 1);
    };
    insert();
    let merged = false;
    let failWrite = false;
    const net = scriptedNet(() => {
      // Deleting the row under the read makes the merge event's write throw.
      if (failWrite) ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run("m1");
      return prView(merged ? "MERGED" : "OPEN");
    });
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
    };
    const store = createRetentionStore();
    // Two quiet reads back the PR off to two minutes.
    await pollRetention(deps, store);
    clock.now += MINUTE;
    await pollRetention(deps, store);
    // A person looks before that: the PR reads merged, and the write fails.
    clock.now += 70_000;
    merged = true;
    failWrite = true;
    await pollRetention(deps, store, { present: true });
    expect(net.calls).toHaveLength(3);
    failWrite = false;
    insert();
    // Not due for another fifty seconds, but the merge is owed: read again.
    clock.now += 1000;
    await pollRetention(deps, store);
    expect(net.calls).toHaveLength(4);
    expect(
      listTicketEvents(ctx.db, "m1").filter((event) => event.payload.kind === "pr_merged"),
    ).toHaveLength(1);
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

    expect((await pollRetention(deps, store)).trimChecks).toBe(1);
    const walked = trim.git.length;
    expect(walked).toBeGreaterThan(0);
    clock.now += MINUTE;
    expect((await pollRetention(deps, store)).trimChecks).toBe(0);

    // An edit retention does not read is not a new question.
    updateTicketFields(ctx.db, id, { title: "renamed" }, clock.now);
    expect((await pollRetention(deps, store)).trimChecks).toBe(0);
    // A re-pointed worktree is.
    const moved = join(root, "moved");
    mkdirSync(moved);
    updateTicketFields(ctx.db, id, { worktreePath: moved }, clock.now);
    expect((await pollRetention(deps, store)).trimChecks).toBe(1);

    clock.now += CONFIG.trimRecheckMs - 1;
    expect((await pollRetention(deps, store)).trimChecks).toBe(0);
    clock.now += 1;
    expect((await pollRetention(deps, store)).trimChecks).toBe(1);
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

    expect((await pollRetention(deps, store)).trimChecks).toBe(1);
    busy = false;
    clock.now += QUIET_MAX - 1;
    expect((await pollRetention(deps, store)).trimChecks).toBe(0);
    clock.now += 1;
    expect((await pollRetention(deps, store)).trimChecks).toBe(1);
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
    expect(net.calls.length - firstHourReads).toBe(16 * (HOUR / QUIET_MAX));
    expect(trim.git.length - firstHourGit).toBe(0);
    expect(cycles() - firstHourCycles).toBe(HOUR / QUIET_MAX);
  });
});

/** A ticket change source a test fires by hand. */
function changeSource() {
  const listeners = new Set<(ticketId: string) => void>();
  return {
    subscribe: (listener: (ticketId: string) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire: (ticketId: string) => {
      for (const listener of listeners) listener(ticketId);
    },
    get size() {
      return listeners.size;
    },
  };
}

const noop = (): void => {};

describe("RetentionWatcher — ticket changes drive the reads", () => {
  it("reads the ticket a change names within the debounce, whatever its backoff", async () => {
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

    // A signal leaves the row as it was; the change still names the ticket.
    changes.fire(moved);
    changes.fire(moved);
    await runFor(watcher, DEBOUNCE);
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
    let fireChange: (ticketId: string) => void = noop;
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
    fireChange(id);
    release!();
    await watcher.settled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await watcher.settled();
    expect(calls).toHaveLength(2);
    watcher.stop();
  });

  it("ignores a change once stopped", async () => {
    fakeClock();
    seed({ status: "backlog" });
    const net = quietNet();
    let fire: (ticketId: string) => void = noop;
    const watcher = new RetentionWatcher(
      { db: ctx.db, net: net.run, now: () => Date.now(), notify: () => {} },
      CONFIG,
      (listener) => {
        fire = listener;
        return () => {};
      },
    );
    watcher.start();
    fire("t1");
    watcher.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(net.calls).toHaveLength(0);
  });
});

describe("RetentionWatcher — load accounting", () => {
  it("writes each cycle at debug and an hourly summary of reads, trim checks and cycle time", async () => {
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
          trimChecks: 1,
        }),
      );
    } finally {
      log.restore();
    }
  });
});

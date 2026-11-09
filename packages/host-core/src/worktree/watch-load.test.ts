/**
 * What the retention watch costs the host thread and the windows (VC-1077):
 * every change it broadcasts is scoped to the ticket it moved, a repository
 * with no git remote is not asked for pull requests once per branch per
 * cycle, a person switching back to the app does not start a cycle per
 * switch, and the per-ticket reads a cycle repeats are answered from memory
 * only while the row they answer for is unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { recordTicketEvent } from "../db/events-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket, updateTicketFields, updateTicketPositionStatus } from "../db/tickets-repo";
import { captureHostLog } from "../testing/log";
import { netFailure, scriptedNet } from "./scripted-net";
import {
  createRetentionStore,
  pollRetention,
  retentionConfigFromEnv,
  RetentionWatcher,
  type RetentionChange,
  type RetentionPollPorts,
} from "./watch";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 100 * DAY;
const CONFIG = retentionConfigFromEnv({});

let ctx: TestDb;
let root: string;

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-watch-load-"));
  insertProject(ctx.db, testProject({ id: "p1", path: join(root, "p1") }));
  insertProject(ctx.db, testProject({ id: "p2", path: join(root, "p2") }));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function seed(
  projectId: string,
  id: string,
  opts: { status?: "backlog" | "needs_review" | "done"; prUrl?: string } = {},
): void {
  insertTicket(
    ctx.db,
    testTicket(projectId, {
      id,
      status: opts.status ?? "needs_review",
      worktreePath: join(root, `wt-${id}`),
      branch: `volli/${id}`,
    }),
  );
  if (opts.prUrl !== undefined) updateTicketFields(ctx.db, id, { prUrl: opts.prUrl }, 1);
}

function prView(state: string): { stdout: string } {
  return {
    stdout: JSON.stringify({
      state,
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
    }),
  };
}

describe("pollRetention — scoped change notices", () => {
  it("names each ticket it changed, with its project and the strongest kind, once per cycle", async () => {
    seed("p1", "read", { prUrl: "https://x/pull/1" });
    seed("p2", "found");
    seed("p2", "quiet", { status: "backlog" });
    const net = scriptedNet((_file, args) => {
      if (args[1] === "list") {
        return args[3] === "volli/found"
          ? { stdout: JSON.stringify([{ url: "https://x/pull/2", state: "OPEN", updatedAt: "z" }]) }
          : { stdout: "[]" };
      }
      return prView("OPEN");
    });
    const calls: (readonly RetentionChange[])[] = [];
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
      onChange: (changes) => calls.push(changes),
    };
    const store = createRetentionStore();

    const result = await pollRetention(deps, store);

    // One call per cycle, as before — now carrying what moved.
    expect(calls).toHaveLength(1);
    expect(result.changes).toEqual(calls[0]);
    expect(calls[0]!.toSorted((a, b) => a.ticketId.localeCompare(b.ticketId))).toEqual([
      // Stamped AND read: the row change outranks the observation.
      { ticketId: "found", projectId: "p2", kind: "ticket" },
      { ticketId: "read", projectId: "p1", kind: "retention" },
    ]);

    // A cycle that moves nothing announces nothing.
    clock.now += CONFIG.intervalMs;
    await pollRetention(deps, store);
    expect(calls).toHaveLength(1);
  });
});

describe("pollRetention — a repository with no git remote", () => {
  const noRemote = () =>
    scriptedNet((_file, args) => {
      if (args[1] === "list") {
        throw netFailure({
          stderr: "no git remotes found",
          code: 1,
        });
      }
      return prView("OPEN");
    });

  it("pauses the project's discovery after one failure, logging it once", async () => {
    seed("p1", "a");
    seed("p1", "b");
    seed("p1", "c");
    seed("p2", "elsewhere");
    const net = noRemote();
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
    };
    const store = createRetentionStore();
    const log = captureHostLog();
    try {
      await pollRetention(deps, store);
      // One ask for p1 — the rest of its branches wait — and p2 asks for itself.
      expect(net.calls.map((call) => call.cwd).toSorted()).toEqual([
        join(root, "p1"),
        join(root, "p2"),
      ]);

      // Present cycles all through the pause ask nothing more.
      for (let minute = 2; minute < 60; minute += 2) {
        clock.now = T0 + minute * MINUTE;
        await pollRetention(deps, store, { present: true });
      }
      expect(net.calls).toHaveLength(2);

      const records = log.of("worktree-watch");
      expect(records.filter((record) => record.msg === "pull request discovery failed")).toEqual(
        [],
      );
      expect(
        records.filter((record) => record.msg.startsWith("pull request discovery paused")),
      ).toHaveLength(2);

      // Once the pause lapses, the project is asked again.
      clock.now = T0 + HOUR + MINUTE;
      await pollRetention(deps, store);
      expect(net.calls.length).toBeGreaterThan(2);
    } finally {
      log.restore();
    }
  });

  it("asks again at once for a ticket a committed change names", async () => {
    seed("p1", "a");
    seed("p1", "b");
    const net = noRemote();
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
    };
    const store = createRetentionStore();
    const log = captureHostLog();
    try {
      await pollRetention(deps, store);
      expect(net.calls).toHaveLength(1);
      clock.now += 5 * MINUTE;
      await pollRetention(deps, store, { woken: new Set(["b"]) });
      expect(net.calls).toHaveLength(2);
    } finally {
      log.restore();
    }
  });

  it("resumes the project's discovery as soon as an ask succeeds", async () => {
    seed("p1", "a");
    seed("p1", "b");
    let remote = false;
    const net = scriptedNet((_file, args) => {
      if (args[1] === "list") {
        if (!remote) throw netFailure({ stderr: "no git remotes found", code: 1 });
        return { stdout: "[]" };
      }
      return prView("OPEN");
    });
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
    };
    const store = createRetentionStore();
    const log = captureHostLog();
    try {
      await pollRetention(deps, store);
      remote = true;
      clock.now += 5 * MINUTE;
      await pollRetention(deps, store, { woken: new Set(["a"]) });
      expect(store.remoteless.has("p1")).toBe(false);
      clock.now += 5 * MINUTE;
      const before = net.calls.length;
      await pollRetention(deps, store, { present: true });
      // Both branches are asked again, the one the pause held included.
      expect(net.calls.length).toBe(before + 2);
    } finally {
      log.restore();
    }
  });
});

describe("pollRetention — reads remembered per row", () => {
  it("dates a Done ticket's entry again once the ticket moves", async () => {
    // Done well past the discovery grace: no PR is looked for.
    seed("p1", "d", { status: "done" });
    recordTicketEvent(
      ctx.db,
      "d",
      { kind: "status_changed", from: "needs_review", to: "done" },
      T0 - 30 * DAY,
    );
    const net = scriptedNet(() => ({ stdout: "[]" }));
    const clock = { now: T0 };
    const deps: RetentionPollPorts = {
      db: ctx.db,
      net: net.run,
      now: () => clock.now,
      notify: () => {},
    };
    const store = createRetentionStore();
    await pollRetention(deps, store);
    clock.now += CONFIG.intervalMs;
    await pollRetention(deps, store);
    expect(net.calls).toHaveLength(0);

    // Bounced out of Done and back: the fresh entry is inside the grace again.
    clock.now += CONFIG.intervalMs;
    updateTicketPositionStatus(ctx.db, "d", "needs_review", 0, clock.now);
    recordTicketEvent(
      ctx.db,
      "d",
      { kind: "status_changed", from: "done", to: "needs_review" },
      clock.now,
    );
    updateTicketPositionStatus(ctx.db, "d", "done", 0, clock.now + 1);
    recordTicketEvent(
      ctx.db,
      "d",
      { kind: "status_changed", from: "needs_review", to: "done" },
      clock.now + 1,
    );
    clock.now += 2;
    await pollRetention(deps, store);
    expect(net.calls).toHaveLength(1);
  });
});

describe("RetentionWatcher — presence-triggered cycles", () => {
  it("runs at most one focus cycle per base interval", async () => {
    seed("p1", "a", { prUrl: "https://x/pull/1" });
    const net = scriptedNet(() => prView("OPEN"));
    const clock = { now: T0 };
    const log = captureHostLog();
    const cycles = (): number =>
      log.of("worktree-watch").filter((record) => record.msg === "retention cycle").length;
    const watcher = new RetentionWatcher(
      { db: ctx.db, net: net.run, now: () => clock.now, notify: () => {} },
      CONFIG,
    );
    try {
      watcher.triggerNow();
      await watcher.settled();
      expect(cycles()).toBe(1);

      // Every switch back to the app inside the interval is dropped.
      for (let i = 1; i <= 5; i += 1) {
        clock.now = T0 + i * 10_000;
        watcher.triggerNow();
        await watcher.settled();
      }
      expect(cycles()).toBe(1);

      clock.now = T0 + CONFIG.intervalMs;
      watcher.triggerNow();
      await watcher.settled();
      expect(cycles()).toBe(2);
    } finally {
      watcher.stop();
      log.restore();
    }
  });

  it("honours a configured window, and a clock stepped backwards does not hold it shut", async () => {
    seed("p1", "a", { prUrl: "https://x/pull/1" });
    const net = scriptedNet(() => prView("OPEN"));
    const clock = { now: T0 };
    const log = captureHostLog();
    const cycles = (): number =>
      log.of("worktree-watch").filter((record) => record.msg === "retention cycle").length;
    const watcher = new RetentionWatcher(
      { db: ctx.db, net: net.run, now: () => clock.now, notify: () => {} },
      { ...CONFIG, presentMinIntervalMs: 5_000 },
    );
    try {
      watcher.triggerNow();
      await watcher.settled();
      clock.now += 5_000;
      watcher.triggerNow();
      await watcher.settled();
      expect(cycles()).toBe(2);
      clock.now -= HOUR;
      watcher.triggerNow();
      await watcher.settled();
      expect(cycles()).toBe(3);
    } finally {
      watcher.stop();
      log.restore();
    }
  });
});

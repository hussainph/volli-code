/** The shared move's committed projection and effects, independent of either door. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import type { Ticket, TicketEventActor, TicketStatus } from "@volli/shared";
import { listTicketEvents } from "./db/events-repo";
import { insertProject } from "./db/projects-repo";
import { openRawDb, openTestDb, testProject, type TestDb } from "./db/test-helpers";
import { getTicketRow, listTicketsByProject, updateTicketFields } from "./db/tickets-repo";
import { createSqliteSessionLedger } from "./session-control/sqlite-ledger";
import { archiveTicketCommand, createTicketCommand } from "./ticket-commands";
import { createDetachedWorkTracker } from "./detached-work";
import { executeTicketMove, type TicketMovePorts } from "./ticket-move";
import { subscribeTicketWake, type TicketWake } from "./ticket-wake";
import * as worktree from "./worktree";
import { runGitCapturing, runGitCapturingAsync } from "./worktree/git";
import { getWorktreeSnapshots, resetWorktreeSnapshotsForTest } from "./worktree/snapshot";
import type { TrimFinishOutcome } from "./worktree/retention";
import type { WorktreeStatusRead } from "./worktree/read";

const PROJECT = "project";
const USER: TicketEventActor = { kind: "user" };
const SESSION: TicketEventActor = { kind: "session", sessionId: "session", ticketId: "actor" };
const ACTORS = [USER, SESSION];
let ctx: TestDb;
let ports: TicketMovePorts;
let unsubscribe: () => void;
let wakes: TicketWake[];
let tempDirs: string[];

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: PROJECT, ticketPrefix: "VC" }));
  ports = {
    worktree: {
      db: ctx.db,
      git: runGitCapturing,
      gitAsync: runGitCapturingAsync,
      blobsRoot: "unused",
    },
    now: () => 100,
    busySites: async () => [],
    onMutation: vi.fn(),
    onDeliberateMove: vi.fn(),
    interruptTicketSessions: vi.fn(() => []),
    notify: vi.fn(),
  };
  wakes = [];
  unsubscribe = subscribeTicketWake((wake) => wakes.push(wake));
  tempDirs = [];
  resetWorktreeSnapshotsForTest();
});

afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
  resetWorktreeSnapshotsForTest();
  ctx.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function ticket(id: string, status: TicketStatus = "todo", projectId = PROJECT): Ticket {
  return createTicketCommand(ctx.db, { id, projectId, title: id, status }, { now: 1, actor: USER });
}

function context(actor: TicketEventActor = USER, now = 10) {
  return { actor, now };
}

function statusEvents(ticketId: string) {
  return listTicketEvents(ctx.db, ticketId).filter(
    (event) => event.payload.kind === "status_changed",
  );
}

function column(tickets: Ticket[], status: TicketStatus): string[] {
  const ordered = tickets
    .filter((item) => item.status === status)
    .toSorted((a, b) => a.order - b.order);
  expect(ordered.map((item) => item.order)).toEqual(ordered.map((_, index) => index));
  return ordered.map((item) => item.id);
}

/** Includes persistence metadata, not only the renderer's visible fields. */
function rows() {
  return ctx.db.prepare("SELECT * FROM tickets ORDER BY id").all();
}

function expectNoEffects() {
  expect(wakes).toEqual([]);
  expect(ports.onMutation).not.toHaveBeenCalled();
  expect(ports.onDeliberateMove).not.toHaveBeenCalled();
  expect(ports.interruptTicketSessions).not.toHaveBeenCalled();
  expect(ports.notify).not.toHaveBeenCalled();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("commits Done but never starts a destructive trim without activity evidence", async () => {
  ticket("target");
  delete ports.busySites;
  const trim = vi.spyOn(worktree, "trimFinishedWorktree");
  expect(
    column(
      await executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "done" },
        context(),
      ),
      "done",
    ),
  ).toEqual(["target"]);
  expect(trim).not.toHaveBeenCalled();
});

describe.each(ACTORS)("executeTicketMove with $kind actor", (actor) => {
  it("starts Done trim immediately, detaches it from the reply, and ignores a duplicate while it is pending", async () => {
    ticket("target");
    const pending = deferred<TrimFinishOutcome>();
    const trim = vi.spyOn(worktree, "trimFinishedWorktree").mockImplementation((deps, id) => {
      // Invocation must be immediate AND after both the board and its fact commit.
      expect(ctx.db.inTransaction).toBe(false);
      expect(deps).toBe(ports);
      expect(getTicketRow(ctx.db, id)?.status).toBe("done");
      expect(statusEvents(id)).toHaveLength(1);
      return pending.promise;
    });
    const reply = executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "done" },
      context(actor),
    );
    expect(reply).not.toBeInstanceOf(Promise);
    expect(trim).toHaveBeenCalledExactlyOnceWith(ports, "target");
    expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
    expect(statusEvents("target")).toEqual([
      expect.objectContaining({
        actor: actor.kind,
        actorContext: actor.kind === "session" ? { sessionId: "session", ticketId: "actor" } : null,
        payload: { kind: "status_changed", from: "todo", to: "done" },
        createdAt: 10,
      }),
    ]);
    expect(wakes.map((wake) => wake.event)).toEqual(statusEvents("target"));
    const before = rows();
    const effects = vi.mocked(ports.onMutation!).mock.calls.length;
    const arrivals = vi.mocked(ports.onDeliberateMove!).mock.calls.length;
    const duplicate = executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "done" },
      context(actor, 11),
    );
    expect(duplicate).toEqual(reply);
    expect(rows()).toEqual(before);
    expect(trim).toHaveBeenCalledTimes(1);
    expect(wakes).toHaveLength(1);
    expect(ports.onMutation).toHaveBeenCalledTimes(effects);
    expect(ports.onDeliberateMove).toHaveBeenCalledTimes(arrivals);
    pending.resolve({ kind: "skipped", reason: "nothing to trim" });
    await pending.promise;
    expect(ports.onMutation).toHaveBeenCalledTimes(1);
  });

  it("treats same-column column-only intent as a strict no-op, but supports indexed reorder without trimming", async () => {
    ticket("a", "done");
    ticket("b", "done");
    const trim = vi.spyOn(worktree, "trimFinishedWorktree");
    const before = rows();
    const events = listTicketEvents(ctx.db, "a");
    const noOp = executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "a", toStatus: "done", choice: { kind: "move-only" } },
      context(actor),
    );
    expect(noOp).toEqual(listTicketsByProject(ctx.db, PROJECT));
    expect(rows()).toEqual(before);
    expect(listTicketEvents(ctx.db, "a")).toEqual(events);
    expectNoEffects();

    const reordered = await executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "a", toStatus: "done", toIndex: 1 },
      context(actor),
    );
    expect(column(reordered, "done")).toEqual(["b", "a"]);
    expect(reordered).toEqual(listTicketsByProject(ctx.db, PROJECT));
    expect(getTicketRow(ctx.db, "a")?.updated_at).toBe(10);
    expect(listTicketEvents(ctx.db, "a")).toEqual(events);
    expect(wakes).toEqual([]);
    expect(trim).not.toHaveBeenCalled();
    expect(ports.onDeliberateMove).not.toHaveBeenCalled();
    expect(ports.interruptTicketSessions).not.toHaveBeenCalled();
    expect(ports.notify).not.toHaveBeenCalled();
    expect(ports.onMutation).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      ticketId: "a",
      kind: "ticket",
    });
  });

  it("appends a column-only transition after the existing destination cards", async () => {
    ticket("a", "doing");
    ticket("b", "doing");
    ticket("target");
    const reply = await executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "doing" },
      context(actor),
    );
    expect(column(reply, "doing")).toEqual(["a", "b", "target"]);
    expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
    expect(ports.onDeliberateMove).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      ticketId: "target",
      from: "todo",
      to: "doing",
    });
    expect(statusEvents("target")).toHaveLength(1);
  });

  it.each(["throw", "reject"] as const)(
    "keeps the committed projection when arrival throws and interrupt %s fails",
    async (mode) => {
      ticket("target", "doing");
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      ports.onDeliberateMove = vi.fn(() => {
        throw new Error("arrival failed");
      });
      ports.interruptTicketSessions = vi.fn(() => {
        expect(ctx.db.inTransaction).toBe(false);
        expect(getTicketRow(ctx.db, "target")?.status).toBe("todo");
        if (mode === "throw") throw new Error("interrupt failed");
        return Promise.reject(new Error("interrupt failed"));
      });
      const reply = await executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "todo" },
        context(actor),
      );
      expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
      expect(reply[0]?.status).toBe("todo");
      expect(statusEvents("target")).toHaveLength(1);
      expect(wakes.map((wake) => wake.event)).toEqual(statusEvents("target"));
      expect(ports.onMutation).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT,
        ticketId: "target",
        kind: "ticket",
      });
      expect(log).toHaveBeenCalledWith(
        "[ticket-move] failed to record armed-column arrival after committed move",
        { error: expect.objectContaining({ name: "Error", message: "arrival failed" }) },
      );
      expect(log).toHaveBeenCalledWith(
        "[ticket-move] failed to interrupt ticket sessions after committed move",
        { error: expect.objectContaining({ name: "Error", message: "interrupt failed" }) },
      );
      expect(listTicketEvents(ctx.db, "target").map((event) => event.payload.kind)).toEqual([
        "created",
        "status_changed",
      ]);
    },
  );
});

describe("group commit and post-commit wakes", () => {
  it("commits an indexed group atomically, deduplicates effects, and trims only real Done transitions", async () => {
    ticket("a", "todo");
    ticket("b", "doing");
    ticket("already", "done");
    ticket("tail", "done");
    const trim = vi
      .spyOn(worktree, "trimFinishedWorktree")
      .mockResolvedValue({ kind: "skipped", reason: "no worktree" });
    const observer = openRawDb(ctx.dbPath);
    const checked: string[] = [];
    const stop = subscribeTicketWake((wake) => {
      expect(ctx.db.inTransaction).toBe(false);
      // A second connection cannot see uncommitted rows on the writer's handle.
      expect(
        observer.prepare("SELECT id, status, position FROM tickets ORDER BY id").all(),
      ).toEqual([
        { id: "a", status: "done", position: 0 },
        { id: "already", status: "done", position: 2 },
        { id: "b", status: "done", position: 1 },
        { id: "tail", status: "done", position: 3 },
      ]);
      expect(
        observer
          .prepare("SELECT count(*) AS n FROM ticket_events WHERE kind = 'status_changed'")
          .get(),
      ).toEqual({ n: 2 });
      checked.push(wake.event.ticketId);
    });
    try {
      const reply = await executeTicketMove(
        ports,
        {
          projectId: PROJECT,
          ticketIds: ["b", "already", "a", "b"],
          toStatus: "done",
          toIndex: 0,
          choice: { kind: "automation", automationId: "armed" },
        },
        context(SESSION),
      );
      expect(column(reply, "done")).toEqual(["a", "b", "already", "tail"]);
      expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
      expect(checked.toSorted()).toEqual(["a", "b"]);
      expect(new Set(wakes.map((wake) => wake.cursor)).size).toBe(2);
      expect(wakes.map((wake) => wake.projectId)).toEqual([PROJECT, PROJECT]);
      for (const wake of wakes) expect(statusEvents(wake.event.ticketId)).toEqual([wake.event]);
      expect(trim.mock.calls.map((call) => call[1]).toSorted()).toEqual(["a", "b"]);
      expect(ports.onDeliberateMove).toHaveBeenCalledTimes(2);
      expect(ports.onDeliberateMove).toHaveBeenCalledWith({
        projectId: PROJECT,
        ticketId: "a",
        from: "todo",
        to: "done",
        choice: { kind: "automation", automationId: "armed" },
      });
      expect(ports.onDeliberateMove).toHaveBeenCalledWith({
        projectId: PROJECT,
        ticketId: "b",
        from: "doing",
        to: "done",
        choice: { kind: "automation", automationId: "armed" },
      });
      expect(ports.onMutation).toHaveBeenCalledTimes(3);
      expect(ports.interruptTicketSessions).toHaveBeenCalledExactlyOnceWith("b");
      expect(statusEvents("already")).toEqual([]);
    } finally {
      stop();
      observer.close();
    }
  });

  it("rolls back all rows, facts, wakes and effects on a mid-write database failure", () => {
    ticket("a");
    ticket("b");
    const trim = vi.spyOn(worktree, "trimFinishedWorktree");
    const before = rows();
    ctx.db.exec(
      "CREATE TRIGGER fail_second_move BEFORE UPDATE OF status ON tickets WHEN NEW.id = 'b' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'fixture move failure'); END",
    );
    expect(() =>
      executeTicketMove(
        ports,
        { projectId: PROJECT, ticketIds: ["a", "b"], toStatus: "done", toIndex: 0 },
        context(),
      ),
    ).toThrow("fixture move failure");
    expect(rows()).toEqual(before);
    expect(statusEvents("a")).toEqual([]);
    expect(statusEvents("b")).toEqual([]);
    expectNoEffects();
    expect(trim).not.toHaveBeenCalled();
  });

  it.each(["missing", "archived", "wrong-project"])(
    "rejects a group containing a %s ticket before any effect",
    (invalid) => {
      ticket("a");
      let invalidId = "missing";
      if (invalid === "archived") {
        ticket("bad");
        archiveTicketCommand(ctx.db, "bad", context());
        invalidId = "bad";
      } else if (invalid === "wrong-project") {
        insertProject(ctx.db, testProject({ id: "other", ticketPrefix: "OT" }));
        ticket("bad", "todo", "other");
        invalidId = "bad";
      }
      const before = rows();
      const trim = vi.spyOn(worktree, "trimFinishedWorktree");
      expect(() =>
        executeTicketMove(
          ports,
          { projectId: PROJECT, ticketIds: ["a", invalidId], toStatus: "done", toIndex: 0 },
          context(),
        ),
      ).toThrow();
      expect(rows()).toEqual(before);
      expect(statusEvents("a")).toEqual([]);
      expectNoEffects();
      expect(trim).not.toHaveBeenCalled();
    },
  );

  it("starts every interrupt before awaiting any, tolerates rejection, and retains each command's committed reply", async () => {
    ticket("a", "doing");
    ticket("b", "needs_review");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    ports.interruptTicketSessions = vi.fn((id) => {
      expect(ctx.db.inTransaction).toBe(false);
      expect(listTicketsByProject(ctx.db, PROJECT).every((item) => item.status === "todo")).toBe(
        true,
      );
      return id === "a" ? first.promise : second.promise;
    });
    const pending = executeTicketMove(
      ports,
      { projectId: PROJECT, ticketIds: ["a", "b"], toStatus: "todo", toIndex: 0 },
      context(),
    );
    expect(pending).toBeInstanceOf(Promise);
    expect(vi.mocked(ports.interruptTicketSessions).mock.calls).toEqual([["a"], ["b"]]);
    const committed = listTicketsByProject(ctx.db, PROJECT);
    const before = rows();
    expect(
      executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "a", toStatus: "todo" },
        context(SESSION, 11),
      ),
    ).toEqual(committed);
    expect(rows()).toEqual(before);
    // A later deliberate move wins in the live projection, not in the earlier reply.
    const later = await executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "a", toStatus: "doing" },
      context(SESSION, 12),
    );
    first.resolve(["session-a"]);
    second.reject(new Error("second interrupt failed"));
    await expect(pending).resolves.toEqual(committed);
    // The command keeps board order; the repo orders equal positions across columns by id.
    expect(
      listTicketsByProject(ctx.db, PROJECT).toSorted((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(later.toSorted((a, b) => a.id.localeCompare(b.id)));
    expect(statusEvents("a").map((event) => event.payload)).toEqual([
      { kind: "status_changed", from: "doing", to: "todo" },
      { kind: "status_changed", from: "todo", to: "doing" },
    ]);
    expect(statusEvents("b")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "[ticket-move] failed to interrupt ticket sessions after committed move",
      { error: expect.objectContaining({ name: "Error", message: "second interrupt failed" }) },
    );
  });

  it("leaves rejected interrupt receipts in the Session ledger, consistent with a successful committed board projection", async () => {
    ticket("target", "doing");
    const provenance = {
      source: { kind: "system" as const, id: "test", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    let next = 0;
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(ctx.db),
      clock: { now: () => 20 },
      ids: { next: (kind) => `${kind}-${++next}` },
    });
    const created = await engine.createSession({
      commandId: "create",
      projectId: PROJECT,
      ticketId: "target",
      role: "ticket",
      parentSessionId: null,
      title: null,
      provenance,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ports.interruptTicketSessions = vi.fn(async () => {
      expect(getTicketRow(ctx.db, "target")?.status).toBe("todo");
      const result = await engine.submit({
        commandId: "interrupt",
        sessionId: created.session.id,
        intent: { kind: "executor.interrupt", attachmentId: "already-gone" },
        provenance,
      });
      expect(result.receipt?.status).toBe("rejected");
      throw new Error("attachment unavailable");
    });
    const reply = await executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "todo" },
      context(SESSION),
    );
    expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
    const projection = await engine.getSession({ sessionId: created.session.id });
    expect(projection?.commands.filter((command) => command.id === "interrupt")).toHaveLength(1);
    expect(projection?.receipts.filter((receipt) => receipt.commandId === "interrupt")).toEqual([
      expect.objectContaining({ status: "rejected" }),
    ]);
    expect(listTicketEvents(ctx.db, "target").map((event) => event.payload.kind)).toEqual([
      "created",
      "status_changed",
    ]);
    expect(wakes.map((wake) => wake.event)).toEqual(statusEvents("target"));
    expect(log).toHaveBeenCalledWith(
      "[ticket-move] failed to interrupt ticket sessions after committed move",
      { error: expect.objectContaining({ name: "Error", message: "attachment unavailable" }) },
    );
  });
});

describe("actor-based Doing notification policy", () => {
  const policies: Array<{ actor: TicketEventActor; body: string | null }> = [
    { actor: USER, body: null },
    { actor: SESSION, body: "Moved via VC-1's session" },
    {
      actor: { kind: "session", sessionId: "project-session", ticketId: null },
      body: "Moved via a session",
    },
    {
      actor: { kind: "session", sessionId: "missing-session", ticketId: "missing" },
      body: "Moved via a session",
    },
    { actor: { kind: "automation" }, body: "Moved by automation" },
    { actor: { kind: "unauthenticated" }, body: "Moved by an unauthenticated caller" },
  ];
  it.each(policies)(
    "notifies a real Doing arrival for $actor.kind, not its no-op or reorder",
    async ({ actor, body }) => {
      ticket("actor");
      const target = ticket("target");
      ticket("other", "doing");
      await executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "doing" },
        context(actor),
      );
      const expected = body === null ? 0 : 1;
      expect(ports.notify).toHaveBeenCalledTimes(expected);
      if (body !== null)
        expect(ports.notify).toHaveBeenCalledExactlyOnceWith({
          producer: "ticket-moved-to-doing",
          title: `VC-${target.ticketNumber} → Doing`,
          body,
          target: { kind: "ticket", projectId: PROJECT, ticketId: "target" },
        });
      await executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "doing" },
        context(actor, 11),
      );
      await executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "doing", toIndex: 0 },
        context(actor, 12),
      );
      await executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "needs_review" },
        context(actor, 13),
      );
      expect(ports.notify).toHaveBeenCalledTimes(expected);
      expect(statusEvents("target")).toHaveLength(2);
    },
  );
});

/** Runs every queued continuation; one turn of the event loop, not a timer. */
function settleQueue(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("shutdown drain of the detached Done trim (VC-627)", () => {
  it("holds a drain while the trim is pending, without holding the reply", async () => {
    ticket("target");
    const tracker = createDetachedWorkTracker({ reportFailure: vi.fn() });
    ports.detachedWork = tracker;
    const events: string[] = [];
    vi.mocked(ports.onMutation!).mockImplementation((change) => {
      events.push(`published ${change.kind}`);
    });
    const pending = deferred<TrimFinishOutcome>();
    const trim = vi.spyOn(worktree, "trimFinishedWorktree").mockReturnValue(pending.promise);
    const reply = executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "done" },
      context(),
    );
    expect(reply).not.toBeInstanceOf(Promise);
    expect(trim).toHaveBeenCalledExactlyOnceWith(ports, "target");
    expect(tracker.pending).toBe(1);
    const drained = tracker.drain().then(() => void events.push("drained"));
    await settleQueue();
    expect(events).toEqual(["published ticket"]);
    pending.resolve({
      kind: "trimmed",
      report: { worktreePath: "/mock", removed: [], kept: [], totalBytes: 0, dryRun: false },
    });
    await drained;
    expect(events).toEqual(["published ticket", "published worktree", "drained"]);
    expect(tracker.pending).toBe(0);
  });

  it("drains through the real trim's event write, so the database can close after it", async () => {
    const root = seedGitWorktree();
    ticket("target");
    updateTicketFields(
      ctx.db,
      "target",
      { worktreePath: root, branch: "main", baseBranch: "main" },
      2,
    );
    const tracker = createDetachedWorkTracker({ reportFailure: vi.fn() });
    ports.detachedWork = tracker;
    const trimmedEvents = () =>
      listTicketEvents(ctx.db, "target").filter(
        (event) => event.payload.kind === "worktree_trimmed",
      );
    const events: string[] = [];
    vi.mocked(ports.onMutation!).mockImplementation((change) => {
      events.push(`published ${change.kind} (${trimmedEvents().length} trim events)`);
    });
    executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "done" },
      context(),
    );
    expect(trimmedEvents()).toEqual([]);
    await tracker.drain();
    events.push(`drained (${trimmedEvents().length} trim events)`);
    expect(events).toEqual([
      "published ticket (0 trim events)",
      "published worktree (1 trim events)",
      "drained (1 trim events)",
    ]);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    // The host closes the database once the drain resolves; nothing is left to write.
    expect(tracker.pending).toBe(0);
    ctx.db.close();
    expect(ctx.db.open).toBe(false);
  });

  it("drains through a failed trim's own log, and the tracker reports nothing extra", async () => {
    ticket("target");
    const reportFailure = vi.fn();
    const tracker = createDetachedWorkTracker({ reportFailure });
    ports.detachedWork = tracker;
    const events: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => {
      // The error's stack is where it was thrown, not part of what this asserts.
      events.push(
        line
          .map((part) =>
            JSON.stringify(part, (key, value: unknown) => (key === "stack" ? undefined : value)),
          )
          .join(" "),
      );
    });
    const pending = deferred<TrimFinishOutcome>();
    vi.spyOn(worktree, "trimFinishedWorktree").mockReturnValue(pending.promise);
    executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "done" },
      context(),
    );
    const drained = tracker.drain().then(() => void events.push("drained"));
    await settleQueue();
    expect(events).toEqual([]);
    pending.reject(new Error("trim failed"));
    await drained;
    expect(events).toEqual([
      '"[ticket-move] could not trim the ticket\'s worktree" ' +
        '{"ticketId":"target","error":{"name":"Error","message":"trim failed"}}',
      "drained",
    ]);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("enrols nothing when no trim may start", async () => {
    ticket("target");
    delete ports.busySites;
    const tracker = createDetachedWorkTracker();
    ports.detachedWork = tracker;
    await executeTicketMove(
      ports,
      { projectId: PROJECT, ticketId: "target", toStatus: "done" },
      context(),
    );
    expect(tracker.pending).toBe(0);
  });
});

function seedGitWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "volli-ticket-move-"));
  tempDirs.push(root);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Volli Test",
        GIT_AUTHOR_EMAIL: "test@volli.local",
        GIT_COMMITTER_NAME: "Volli Test",
        GIT_COMMITTER_EMAIL: "test@volli.local",
      },
    });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
  writeFileSync(join(root, "node_modules", "fixture", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, ".env"), "FIXTURE=preserved\n");
  return root;
}

describe("background Done trim", () => {
  it.each(ACTORS)(
    "uses real git/trim for $kind, preserves .env and invalidates/publishes only after success",
    async (actor) => {
      const root = seedGitWorktree();
      ticket("target");
      updateTicketFields(
        ctx.db,
        "target",
        { worktreePath: root, branch: "main", baseBranch: "main" },
        2,
      );
      const snapshots = getWorktreeSnapshots();
      snapshots.noteCovered("target");
      const status: WorktreeStatusRead = {
        kind: "ok",
        displayId: "VC-1",
        worktreePath: root,
        branch: "main",
        baseBranch: "main",
        status: {
          uncommitted: false,
          sequencerActive: false,
          aheadOfBase: 0,
          behindBase: 0,
          unpushed: null,
        },
      };
      const load = vi.fn(async () => status);
      await snapshots.readStatus("target", load);
      await snapshots.readStatus("target", load);
      expect(load).toHaveBeenCalledTimes(1);
      const trim = vi.spyOn(worktree, "trimFinishedWorktree"); // Call through: no mocked filesystem or git.
      const reply = executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "done" },
        context(actor),
      );
      expect(reply).not.toBeInstanceOf(Promise);
      expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
      expect(trim).toHaveBeenCalledExactlyOnceWith(ports, "target");
      expect(ports.onMutation).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT,
        ticketId: "target",
        kind: "ticket",
      });
      expect(((await trim.mock.results[0]!.value) as TrimFinishOutcome).kind).toBe("trimmed");
      expect(existsSync(join(root, "node_modules"))).toBe(false);
      expect(readFileSync(join(root, ".env"), "utf8")).toBe("FIXTURE=preserved\n");
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{}\n");
      expect(existsSync(join(root, ".git"))).toBe(true);
      expect(getTicketRow(ctx.db, "target")?.worktree_path).toBe(root);
      expect(
        listTicketEvents(ctx.db, "target").filter(
          (event) => event.payload.kind === "worktree_trimmed",
        ),
      ).toEqual([
        expect.objectContaining({
          actor: "automation",
          payload: { kind: "worktree_trimmed", entries: 1, bytes: expect.any(Number), kept: 1 },
        }),
      ]);
      expect(ports.onMutation).toHaveBeenCalledTimes(2);
      expect(ports.onMutation).toHaveBeenLastCalledWith({
        projectId: PROJECT,
        ticketId: "target",
        kind: "worktree",
      });
      await snapshots.readStatus("target", load);
      expect(load).toHaveBeenCalledTimes(2);
      expect(wakes.map((wake) => wake.event)).toEqual(statusEvents("target"));
    },
  );

  it.each(["skipped", "rejected"] as const)(
    "keeps a %s trim from invalidating/publishing or failing the committed move",
    async (outcome) => {
      ticket("target");
      const failure = new Error("trim failed");
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const invalidate = vi.spyOn(getWorktreeSnapshots(), "invalidate");
      const pending = deferred<TrimFinishOutcome>();
      vi.spyOn(worktree, "trimFinishedWorktree").mockReturnValue(pending.promise);
      const reply = executeTicketMove(
        ports,
        { projectId: PROJECT, ticketId: "target", toStatus: "done" },
        context(SESSION),
      );
      expect(reply).not.toBeInstanceOf(Promise);
      expect(reply).toEqual(listTicketsByProject(ctx.db, PROJECT));
      if (outcome === "skipped") pending.resolve({ kind: "skipped", reason: "work in flight" });
      else pending.reject(failure);
      await pending.promise.catch(() => undefined);
      // The detached helper's catch follows its .then; drain that microtask too.
      await Promise.resolve();
      expect(invalidate).not.toHaveBeenCalled();
      expect(ports.onMutation).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT,
        ticketId: "target",
        kind: "ticket",
      });
      expect(listTicketEvents(ctx.db, "target").map((event) => event.payload.kind)).toEqual([
        "created",
        "status_changed",
      ]);
      expect(wakes.map((wake) => wake.event)).toEqual(statusEvents("target"));
      if (outcome === "rejected")
        expect(log).toHaveBeenCalledWith("[ticket-move] could not trim the ticket's worktree", {
          ticketId: "target",
          error: expect.objectContaining({ name: "Error", message: "trim failed" }),
        });
      else expect(log).not.toHaveBeenCalled();
    },
  );
});

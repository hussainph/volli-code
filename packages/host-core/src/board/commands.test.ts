/**
 * The Board module's commands (VC-565, T13), driven through the host's one
 * handler map as every door drives them: each `board.*` key is the whole
 * command — clock, attribution, transaction and receipt, wakes, feed rows
 * naming the `commandId`, and the `data-changed` announcement.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCommandIntentConflict,
  isFeedResnapshotRequired,
  isOperationUnavailable,
  HOST_HANDLER_KEYS,
  type BoardChange,
  type DataChangeScope,
  type HandlerCall,
  type LatestSessionSignal,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import { getComment } from "../db/comments-repo";
import { listTicketEvents } from "../db/events-repo";
import { listTicketLabels } from "../db/labels-repo";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { getTicket, getTicketRow, listTicketsByProject } from "../db/tickets-repo";
import { ADMITTED, admittedHandlers, type HandlerPolicy } from "../handlers/handler-map";
import {
  createHostHandlers,
  type HostHandlerOptions,
  type HostHandlers,
} from "../handlers/host-handlers";
import * as toolOutput from "../pi-tool-output";
import type { RuntimeAutomations } from "../session-runtime/automations";
import { archiveTicketCommand, createTicketCommand } from "../ticket-commands";
import { subscribeTicketWake, type TicketWake } from "../ticket-wake";
import * as worktreeModule from "../worktree";
import { runGitCapturing, runGitCapturingAsync } from "../worktree/git";
import { resetRepositoryTurnsForTest } from "../worktree/repository-turn";
import { resetWorktreeSnapshotsForTest } from "../worktree/snapshot";
import type { EnsureOutcome } from "../worktree";
import type { WorktreeResult } from "../worktree/types";
import { createBoardChangeFeed, type BoardChangeFeed, type BoardFeedBatch } from "./change-feed";
import { createBoardHandlers, ticketSummary } from "./commands";

const USER: HandlerCall = { actor: { kind: "user" } };
const WINDOW: HandlerCall = { actor: { kind: "user" }, origin: "desktop-window" };
const SESSION: HandlerCall = { actor: { kind: "session", sessionId: "s-1", ticketId: null } };
const PROJECT = "project";
const STILL_CREATING =
  "The ticket's worktree is still being created, so its worktree scoping can't change yet. Try again once it's ready.";

/** Admits everything: these cases are about what each command does, not who may call it. */
const OPEN: HandlerPolicy = { door: "test", admit: () => ADMITTED };

let ctx: TestDb;
let feed: BoardChangeFeed;
let batches: BoardFeedBatch[];
let publish: Mock<(topic: string, change: unknown) => void>;
let tempDirs: string[];
let wakes: TicketWake[];
let stopWakes: () => void;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: PROJECT, ticketPrefix: "VC" }));
  feed = createBoardChangeFeed();
  batches = [];
  feed.subscribe(PROJECT, null, (batch) => batches.push(batch));
  // A composition root's bus feeds its feed every `data-changed`: a board
  // command that stamped its own rows must not be stamped a second time.
  publish = vi.fn((topic: string, change: unknown) => {
    if (topic === "data-changed") feed.noteDataChanged(change as DataChangeScope);
  });
  tempDirs = [];
  wakes = [];
  stopWakes = subscribeTicketWake((wake) => wakes.push(wake));
  resetWorktreeSnapshotsForTest();
  resetRepositoryTurnsForTest();
});

afterEach(() => {
  stopWakes();
  vi.restoreAllMocks();
  resetWorktreeSnapshotsForTest();
  resetRepositoryTurnsForTest();
  ctx.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function handlers(options: Partial<HostHandlerOptions> = {}): HostHandlers {
  return admittedHandlers(
    createHostHandlers(
      {
        events: { publish },
        attention: {
          deliver: vi.fn(() => ({ delivered: true })),
          focusedSessionIds: () => new Set(),
        },
      } as never,
      {
        db: ctx.db,
        dataDir: "",
        runtime: null,
        sessions: null,
        modelAccess: null,
        experiments: null,
        automations: { kind: "degraded" } as RuntimeAutomations,
        busyWorktreeSites: async () => [],
        now: () => 50,
        worktree: {
          db: ctx.db,
          git: runGitCapturing,
          gitAsync: runGitCapturingAsync,
          blobsRoot: "",
        },
        boardFeed: feed,
        ...options,
      },
    ),
    OPEN,
  );
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-board-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function seed(
  id: string,
  status: TicketStatus = "todo",
  extra: { labels?: string[]; body?: string; usesWorktree?: boolean; projectId?: string } = {},
): Ticket {
  // Main-checkout scope unless a case says otherwise: switching it on is a materialization.
  return createTicketCommand(
    ctx.db,
    { id, projectId: extra.projectId ?? PROJECT, title: id, status, usesWorktree: false, ...extra },
    { now: 1, actor: { kind: "user" } },
  );
}

/** Every change the feed delivered, in order. */
const changes = (): BoardChange[] => batches.flatMap((batch) => batch.changes);

const published = (): DataChangeScope[] =>
  publish.mock.calls
    .filter(([topic]) => topic === "data-changed")
    .map(([, change]) => change as DataChangeScope);

/** Row counts across every table a board write touches. */
function counts(): Record<string, number> {
  return Object.fromEntries(
    [
      "projects",
      "tickets",
      "ticket_events",
      "ticket_comments",
      "labels",
      "ticket_labels",
      "board_command_receipts",
    ].map((table) => [
      table,
      (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );
}

async function thrown(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to throw");
}

/**
 * Asserts a repeat with the same `commandId` and intent answers the recorded
 * value as replayed, and writes, stamps and announces nothing more.
 */
async function expectReplay<Answer extends { receipt: unknown }>(
  first: Answer,
  repeat: () => Answer | Promise<Answer>,
): Promise<void> {
  const before = counts();
  const stamped = batches.length;
  const announced = publish.mock.calls.length;
  const woke = wakes.length;
  const again = await repeat();
  expect(again).toEqual({
    ...first,
    receipt: { ...(first.receipt as object), replayed: true },
  });
  expect(counts()).toEqual(before);
  expect(batches).toHaveLength(stamped);
  expect(publish).toHaveBeenCalledTimes(announced);
  expect(wakes).toHaveLength(woke);
}

type Ensured = WorktreeResult<EnsureOutcome>;
/** A materialization that landed: the board command reads its outcome, not its identity. */
const ENSURED = { ok: true, value: {} as EnsureOutcome } satisfies Ensured;

const receipt = (commandId: string) => ({ commandId, status: "completed", replayed: false });

/** The real repository a materialization runs git against (VC-98). */
function seedRepository(): string {
  const root = tempDir("repo");
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
  writeFileSync(join(root, "README.md"), "# repo\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  return root;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("an unopened database", () => {
  it("answers every board command unavailable", async () => {
    const map = handlers({ db: null });
    const keys = HOST_HANDLER_KEYS.filter(
      (key) => key.startsWith("board.") || key === "ticket.move",
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      const error = await thrown(() =>
        (map[key] as (input: unknown, call: HandlerCall, sink: unknown) => unknown)(
          { projectId: PROJECT, ticketId: "t", commentId: "c", labelId: "l", after: null },
          USER,
          { emit: vi.fn(), fail: vi.fn() },
        ),
      );
      expect(isOperationUnavailable(error)).toBe(true);
      expect((error as Error).message).toBe("The board is unavailable: the database did not open");
    }
  });
});

describe("reads", () => {
  it("answers a snapshot at the feed's cursor, and a roster without bodies", async () => {
    seed("t-1", "todo", { labels: ["bug"], body: "the body" });
    feed.stamp(PROJECT, [{ kind: "project", op: "upsert", id: PROJECT, projectId: PROJECT }]);
    const map = handlers();

    const snapshot = await map["board.snapshot"]({ projectId: PROJECT }, USER);
    expect(snapshot.project.id).toBe(PROJECT);
    expect(snapshot.tickets).toEqual(listTicketsByProject(ctx.db, PROJECT));
    expect(snapshot.tickets[0]!.body).toBe("the body");
    expect(snapshot.labels.map((label) => label.name)).toEqual(["bug"]);
    expect(snapshot.cursor).toBe(feed.cursor(PROJECT));
    expect(snapshot.cursor.endsWith(":1")).toBe(true);

    const roster = await map["board.roster"]({ projectId: PROJECT }, USER);
    expect(roster.tickets.map((ticket) => ticket.id)).toEqual(["t-1"]);
    expect("body" in roster.tickets[0]!).toBe(false);
    expect(roster.labels.map((label) => label.name)).toEqual(["bug"]);
    expect(roster.cursor).toBe(feed.cursor(PROJECT));

    expect(await map["board.ticketBody"]({ ticketId: "t-1" }, USER)).toEqual({ body: "the body" });
  });

  it("refuses an unknown project or ticket rather than answering empty", async () => {
    const map = handlers();
    await expect(async () => map["board.snapshot"]({ projectId: "nope" }, USER)).rejects.toThrow(
      "Unknown project",
    );
    await expect(async () => map["board.roster"]({ projectId: "nope" }, USER)).rejects.toThrow(
      "Unknown project",
    );
    await expect(async () => map["board.ticketBody"]({ ticketId: "nope" }, USER)).rejects.toThrow(
      "Unknown ticket",
    );
  });

  it("answers the archive, a ticket's history, the status entries and its comments", async () => {
    seed("live", "doing");
    seed("gone", "todo");
    archiveTicketCommand(ctx.db, "gone", { now: 5, actor: { kind: "user" } });
    const map = handlers();
    const archived = await map["board.archivedTickets"]({ projectId: PROJECT }, USER);
    expect(archived.map((ticket) => [ticket.id, ticket.archivedAt])).toEqual([["gone", 5]]);
    const events = await map["board.ticketEvents"]({ ticketId: "live" }, USER);
    expect(events.map((event) => event.payload.kind)).toEqual(["created"]);
    const entries = await map["board.statusEntries"]({ projectId: PROJECT }, USER);
    expect(entries).toContainEqual(expect.objectContaining({ ticketId: "live", status: "doing" }));
    await map["board.createComment"]({ ticketId: "live", body: "hello" }, USER);
    const comments = await map["board.comments"]({ ticketId: "live" }, USER);
    expect(comments.map((comment) => comment.body)).toEqual(["hello"]);
  });

  it("answers the latest signals through the host's ledger port, and unavailable without one", async () => {
    const signal: LatestSessionSignal = {
      ticketId: "t",
      sessionId: "s",
      signal: "done",
      reason: null,
      createdAt: 1,
    };
    const ticketSignals = vi.fn(async () => [signal] as const);
    expect(
      await handlers({ ticketSignals })["board.latestSignals"]({ projectId: PROJECT }, USER),
    ).toEqual([signal]);
    expect(ticketSignals).toHaveBeenCalledWith(PROJECT);
    for (const options of [{}, { ticketSignals: null }]) {
      const error = await thrown(() =>
        handlers(options)["board.latestSignals"]({ projectId: PROJECT }, USER),
      );
      expect(isOperationUnavailable(error)).toBe(true);
      expect((error as Error).message).toBe("Ticket signals are unavailable on this host");
    }
  });

  it("reports whether the project's folder is still where the row says", async () => {
    const present = tempDir("folder");
    insertProject(ctx.db, testProject({ id: "here", path: present, ticketPrefix: "HE" }));
    const missing = join(present, "moved-away");
    insertProject(ctx.db, testProject({ id: "away", path: missing, ticketPrefix: "AW" }));
    const map = handlers();
    expect(await map["board.projectFolder"]({ projectId: "here" }, USER)).toEqual({
      path: present,
      state: "present",
    });
    expect(await map["board.projectFolder"]({ projectId: "away" }, USER)).toEqual({
      path: missing,
      state: "missing",
    });
    await expect(map["board.projectFolder"]({ projectId: "nope" }, USER)).rejects.toThrow(
      "Unknown project",
    );
  });

  it("tells a board.changes subscriber to resnapshot when its feed ends under it", async () => {
    const fail = vi.fn();
    const stop = await handlers()["board.changes"]({ projectId: PROJECT, after: null }, USER, {
      emit: vi.fn(),
      fail,
    });
    feed.dispose(PROJECT);
    expect(fail).toHaveBeenCalledOnce();
    expect(isFeedResnapshotRequired(fail.mock.calls[0]![0])).toBe(true);
    stop();
  });

  it("follows the Workspace's feed through board.changes, live and resumed", async () => {
    const map = handlers();
    const emit = vi.fn();
    const sink = { emit, fail: vi.fn() };
    const cursor = feed.cursor(PROJECT);
    const unsubscribe = await map["board.changes"]({ projectId: PROJECT, after: null }, USER, sink);
    const change: BoardChange = { kind: "project", op: "upsert", id: PROJECT, projectId: PROJECT };
    feed.stamp(PROJECT, [change]);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      cursor: feed.cursor(PROJECT),
      changes: [change],
    });
    unsubscribe();
    feed.stamp(PROJECT, [change]);
    expect(emit).toHaveBeenCalledTimes(1);

    const resumed = vi.fn();
    await map["board.changes"]({ projectId: PROJECT, after: cursor }, USER, {
      emit: resumed,
      fail: vi.fn(),
    });
    expect(resumed).toHaveBeenCalledExactlyOnceWith({
      cursor: feed.cursor(PROJECT),
      changes: [change],
    });
  });
});

describe("project writes", () => {
  it("updates the base branch and setup command, stamping the row with its commandId", async () => {
    const map = handlers();
    const first = await map["board.updateProject"](
      { projectId: PROJECT, commandId: "c-up", baseBranch: "dev", setupCommand: "  pnpm i  " },
      USER,
    );
    expect(first.receipt).toEqual(receipt("c-up"));
    expect(first.project).toMatchObject({ id: PROJECT, baseBranch: "dev", setupCommand: "pnpm i" });
    expect(batches).toHaveLength(1);
    expect(changes()).toEqual([
      {
        kind: "project",
        op: "upsert",
        id: PROJECT,
        projectId: PROJECT,
        project: first.project,
        commandId: "c-up",
      },
    ]);
    expect(published()).toEqual([{ projectId: PROJECT }]);

    await expectReplay(first, () =>
      map["board.updateProject"](
        { projectId: PROJECT, commandId: "c-up", baseBranch: "dev", setupCommand: "  pnpm i  " },
        USER,
      ),
    );
    const conflict = await thrown(() =>
      map["board.updateProject"](
        { projectId: PROJECT, commandId: "c-up", baseBranch: "main" },
        USER,
      ),
    );
    expect(isCommandIntentConflict(conflict)).toBe(true);
  });

  it("clears a blank or null setup command, and leaves an absent one alone", async () => {
    const map = handlers();
    const update = (setupCommand?: string | null) =>
      map["board.updateProject"]({ projectId: PROJECT, baseBranch: null, setupCommand }, WINDOW);
    expect((await update("make")).project.setupCommand).toBe("make");
    expect((await update()).project.setupCommand).toBe("make");
    expect((await update("   ")).project.setupCommand).toBeNull();
    await update("make");
    const cleared = await update(null);
    expect(cleared.project.setupCommand).toBeNull();
    expect(cleared.receipt).toBeNull();
    // The window that asked holds the row: it is not told again, but the feed is.
    expect(published()).toEqual([]);
    expect(batches).toHaveLength(5);
    expect(changes().every((change) => change.commandId === undefined)).toBe(true);
  });

  it("refuses an unknown project, with or without a setup command", async () => {
    const map = handlers();
    for (const setupCommand of [undefined, "make"]) {
      await expect(async () =>
        map["board.updateProject"](
          { projectId: "nope", commandId: "c", baseBranch: null, setupCommand },
          USER,
        ),
      ).rejects.toThrow("Unknown project");
    }
    expect(counts().board_command_receipts).toBe(0);
    expect(batches).toEqual([]);
  });

  it("sets skill modes, dropping what the column cannot hold", async () => {
    const map = handlers();
    const first = await map["board.setSkillModes"](
      { projectId: PROJECT, commandId: "c-sk", modes: { review: "manual", "Not A Slug": "off" } },
      USER,
    );
    expect(first.project.skillModes).toEqual({ review: "manual" });
    expect(first.receipt).toEqual(receipt("c-sk"));
    expect(changes()).toEqual([expect.objectContaining({ kind: "project", commandId: "c-sk" })]);
    await expectReplay(first, () =>
      map["board.setSkillModes"](
        { projectId: PROJECT, commandId: "c-sk", modes: { review: "manual", "Not A Slug": "off" } },
        USER,
      ),
    );
    await expect(async () =>
      map["board.setSkillModes"]({ projectId: "nope", modes: {} }, USER),
    ).rejects.toThrow("Unknown project");
  });

  it("sets the project's session defaults", async () => {
    const map = handlers();
    const model = { providerId: "p", modelId: "m", reasoningLevel: "medium" } as const;
    const first = await map["board.setSessionDefaults"](
      { projectId: PROJECT, commandId: "c-sd", model },
      USER,
    );
    expect(first.project.sessionModel).toEqual(model);
    expect(published()).toEqual([{ projectId: PROJECT }]);
    await expectReplay(first, () =>
      map["board.setSessionDefaults"]({ projectId: PROJECT, commandId: "c-sd", model }, USER),
    );
    const cleared = await map["board.setSessionDefaults"](
      { projectId: PROJECT, model: null },
      USER,
    );
    expect(cleared).toMatchObject({ receipt: null, project: { sessionModel: null } });
  });
});

describe("board.createTicket", () => {
  it("creates the ticket, stamping its labels, its row without a body and its history", async () => {
    const map = handlers();
    const input = {
      projectId: PROJECT,
      commandId: "c-new",
      status: "todo" as const,
      title: "New",
      body: "secret body",
      labels: ["bug"],
      priority: "high" as const,
    };
    const first = await map["board.createTicket"](input, USER);
    const { ticket } = first;
    expect(first.receipt).toEqual(receipt("c-new"));
    expect(ticket).toMatchObject({ title: "New", body: "secret body", labels: ["bug"] });
    expect(getTicket(ctx.db, ticket.id)).toEqual(ticket);
    const [label] = listTicketLabels(ctx.db, ticket.id);
    expect(batches).toHaveLength(1);
    expect(changes()).toEqual([
      { kind: "label", op: "upsert", id: label!.id, projectId: PROJECT, label, commandId: "c-new" },
      {
        kind: "ticket",
        op: "upsert",
        id: ticket.id,
        projectId: PROJECT,
        ticket: ticketSummary(ticket),
        commandId: "c-new",
      },
      {
        kind: "ticketEvent",
        op: "upsert",
        id: ticket.id,
        projectId: PROJECT,
        ticketId: ticket.id,
        commandId: "c-new",
      },
    ]);
    expect("body" in (changes()[1] as { ticket: object }).ticket).toBe(false);
    expect(published()).toEqual([{ ticketId: ticket.id, projectId: PROJECT, kind: "ticket" }]);
    // Every event the create recorded woke its waiters, after COMMIT.
    expect(wakes.map((wake) => wake.event)).toEqual(listTicketEvents(ctx.db, ticket.id));

    await expectReplay(first, () => map["board.createTicket"](input, USER));
    const conflict = await thrown(() =>
      map["board.createTicket"]({ ...input, title: "Other" }, USER),
    );
    expect(isCommandIntentConflict(conflict)).toBe(true);
    expect(listTicketsByProject(ctx.db, PROJECT)).toHaveLength(1);
  });

  it("records the caller as the creator, and answers no receipt without a commandId", async () => {
    const map = handlers();
    const { receipt: none, ticket } = await map["board.createTicket"](
      { projectId: PROJECT, status: "backlog", title: "By agent" },
      SESSION,
    );
    expect(none).toBeNull();
    expect(changes().map((change) => [change.kind, change.commandId])).toEqual([
      ["ticket", undefined],
      ["ticketEvent", undefined],
    ]);
    expect(listTicketEvents(ctx.db, ticket.id)).toEqual([
      expect.objectContaining({
        actor: "session",
        actorContext: expect.objectContaining({ sessionId: "s-1" }),
      }),
    ]);
  });

  it("refuses an unknown project with today's error and records nothing", async () => {
    await expect(async () =>
      handlers()["board.createTicket"](
        { projectId: "nope", commandId: "c", status: "todo", title: "x" },
        USER,
      ),
    ).rejects.toThrow();
    expect(counts().board_command_receipts).toBe(0);
    expect(batches).toEqual([]);
  });
});

describe("ticket writes", () => {
  it("sets a priority, attributed to the caller, and replays it", async () => {
    seed("t-1");
    const map = handlers();
    const input = { ticketId: "t-1", commandId: "c-pri", priority: "high" as const };
    const first = await map["board.setPriority"](input, SESSION);
    expect(first).toEqual({
      receipt: receipt("c-pri"),
      throughCursor: feed.cursor(PROJECT),
      ticket: getTicket(ctx.db, "t-1"),
    });
    expect(first.ticket.priority).toBe("high");
    expect(changes()).toEqual([
      {
        kind: "ticket",
        op: "upsert",
        id: "t-1",
        projectId: PROJECT,
        ticket: ticketSummary(first.ticket),
        commandId: "c-pri",
      },
      {
        kind: "ticketEvent",
        op: "upsert",
        id: "t-1",
        projectId: PROJECT,
        ticketId: "t-1",
        commandId: "c-pri",
      },
    ]);
    expect(listTicketEvents(ctx.db, "t-1").at(-1)).toMatchObject({
      actor: "session",
      actorContext: { sessionId: "s-1" },
    });
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "ticket" }]);
    expect(wakes.length).toBeGreaterThan(0);
    await expectReplay(first, () => map["board.setPriority"](input, SESSION));
    expect(
      isCommandIntentConflict(
        await thrown(() => map["board.setPriority"]({ ...input, priority: "low" }, SESSION)),
      ),
    ).toBe(true);
  });

  it("replays with the row as it stands now and the cursor through it, after someone else's edit", async () => {
    seed("t-1");
    const map = handlers();
    const input = { ticketId: "t-1", commandId: "c-mine", priority: "high" as const };
    const first = await map["board.setPriority"](input, USER);
    await map["board.updateTicket"](
      { ticketId: "t-1", title: "Theirs", commandId: "c-theirs" },
      SESSION,
    );
    const again = await map["board.setPriority"](input, USER);
    expect(again.receipt).toEqual({ ...first.receipt, replayed: true });
    // Never a row older than the cursor it names.
    expect(again.ticket).toEqual(getTicket(ctx.db, "t-1"));
    expect(again.ticket).toMatchObject({ title: "Theirs", priority: "high" });
    expect(again.throughCursor).toBe(feed.cursor(PROJECT));
  });

  it("refuses the retry of a ticket write once the ticket is gone, as it refuses any write", async () => {
    seed("t-1");
    const map = handlers();
    const input = { ticketId: "t-1", commandId: "c-gone", priority: "low" as const };
    await map["board.setPriority"](input, WINDOW);
    await map["board.archiveTicket"]({ ticketId: "t-1" }, WINDOW);
    await map["board.deleteTicket"]({ ticketId: "t-1" }, WINDOW);
    await expect(async () => map["board.setPriority"](input, WINDOW)).rejects.toThrow(
      "Unknown ticket",
    );
  });

  it("refuses the retry of any write whose resource is gone since: a comment, a project, a label", async () => {
    seed("t-1");
    const map = handlers();
    const comment = { ticketId: "t-1", body: "Hi", commandId: "c-comment" };
    const created = await map["board.createComment"](comment, WINDOW);
    await map["board.removeComment"]({ commentId: created.comment.id }, WINDOW);
    await expect(async () => map["board.createComment"](comment, WINDOW)).rejects.toThrow(
      "Unknown comment",
    );

    const label = listTicketLabels(
      ctx.db,
      (await map["board.setLabels"]({ ticketId: "t-1", labels: ["ui"] }, WINDOW)).ticket.id,
    )[0]!;
    const color = { labelId: label.id, color: "#f00", commandId: "c-color" };
    await map["board.setLabelColor"](color, WINDOW);
    ctx.db.prepare("DELETE FROM labels WHERE id = ?").run(label.id);
    await expect(async () => map["board.setLabelColor"](color, WINDOW)).rejects.toThrow(
      "Unknown label",
    );

    const update = { projectId: PROJECT, baseBranch: "trunk", commandId: "c-project" };
    await map["board.updateProject"](update, WINDOW);
    ctx.db.pragma("foreign_keys = OFF");
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT);
    ctx.db.pragma("foreign_keys = ON");
    await expect(async () => map["board.updateProject"](update, WINDOW)).rejects.toThrow(
      "Unknown project",
    );
  });

  it("refuses an unknown ticket without a receipt", async () => {
    const map = handlers();
    await expect(async () =>
      map["board.setPriority"]({ ticketId: "nope", commandId: "c", priority: "low" }, USER),
    ).rejects.toThrow();
    expect(counts().board_command_receipts).toBe(0);
    expect(batches).toEqual([]);
  });

  it("sets labels, stamping each label row it names", async () => {
    seed("t-1", "todo", { labels: ["old"] });
    const map = handlers();
    const input = { ticketId: "t-1", commandId: "c-lab", labels: ["bug", "ui"] };
    const first = await map["board.setLabels"](input, USER);
    expect(first.ticket.labels.toSorted()).toEqual(["bug", "ui"]);
    const labels = listTicketLabels(ctx.db, "t-1");
    expect(changes()).toEqual([
      ...labels.map((label) => ({
        kind: "label",
        op: "upsert",
        id: label.id,
        projectId: PROJECT,
        label,
        commandId: "c-lab",
      })),
      expect.objectContaining({ kind: "ticket", id: "t-1", commandId: "c-lab" }),
      expect.objectContaining({ kind: "ticketEvent", id: "t-1", commandId: "c-lab" }),
    ]);
    await expectReplay(first, () => map["board.setLabels"](input, USER));

    // Without a commandId, the label rows name none either.
    batches.length = 0;
    await map["board.setLabels"]({ ticketId: "t-1", labels: ["bug"] }, WINDOW);
    expect(changes().map((change) => [change.kind, change.commandId])).toEqual([
      ["label", undefined],
      ["ticket", undefined],
      ["ticketEvent", undefined],
    ]);
  });

  it("updates a ticket's fields, and refuses an unknown ticket", async () => {
    seed("t-1", "todo", { body: "old" });
    const map = handlers();
    const input = { ticketId: "t-1", commandId: "c-upd", title: "Renamed", body: "new" };
    const first = await map["board.updateTicket"](input, USER);
    expect(first.receipt).toEqual(receipt("c-upd"));
    expect(first.ticket).toMatchObject({ title: "Renamed", body: "new" });
    expect(changes()).toEqual([
      expect.objectContaining({
        kind: "ticket",
        ticket: ticketSummary(first.ticket),
        commandId: "c-upd",
      }),
      expect.objectContaining({ kind: "ticketEvent", commandId: "c-upd" }),
    ]);
    expect((changes()[0] as { checkoutMoved?: boolean }).checkoutMoved).toBeUndefined();
    await expectReplay(first, () => map["board.updateTicket"](input, USER));
    await expect(async () =>
      map["board.updateTicket"]({ ticketId: "nope", title: "x" }, USER),
    ).rejects.toThrow("Unknown ticket");
  });

  it("archives a ticket, stamping its tombstone, and unarchives it", async () => {
    seed("t-1");
    const map = handlers();
    const first = await map["board.archiveTicket"]({ ticketId: "t-1", commandId: "c-arc" }, USER);
    expect(first).toEqual({ receipt: receipt("c-arc"), throughCursor: feed.cursor(PROJECT) });
    expect(getTicketRow(ctx.db, "t-1")?.archived_at).toBe(50);
    expect(changes()).toEqual([
      { kind: "ticket", op: "delete", id: "t-1", projectId: PROJECT, commandId: "c-arc" },
    ]);
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "ticket" }]);
    await expectReplay(first, () =>
      map["board.archiveTicket"]({ ticketId: "t-1", commandId: "c-arc" }, USER),
    );

    batches.length = 0;
    const back = await map["board.unarchiveTicket"]({ ticketId: "t-1", commandId: "c-un" }, USER);
    expect(back.receipt).toEqual(receipt("c-un"));
    expect(back.ticket.id).toBe("t-1");
    expect(getTicketRow(ctx.db, "t-1")?.archived_at).toBeNull();
    expect(changes()).toEqual([
      expect.objectContaining({ kind: "ticket", op: "upsert", id: "t-1", commandId: "c-un" }),
      expect.objectContaining({ kind: "ticketEvent", id: "t-1", commandId: "c-un" }),
    ]);
    await expectReplay(back, () =>
      map["board.unarchiveTicket"]({ ticketId: "t-1", commandId: "c-un" }, USER),
    );
  });

  it("refuses to archive an unknown ticket", async () => {
    await expect(async () =>
      handlers()["board.archiveTicket"]({ ticketId: "nope", commandId: "c" }, USER),
    ).rejects.toThrow("Unknown ticket");
    expect(batches).toEqual([]);
  });

  it("releases an archived ticket's saved tool output only when the host keeps any", async () => {
    const release = vi.spyOn(toolOutput, "removeTicketToolOutput");
    seed("t-1");
    seed("t-2");
    await handlers()["board.archiveTicket"]({ ticketId: "t-1" }, USER);
    expect(release).not.toHaveBeenCalled();
    const piSessionsDirectory = tempDir("pi");
    await handlers({ piSessionsDirectory })["board.archiveTicket"]({ ticketId: "t-2" }, USER);
    expect(release).toHaveBeenCalledWith(ctx.db, piSessionsDirectory, "t-2");
  });

  it("logs, and still archives, when the tool output cannot be released", async () => {
    seed("t-1");
    const failure = new Error("disk gone");
    vi.spyOn(toolOutput, "removeTicketToolOutput").mockImplementation(() => {
      throw failure;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const answer = await handlers({ piSessionsDirectory: tempDir("pi") })["board.archiveTicket"](
      { ticketId: "t-1" },
      WINDOW,
    );
    expect(answer).toEqual({ receipt: null, throughCursor: expect.any(String) });
    expect(warn).toHaveBeenCalledWith("[board] could not remove a ticket's saved tool output", {
      ticketId: "t-1",
      error: expect.objectContaining({ name: "Error", message: "disk gone" }),
    });
    expect(getTicketRow(ctx.db, "t-1")?.archived_at).toBe(50);
    expect(published()).toEqual([]);
  });

  it("stamps the moved checkout when an archive's detached trim lands, even for the window", async () => {
    seed("t-1");
    const trimmed = deferred<void>();
    vi.spyOn(worktreeModule, "trimFinishedWorktree").mockImplementation(async () => {
      trimmed.resolve();
      return { kind: "trimmed", entries: 1, bytes: 1, kept: 0 } as never;
    });
    const tracked: Promise<unknown>[] = [];
    await handlers({ detachedWork: { track: (work) => tracked.push(work) } })[
      "board.archiveTicket"
    ]({ ticketId: "t-1", commandId: "c-arc" }, WINDOW);
    await trimmed.promise;
    await Promise.all(tracked);
    expect(changes()).toEqual([
      { kind: "ticket", op: "delete", id: "t-1", projectId: PROJECT, commandId: "c-arc" },
      { kind: "ticket", op: "upsert", id: "t-1", projectId: PROJECT, checkoutMoved: true },
    ]);
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "worktree" }]);
  });

  it("deletes only an archived ticket, releasing its tool output first", async () => {
    const release = vi.spyOn(toolOutput, "removeTicketToolOutput");
    seed("live");
    seed("old");
    archiveTicketCommand(ctx.db, "old", { now: 2, actor: { kind: "user" } });
    const map = handlers({ piSessionsDirectory: tempDir("pi") });
    await expect(async () =>
      map["board.deleteTicket"]({ ticketId: "live", commandId: "c-del-live" }, USER),
    ).rejects.toThrow("Only archived tickets can be deleted");
    expect(release).not.toHaveBeenCalled();
    expect(counts().board_command_receipts).toBe(0);

    const first = await map["board.deleteTicket"]({ ticketId: "old", commandId: "c-del" }, USER);
    expect(first).toEqual({ receipt: receipt("c-del"), throughCursor: feed.cursor(PROJECT) });
    expect(getTicketRow(ctx.db, "old")).toBeUndefined();
    expect(release).toHaveBeenCalledWith(ctx.db, expect.any(String), "old");
    expect(changes()).toEqual([
      { kind: "ticket", op: "delete", id: "old", projectId: PROJECT, commandId: "c-del" },
    ]);
    expect(published()).toEqual([{ ticketId: "old", projectId: PROJECT, kind: "ticket" }]);

    await expect(async () => map["board.deleteTicket"]({ ticketId: "nope" }, USER)).rejects.toThrow(
      "Unknown ticket",
    );
  });

  it("deletes without a receipt for a legacy caller, telling no window that asked", async () => {
    seed("old");
    archiveTicketCommand(ctx.db, "old", { now: 2, actor: { kind: "user" } });
    expect(await handlers()["board.deleteTicket"]({ ticketId: "old" }, WINDOW)).toEqual({
      receipt: null,
      throughCursor: feed.cursor(PROJECT),
    });
    expect(changes()).toEqual([{ kind: "ticket", op: "delete", id: "old", projectId: PROJECT }]);
    expect(published()).toEqual([]);
  });

  // The receipt is keyed by the ticket's Workspace, which a deleted ticket no
  // longer resolves: the repeat misses its receipt and runs the delete again.
  it("answers a repeated delete from its receipt", async () => {
    seed("old");
    archiveTicketCommand(ctx.db, "old", { now: 2, actor: { kind: "user" } });
    const map = handlers();
    const first = await map["board.deleteTicket"]({ ticketId: "old", commandId: "c-del" }, USER);
    await expectReplay(first, () =>
      map["board.deleteTicket"]({ ticketId: "old", commandId: "c-del" }, USER),
    );
  });
});

describe("comments", () => {
  it("creates a comment as the person, stamping the comment and its ticket's history", async () => {
    seed("t-1");
    const map = handlers();
    const input = { ticketId: "t-1", commandId: "c-com", body: "hello" };
    const first = await map["board.createComment"](input, SESSION);
    const { comment } = first;
    expect(first.receipt).toEqual(receipt("c-com"));
    expect(comment).toMatchObject({ ticketId: "t-1", body: "hello", actor: "user" });
    expect(getComment(ctx.db, comment.id)).toEqual(comment);
    expect(changes()).toEqual([
      {
        kind: "comment",
        op: "upsert",
        id: comment.id,
        projectId: PROJECT,
        ticketId: "t-1",
        comment,
        commandId: "c-com",
      },
      {
        kind: "ticketEvent",
        op: "upsert",
        id: "t-1",
        projectId: PROJECT,
        ticketId: "t-1",
        commandId: "c-com",
      },
    ]);
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "comment" }]);
    // The event is attributed to the door's caller, the comment to the person.
    expect(listTicketEvents(ctx.db, "t-1").at(-1)).toMatchObject({
      actor: "session",
      actorContext: { sessionId: "s-1" },
    });
    await expectReplay(first, () => map["board.createComment"](input, SESSION));
    expect(
      isCommandIntentConflict(
        await thrown(() => map["board.createComment"]({ ...input, body: "other" }, SESSION)),
      ),
    ).toBe(true);
  });

  it("edits a comment, recording no event", async () => {
    seed("t-1");
    const map = handlers();
    const { comment } = await map["board.createComment"]({ ticketId: "t-1", body: "a" }, WINDOW);
    expect(published()).toEqual([]);
    batches.length = 0;
    const events = listTicketEvents(ctx.db, "t-1").length;
    const input = { commentId: comment.id, commandId: "c-edit", body: "b" };
    const first = await map["board.updateComment"](input, USER);
    expect(first.receipt).toEqual(receipt("c-edit"));
    expect(first.comment).toMatchObject({ id: comment.id, body: "b", updatedAt: 50 });
    expect(listTicketEvents(ctx.db, "t-1")).toHaveLength(events);
    expect(changes()).toEqual([
      expect.objectContaining({ kind: "comment", op: "upsert", comment: first.comment }),
      expect.objectContaining({ kind: "ticketEvent", id: "t-1", commandId: "c-edit" }),
    ]);
    await expectReplay(first, () => map["board.updateComment"](input, USER));
    await expect(async () =>
      map["board.updateComment"]({ commentId: "nope", commandId: "c", body: "x" }, USER),
    ).rejects.toThrow("Unknown comment");
  });

  it("removes a comment, stamping its tombstone without the row", async () => {
    seed("t-1");
    const map = handlers();
    const { comment } = await map["board.createComment"]({ ticketId: "t-1", body: "a" }, USER);
    batches.length = 0;
    publish.mockClear();
    const first = await map["board.removeComment"](
      { commentId: comment.id, commandId: "c-rm" },
      USER,
    );
    expect(first).toEqual({ receipt: receipt("c-rm"), throughCursor: feed.cursor(PROJECT) });
    expect(getComment(ctx.db, comment.id)).toBeUndefined();
    expect(changes()).toEqual([
      {
        kind: "comment",
        op: "delete",
        id: comment.id,
        projectId: PROJECT,
        ticketId: "t-1",
        commandId: "c-rm",
      },
      {
        kind: "ticketEvent",
        op: "upsert",
        id: "t-1",
        projectId: PROJECT,
        ticketId: "t-1",
        commandId: "c-rm",
      },
    ]);
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "comment" }]);
    await expect(async () =>
      map["board.removeComment"]({ commentId: "nope" }, USER),
    ).rejects.toThrow("Unknown comment");
  });

  // As for a deleted ticket: a removed comment no longer resolves the
  // Workspace its receipt is keyed under, so the repeat runs again and refuses.
  it("answers a repeated removal from its receipt", async () => {
    seed("t-1");
    const map = handlers();
    const { comment } = await map["board.createComment"]({ ticketId: "t-1", body: "a" }, USER);
    const input = { commentId: comment.id, commandId: "c-rm" };
    const first = await map["board.removeComment"](input, USER);
    await expectReplay(first, () => map["board.removeComment"](input, USER));
  });
});

describe("board.setLabelColor", () => {
  it("recolours a label, stamping its row, and refuses an unknown one", async () => {
    seed("t-1", "todo", { labels: ["bug"] });
    const [label] = listTicketLabels(ctx.db, "t-1");
    const map = handlers();
    const input = { labelId: label!.id, color: "#ff0000", commandId: "c-col" };
    const first = await map["board.setLabelColor"](input, USER);
    expect(first).toEqual({
      receipt: receipt("c-col"),
      throughCursor: feed.cursor(PROJECT),
      label: { ...label, color: "#ff0000" },
    });
    expect(changes()).toEqual([
      {
        kind: "label",
        op: "upsert",
        id: label!.id,
        projectId: PROJECT,
        label: first.label,
        commandId: "c-col",
      },
    ]);
    expect(published()).toEqual([{ projectId: PROJECT }]);
    await expectReplay(first, () => map["board.setLabelColor"](input, USER));

    batches.length = 0;
    const reset = await map["board.setLabelColor"]({ labelId: label!.id, color: null }, WINDOW);
    expect(reset).toEqual({
      receipt: null,
      throughCursor: feed.cursor(PROJECT),
      label: { ...label, color: null },
    });
    expect(changes()[0]!.commandId).toBeUndefined();

    await expect(async () =>
      map["board.setLabelColor"]({ labelId: "nope", color: null, commandId: "c" }, USER),
    ).rejects.toThrow("Unknown label");
    expect(counts().board_command_receipts).toBe(1);
  });
});

describe("announcing data-changed", () => {
  it("tells every other caller once, and stamps the feed once despite the bus tap", async () => {
    seed("t-1");
    await handlers()["board.setPriority"]({ ticketId: "t-1", priority: "high" }, USER);
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "ticket" }]);
    // The bus fed the feed, but the command's own announcement is untapped.
    expect(batches).toHaveLength(1);
    expect(changes().every((change) => "ticket" in change || change.kind === "ticketEvent")).toBe(
      true,
    );
  });

  it("tells the desktop window that asked nothing, because its reply holds the row", async () => {
    seed("t-1");
    await handlers()["board.setPriority"]({ ticketId: "t-1", priority: "high" }, WINDOW);
    expect(published()).toEqual([]);
    expect(batches).toHaveLength(1);
  });

  it("taps the bus again once a command's announcement is done", async () => {
    seed("t-1");
    await handlers()["board.setPriority"]({ ticketId: "t-1", priority: "high" }, USER);
    publish("data-changed", { projectId: PROJECT });
    expect(batches).toHaveLength(2);
    expect(batches[1]!.changes).toEqual([
      { kind: "project", op: "upsert", id: PROJECT, projectId: PROJECT },
    ]);
  });
});

describe("moves", () => {
  it("stamps every row a move renumbered, its own commandId on each, and replays the board", async () => {
    seed("a", "todo");
    seed("b", "todo");
    seed("c", "todo");
    seed("elsewhere", "backlog");
    const map = handlers();
    const input = { projectId: PROJECT, ticketId: "c", toStatus: "todo" as const, toIndex: 0 };
    const first = await map["board.moveTickets"]({ ...input, commandId: "c-mv" }, USER);
    expect(first.receipt).toEqual(receipt("c-mv"));
    expect(first.tickets).toEqual(listTicketsByProject(ctx.db, PROJECT));
    const order = (id: string) => first.tickets.find((ticket) => ticket.id === id)!.order;
    expect([order("c"), order("a"), order("b")]).toEqual([0, 1, 2]);
    // A reorder within a column records no status change: rows only.
    expect(batches).toHaveLength(1);
    expect(changes().map((change) => [change.kind, change.id, change.commandId])).toEqual(
      expect.arrayContaining([
        ["ticket", "a", "c-mv"],
        ["ticket", "b", "c-mv"],
        ["ticket", "c", "c-mv"],
      ]),
    );
    expect(changes().map((change) => change.id)).not.toContain("elsewhere");
    expect(changes()).toHaveLength(3);
    expect(published()).toEqual([{ projectId: PROJECT, ticketId: "c", kind: "ticket" }]);

    const before = counts();
    const again = await map["board.moveTickets"]({ ...input, commandId: "c-mv" }, USER);
    expect(again).toEqual({
      receipt: { ...receipt("c-mv"), replayed: true },
      throughCursor: feed.cursor(PROJECT),
      tickets: listTicketsByProject(ctx.db, PROJECT),
    });
    expect(counts()).toEqual(before);
    expect(batches).toHaveLength(1);
    expect(published()).toHaveLength(1);
    expect(
      isCommandIntentConflict(
        await thrown(() =>
          map["board.moveTickets"]({ ...input, toIndex: 2, commandId: "c-mv" }, USER),
        ),
      ),
    ).toBe(true);
  });

  it("stamps a column change's history too, and answers no receipt without a commandId", async () => {
    seed("a", "todo");
    seed("b", "doing");
    const answer = await handlers()["board.moveTickets"](
      { projectId: PROJECT, ticketIds: ["a"], toStatus: "doing", toIndex: 0 },
      SESSION,
    );
    expect(answer.receipt).toBeNull();
    expect(changes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ticket", id: "a", ticket: expect.anything() }),
        { kind: "ticketEvent", op: "upsert", id: "a", projectId: PROJECT, ticketId: "a" },
        expect.objectContaining({ kind: "ticket", id: "b" }),
      ]),
    );
    expect(changes().filter((change) => change.kind === "ticketEvent")).toHaveLength(1);
    expect(changes().every((change) => change.commandId === undefined)).toBe(true);
    expect(listTicketEvents(ctx.db, "a").at(-1)).toMatchObject({
      actor: "session",
      payload: { kind: "status_changed" },
    });
  });

  it("records the receipt after a move that waits on its interrupts", async () => {
    seed("a", "doing");
    const interruptTicketSessions = vi.fn(async () => ["s-1"]);
    const reply = handlers({ interruptTicketSessions })["board.moveTickets"](
      { projectId: PROJECT, ticketId: "a", toStatus: "todo", commandId: "c-back" },
      USER,
    );
    expect(reply).toBeInstanceOf(Promise);
    const answer = await reply;
    expect(interruptTicketSessions).toHaveBeenCalledWith("a");
    expect(answer.receipt).toEqual(receipt("c-back"));
    expect(answer.tickets.find((ticket) => ticket.id === "a")?.status).toBe("todo");
    expect(counts().board_command_receipts).toBe(1);
    expect(changes()).toEqual([
      expect.objectContaining({ kind: "ticket", id: "a", commandId: "c-back" }),
      expect.objectContaining({ kind: "ticketEvent", id: "a", commandId: "c-back" }),
    ]);
  });

  it("stamps a ticket.move's rows with no commandId", async () => {
    seed("a", "todo");
    const moved = await handlers()["ticket.move"](
      { projectId: PROJECT, ticketId: "a", toStatus: "doing" },
      WINDOW,
    );
    expect(moved.find((ticket) => ticket.id === "a")?.status).toBe("doing");
    expect(changes()).toEqual([
      {
        kind: "ticket",
        op: "upsert",
        id: "a",
        projectId: PROJECT,
        ticket: listTicketsByProject(ctx.db, PROJECT).map(ticketSummary)[0],
      },
      { kind: "ticketEvent", op: "upsert", id: "a", projectId: PROJECT, ticketId: "a" },
    ]);
    expect(published()).toEqual([]);
  });

  it("commits a move's receipt in the move's transaction: a receipt that cannot be written undoes the move", async () => {
    seed("a", "todo");
    seed("b", "todo");
    ctx.db.exec(
      "CREATE TEMP TRIGGER deny_receipt BEFORE INSERT ON board_command_receipts BEGIN SELECT RAISE(ABORT, 'receipt denied'); END",
    );
    const map = handlers();
    const input = {
      projectId: PROJECT,
      ticketId: "a",
      toStatus: "doing" as const,
      toIndex: 0,
      commandId: "c-atomic",
    };
    const before = counts();
    const ticketsBefore = listTicketsByProject(ctx.db, PROJECT);
    await expect(async () => map["board.moveTickets"](input, USER)).rejects.toThrow(
      "receipt denied",
    );
    // Nothing committed, so nothing was woken, stamped or announced.
    expect(listTicketsByProject(ctx.db, PROJECT)).toEqual(ticketsBefore);
    expect(counts()).toEqual(before);
    expect(wakes).toEqual([]);
    expect(batches).toEqual([]);
    expect(published()).toEqual([]);
    // The retry, once the receipt can be written, moves exactly once.
    ctx.db.exec("DROP TRIGGER deny_receipt");
    const answer = await map["board.moveTickets"](input, USER);
    expect(answer.receipt).toEqual(receipt("c-atomic"));
    expect(getTicket(ctx.db, "a")?.status).toBe("doing");
    expect(counts().board_command_receipts).toBe(1);
  });

  it("stamps a move and records its receipt before any wake: a retry the wake sets off replays", async () => {
    seed("a", "todo");
    const map = handlers();
    const input = {
      projectId: PROJECT,
      ticketId: "a",
      toStatus: "doing" as const,
      toIndex: 0,
      commandId: "c-reentrant",
    };
    const seen: { stamped: number; receipts: number }[] = [];
    let retried: unknown;
    const stop = subscribeTicketWake(() => {
      seen.push({ stamped: batches.length, receipts: counts().board_command_receipts });
      // A listener that retries the same command in the wake's own turn.
      retried ??= map["board.moveTickets"](input, USER);
    });
    try {
      const first = await map["board.moveTickets"](input, USER);
      expect(first.receipt).toEqual(receipt("c-reentrant"));
      expect(await retried).toEqual({
        receipt: { ...receipt("c-reentrant"), replayed: true },
        throughCursor: first.throughCursor,
        tickets: first.tickets,
      });
    } finally {
      stop();
    }
    // Every wake saw the feed already stamped and the receipt already durable.
    expect(seen.length).toBeGreaterThan(0);
    for (const at of seen) expect(at).toEqual({ stamped: 1, receipts: 1 });
    expect(
      listTicketEvents(ctx.db, "a").filter((e) => e.payload.kind === "status_changed"),
    ).toHaveLength(1);
  });

  it("refuses a move port that never runs the receipt it was handed", async () => {
    seed("a", "todo");
    const board = createBoardHandlers({
      db: ctx.db,
      now: () => 50,
      events: { publish } as never,
      feed,
      worktree: () => ({ db: ctx.db }) as never,
      busyWorktreeSites: async () => [],
      ticketSignals: null,
      // Moves, but ignores the seam: no receipt joins its transaction.
      move: (input) => {
        void input;
        return listTicketsByProject(ctx.db, PROJECT);
      },
    });
    expect(() =>
      board["board.moveTickets"](
        { projectId: PROJECT, ticketId: "a", toStatus: "doing", toIndex: 0, commandId: "c-x" },
        USER,
      ),
    ).toThrow("The move did not record its receipt in its transaction");
    expect(counts().board_command_receipts).toBe(0);
  });

  it("records the receipt of a column-only no-op, so its retry replays rather than moving", async () => {
    seed("a", "todo");
    const map = handlers();
    const input = {
      projectId: PROJECT,
      ticketId: "a",
      toStatus: "todo" as const,
      commandId: "c-noop",
    };
    const first = await map["board.moveTickets"](input, USER);
    expect(first.receipt).toEqual(receipt("c-noop"));
    expect(counts().board_command_receipts).toBe(1);
    // Someone else moves it; the retry of the no-op must not move it back.
    await map["ticket.move"]({ projectId: PROJECT, ticketId: "a", toStatus: "doing" }, SESSION);
    const again = await map["board.moveTickets"](input, USER);
    expect(again.receipt?.replayed).toBe(true);
    expect(getTicket(ctx.db, "a")?.status).toBe("doing");
  });

  it("stamps nothing for a move to the column a ticket already holds", async () => {
    seed("a", "todo");
    await handlers()["ticket.move"]({ projectId: PROJECT, ticketId: "a", toStatus: "todo" }, USER);
    expect(batches).toEqual([]);
  });
});

describe("worktree scope", () => {
  it("materializes the checkout when scope switches on, and says so even to the window", async () => {
    const repo = seedRepository();
    insertProject(
      ctx.db,
      testProject({ id: "real", path: repo, ticketPrefix: "RE", baseBranch: "main" }),
    );
    feed.subscribe("real", null, (batch) => batches.push(batch));
    seed("t-1", "todo", { projectId: "real" });
    const map = handlers({
      worktree: {
        db: ctx.db,
        git: runGitCapturing,
        gitAsync: runGitCapturingAsync,
        home: tempDir("home"),
        blobsRoot: tempDir("blobs"),
      },
    });
    const answer = await map["board.updateTicket"](
      { ticketId: "t-1", usesWorktree: true, commandId: "c-wt" },
      WINDOW,
    );
    expect(answer.receipt).toEqual(receipt("c-wt"));
    expect(answer.ticket.usesWorktree).toBe(true);
    expect(answer.ticket.worktreePath).not.toBeNull();
    expect(answer.ticket.branch).toMatch(/^volli\/RE-\d+-t-1$/);
    expect(answer.ticket).toEqual(getTicket(ctx.db, "t-1"));
    expect(batches).toHaveLength(2);
    expect(batches[1]!.changes).toEqual([
      {
        kind: "ticket",
        op: "upsert",
        id: "t-1",
        projectId: "real",
        ticket: ticketSummary(answer.ticket),
        commandId: "c-wt",
        checkoutMoved: true,
      },
    ]);
    // The field write is the window's own; the moved checkout is everyone's.
    expect(published()).toEqual([{ ticketId: "t-1", projectId: "real", kind: "worktree" }]);
  });

  it("reports a failed materialization after saying the scope changed", async () => {
    seed("t-1");
    const ensure = vi
      .spyOn(worktreeModule, "ensure")
      .mockResolvedValue({ ok: false, error: "git exploded" } satisfies Ensured);
    const error = await thrown(() =>
      handlers()["board.updateTicket"]({ ticketId: "t-1", usesWorktree: true }, USER),
    );
    expect(ensure).toHaveBeenCalledWith(expect.anything(), "t-1");
    expect((error as Error).message).toBe("worktree scope is on, but git exploded");
    expect(getTicketRow(ctx.db, "t-1")?.uses_worktree).toBe(1);
    expect(batches.at(-1)!.changes).toEqual([
      expect.objectContaining({ kind: "ticket", id: "t-1", checkoutMoved: true }),
    ]);
    expect(batches.at(-1)!.changes[0]!.commandId).toBeUndefined();
    expect(published()).toEqual([
      { ticketId: "t-1", projectId: PROJECT, kind: "ticket" },
      { ticketId: "t-1", projectId: PROJECT, kind: "worktree" },
    ]);
  });

  it("refuses to switch scope off while the checkout is being made, and allows it after", async () => {
    seed("t-1");
    const pending = deferred<Ensured>();
    vi.spyOn(worktreeModule, "ensure").mockReturnValue(pending.promise);
    const map = handlers();
    const switching = map["board.updateTicket"]({ ticketId: "t-1", usesWorktree: true }, USER);
    await expect(async () =>
      map["board.updateTicket"]({ ticketId: "t-1", usesWorktree: false }, USER),
    ).rejects.toThrow(STILL_CREATING);
    // Re-asserting the scope passes through, and another ticket is not held.
    expect(
      await map["board.updateTicket"](
        { ticketId: "t-1", usesWorktree: true, title: "again" },
        USER,
      ),
    ).toMatchObject({ ticket: { title: "again" } });
    seed("t-2", "todo", { usesWorktree: true });
    expect(
      await map["board.updateTicket"]({ ticketId: "t-2", usesWorktree: false }, USER),
    ).toMatchObject({ ticket: { usesWorktree: false } });
    pending.resolve(ENSURED);
    await switching;
    expect(
      await map["board.updateTicket"]({ ticketId: "t-1", usesWorktree: false }, USER),
    ).toMatchObject({ ticket: { usesWorktree: false } });
  });

  it("answers the committed ticket when it vanished while its checkout was being made", async () => {
    const committed = seed("t-1");
    const pending = deferred<Ensured>();
    vi.spyOn(worktreeModule, "ensure").mockReturnValue(pending.promise);
    const map = handlers();
    const switching = map["board.updateTicket"]({ ticketId: "t-1", usesWorktree: true }, USER);
    await map["board.archiveTicket"]({ ticketId: "t-1" }, USER);
    await map["board.deleteTicket"]({ ticketId: "t-1" }, USER);
    pending.resolve(ENSURED);
    const answer = await switching;
    expect(answer.ticket).toMatchObject({ id: committed.id, usesWorktree: true });
    expect(batches.at(-1)!.changes).toEqual([
      expect.objectContaining({ kind: "ticket", id: "t-1", checkoutMoved: true }),
    ]);
  });

  it("moves the Session destination when scope switches off, even for the window", async () => {
    seed("t-1", "todo", { usesWorktree: true });
    const map = handlers();
    const input = { ticketId: "t-1", usesWorktree: false, commandId: "c-off" };
    const first = await map["board.updateTicket"](input, WINDOW);
    expect(first.ticket.usesWorktree).toBe(false);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.changes).toEqual([
      {
        kind: "ticket",
        op: "upsert",
        id: "t-1",
        projectId: PROJECT,
        ticket: ticketSummary(first.ticket),
        commandId: "c-off",
        checkoutMoved: true,
      },
    ]);
    expect(published()).toEqual([{ ticketId: "t-1", projectId: PROJECT, kind: "worktree" }]);
    // Nothing more on a repeat, nor on a write that leaves scope where it is.
    await expectReplay(first, () => map["board.updateTicket"](input, WINDOW));
    await map["board.updateTicket"]({ ticketId: "t-1", usesWorktree: false }, WINDOW);
    expect(published()).toHaveLength(1);
  });

  it("does not materialize again when a switch-on is replayed after a switch-off", async () => {
    seed("t-1");
    const ensure = vi.spyOn(worktreeModule, "ensure").mockResolvedValue(ENSURED);
    const map = handlers();
    const on = { ticketId: "t-1", usesWorktree: true, commandId: "c-on" };
    const first = await map["board.updateTicket"](on, USER);
    await map["board.updateTicket"](
      { ticketId: "t-1", usesWorktree: false, commandId: "c-off" },
      USER,
    );
    const again = await map["board.updateTicket"](on, USER);
    // The replay answers the ticket as it stands now, scope off.
    expect(again).toEqual({
      ...first,
      receipt: { ...first.receipt, replayed: true },
      throughCursor: feed.cursor(PROJECT),
      ticket: getTicket(ctx.db, "t-1"),
    });
    expect(again.ticket.usesWorktree).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(getTicketRow(ctx.db, "t-1")?.uses_worktree).toBe(0);
  });

  it("replays a successful materialization with the checkout it made, not the row before it", async () => {
    seed("t-1");
    const ensure = vi.spyOn(worktreeModule, "ensure").mockImplementation(async () => {
      ctx.db
        .prepare("UPDATE tickets SET worktree_path = ?, branch = ? WHERE id = ?")
        .run("/made/checkout", "volli/VC-1-t-1", "t-1");
      return ENSURED;
    });
    const map = handlers();
    const input = { ticketId: "t-1", usesWorktree: true, commandId: "c-made" };
    const first = await map["board.updateTicket"](input, USER);
    expect(first.ticket).toMatchObject({
      worktreePath: "/made/checkout",
      branch: "volli/VC-1-t-1",
    });
    const stamped = batches.length;
    const again = await map["board.updateTicket"](input, USER);
    expect(again).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
    expect(again.ticket).toEqual(getTicket(ctx.db, "t-1"));
    expect(again.throughCursor).toBe(feed.cursor(PROJECT));
    expect(batches).toHaveLength(stamped);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("answers a retry during the materialization with the row as it stands, and runs one ensure", async () => {
    seed("t-1");
    const pending = deferred<Ensured>();
    const ensure = vi.spyOn(worktreeModule, "ensure").mockReturnValue(pending.promise);
    const map = handlers();
    const input = { ticketId: "t-1", usesWorktree: true, commandId: "c-flight" };
    const first = map["board.updateTicket"](input, USER);
    const during = await map["board.updateTicket"](input, USER);
    expect(during.receipt?.replayed).toBe(true);
    expect(during.ticket).toEqual(getTicket(ctx.db, "t-1"));
    expect(during.throughCursor).toBe(feed.cursor(PROJECT));
    ctx.db.prepare("UPDATE tickets SET worktree_path = '/made' WHERE id = 't-1'").run();
    pending.resolve(ENSURED);
    expect((await first).ticket.worktreePath).toBe("/made");
    expect((await map["board.updateTicket"](input, USER)).ticket.worktreePath).toBe("/made");
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("keeps the committed switch's receipt when materialization fails: the retry replays, never ensures", async () => {
    seed("t-1");
    const ensure = vi
      .spyOn(worktreeModule, "ensure")
      .mockResolvedValue({ ok: false, error: "git exploded" } satisfies Ensured);
    const map = handlers();
    const input = { ticketId: "t-1", usesWorktree: true, commandId: "c-fail" };
    await expect(async () => map["board.updateTicket"](input, USER)).rejects.toThrow(
      "worktree scope is on, but git exploded",
    );
    const again = await map["board.updateTicket"](input, USER);
    expect(again.receipt?.replayed).toBe(true);
    expect(again.ticket).toEqual(getTicket(ctx.db, "t-1"));
    expect(again.ticket.usesWorktree).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});

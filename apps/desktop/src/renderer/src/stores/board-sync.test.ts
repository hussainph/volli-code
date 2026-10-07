/**
 * The board's sync engine (VC-565, T5) against a fake in-memory host: a real
 * board (the shared move semantics), a feed this file controls that stamps
 * every write's rows under its `commandId` and answers its `throughCursor`,
 * per-call latency, and failure injection. Every timer is vitest's.
 */
import {
  groupTicketsByStatus,
  moveTicket,
  moveTickets,
  TICKET_STATUSES,
  type ArchivedTicket,
  type BoardChange,
  type Label,
  type Project,
  type Ticket,
  type TicketStatus,
  type TicketSummary,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  BoardSync,
  isAmbiguousBoardFailure,
  isBoardUnavailable,
  placeholderTicketId,
  READ_LOG_ENTITIES,
  type BoardFeedBatch,
  type BoardSyncOptions,
  type BoardSyncTransport,
  type BoardSyncView,
  type BoardWriteAnswer,
} from "./board-sync";
import { startBoardProtocol, stopBoardProtocol } from "../lib/board-protocol";
import { createBoardStore } from "./board";
import { ticketScope, useSessionsStore } from "./sessions";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// ---- fixtures ------------------------------------------------------------------

const STATUS_RANK = new Map(TICKET_STATUSES.map((status, index) => [status, index]));

function ticket(
  id: string,
  status: TicketStatus,
  order: number,
  over: Partial<Ticket> = {},
): Ticket {
  return {
    id,
    projectId: "p1",
    ticketNumber: id.charCodeAt(0),
    title: `Ticket ${id}`,
    body: `# ${id}`,
    status,
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function project(id: string): Project {
  return {
    id,
    name: id.toUpperCase(),
    path: `/${id}`,
    ticketPrefix: id.toUpperCase(),
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  } as Project;
}

function label(id: string, projectId = "p1"): Label {
  return { id, projectId, name: id, color: null };
}

function summaryOf(row: Ticket): TicketSummary {
  const { body: _body, ...summary } = row;
  return summary;
}

function byColumn(left: Ticket, right: Ticket): number {
  return STATUS_RANK.get(left.status)! - STATUS_RANK.get(right.status)! || left.order - right.order;
}

/** Each column's ticket ids, top to bottom. */
function columns(tickets: readonly Ticket[]): Record<TicketStatus, string[]> {
  const grouped = groupTicketsByStatus(tickets);
  return Object.fromEntries(
    TICKET_STATUSES.map((status) => [status, grouped[status].map(({ id }) => id)]),
  ) as Record<TicketStatus, string[]>;
}

/** Where a ticket sits: its column and its index in it, or "absent". */
function placement(tickets: readonly Ticket[], id: string): string {
  const grouped = columns(tickets);
  for (const status of TICKET_STATUSES) {
    const index = grouped[status].indexOf(id);
    if (index !== -1) return `${status}#${index}`;
  }
  return "absent";
}

const unreachable = {
  data: { hostError: { code: "SERVICE_UNAVAILABLE", message: "host-unreachable" } },
};
const conflict = { data: { hostError: { code: "CONFLICT", message: "stale board" } } };
const notFound = {
  data: { hostError: { code: "NOT_FOUND", message: "Not found in this Workspace." } },
};

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

// ---- the fake host -----------------------------------------------------------------

interface Latency {
  /** Before the host acts on a call (a read captures its state, a write applies). */
  request: number;
  /** After it acted, before the answer lands. */
  reply: number;
  /** From a stamp to its delivery on every subscribed feed. */
  feed: number;
}

interface Fault {
  readonly error: unknown;
  /** The host acted, and only the answer was lost. */
  readonly applied: boolean;
}

interface Subscriber {
  readonly projectId: string;
  readonly handlers: Parameters<BoardSyncTransport["changes"]>[2];
  active: boolean;
}

type FeedHandlers = Parameters<BoardSyncTransport["changes"]>[2];

/**
 * One host's board: the shared board ops over its rows, a per-Workspace feed
 * (cursor `<project>:<seq>`, rising one per stamp), command receipts that
 * answer a repeated `commandId` without a second effect, and the resume
 * semantics of the real feed (one compacted batch at the current cursor).
 */
class FakeHost implements BoardSyncTransport {
  readonly projects = new Map<string, Project>();
  tickets: Ticket[] = [];
  labels: Label[] = [];
  archived: ArchivedTicket[] = [];
  latency: Latency = { request: 0, reply: 0, feed: 0 };
  /** Per-method latency, over {@link latency}. */
  readonly methodLatency: Partial<Record<string, Partial<Latency>>> = {};
  readonly calls: { method: string; input: unknown; at: number }[] = [];
  /** How many times each `commandId` took effect. */
  readonly effects = new Map<string, number>();
  readonly subscriptions: { projectId: string; lastEventId: string }[] = [];
  unsubscribes = 0;
  /** Stamps without delivering: a feed that never brings a write's cursor. */
  dropFeed = false;
  readonly #seq = new Map<string, number>();
  readonly #log: { projectId: string; seq: number; changes: readonly BoardChange[] }[] = [];
  readonly #subscribers = new Set<Subscriber>();
  readonly #receipts = new Map<string, BoardWriteAnswer & Record<string, unknown>>();
  readonly #faults = new Map<string, Fault[]>();
  #nextTicket = 1;

  constructor() {
    this.projects.set("p1", project("p1"));
  }

  cursor(projectId: string): string {
    return `${projectId}:${this.#seq.get(projectId) ?? 0}`;
  }

  board(projectId: string): Ticket[] {
    return this.tickets.filter((row) => row.projectId === projectId).toSorted(byColumn);
  }

  callsTo(method: string): { method: string; input: unknown; at: number }[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The next `times` calls of `method` fail with `error`. */
  fail(method: string, error: unknown, options: { applied?: boolean; times?: number } = {}): void {
    const faults = this.#faults.get(method) ?? [];
    for (let i = 0; i < (options.times ?? 1); i++) {
      faults.push({ error, applied: options.applied ?? false });
    }
    this.#faults.set(method, faults);
  }

  // ---- the feed --------------------------------------------------------------------

  stamp(projectId: string, changes: readonly BoardChange[]): string {
    const seq = (this.#seq.get(projectId) ?? 0) + 1;
    this.#seq.set(projectId, seq);
    this.#log.push({ projectId, seq, changes });
    const batch: BoardFeedBatch = { cursor: this.cursor(projectId), changes };
    if (!this.dropFeed) {
      for (const subscriber of this.#subscribers) {
        if (subscriber.projectId === projectId) this.#deliver(subscriber, batch);
      }
    }
    return batch.cursor;
  }

  #deliver(subscriber: Subscriber, batch: BoardFeedBatch): void {
    const send = (): void => {
      if (subscriber.active) subscriber.handlers.onBatch(batch);
    };
    if (this.latency.feed <= 0) send();
    else setTimeout(send, this.latency.feed);
  }

  changes(projectId: string, lastEventId: string, handlers: FeedHandlers): () => void {
    this.subscriptions.push({ projectId, lastEventId });
    const subscriber: Subscriber = { projectId, handlers, active: true };
    this.#subscribers.add(subscriber);
    // The real feed's resume: every change after the cursor, as ONE batch at
    // the current cursor.
    const after = Number(lastEventId.split(":")[1]);
    const missed = this.#log
      .filter((entry) => entry.projectId === projectId && entry.seq > after)
      .flatMap((entry) => entry.changes);
    if (missed.length > 0) {
      this.#deliver(subscriber, { cursor: this.cursor(projectId), changes: missed });
    }
    return () => {
      subscriber.active = false;
      this.#subscribers.delete(subscriber);
      this.unsubscribes += 1;
    };
  }

  /** Ends every feed of the Workspace with an error, as a dropped link does. */
  breakFeed(projectId: string, error: unknown = new Error("link dropped")): void {
    for (const subscriber of this.#end(projectId)) subscriber.handlers.onError(error);
  }

  /** Ends every feed of the Workspace with "your cursor cannot resume". */
  requireResnapshot(projectId: string): void {
    for (const subscriber of this.#end(projectId)) subscriber.handlers.onResnapshot();
  }

  #end(projectId: string): Subscriber[] {
    const ended = [...this.#subscribers].filter((subscriber) => subscriber.projectId === projectId);
    for (const subscriber of ended) {
      subscriber.active = false;
      this.#subscribers.delete(subscriber);
    }
    return ended;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  // ---- another writer --------------------------------------------------------------------

  /** Another writer moves a card; the feed carries its rows (no commandId). */
  externalMove(projectId: string, id: string, status: TicketStatus, index: number): string {
    const changes = this.#rewrite(projectId, (board) =>
      moveTicket(board, id, status, index, Date.now()),
    );
    return this.stamp(projectId, changes);
  }

  /** Another writer renames a card; the feed carries its row, or (rowless) only that it changed. */
  externalRetitle(projectId: string, id: string, title: string, rowless = false): string {
    const changes = this.#rewrite(projectId, (board) =>
      board.map((row) => (row.id === id ? { ...row, title } : row)),
    );
    if (!rowless) return this.stamp(projectId, changes);
    return this.stamp(projectId, [{ kind: "ticket", op: "upsert", id, projectId }]);
  }

  // ---- the transport -------------------------------------------------------------------

  async #call<Answer>(method: string, input: unknown, act: () => Answer): Promise<Answer> {
    this.calls.push({ method, input, at: Date.now() });
    const latency = { ...this.latency, ...this.methodLatency[method] };
    await sleep(latency.request);
    const fault = this.#faults.get(method)?.shift();
    if (fault !== undefined && !fault.applied) throw fault.error;
    const answer = act();
    await sleep(latency.reply);
    if (fault !== undefined) throw fault.error;
    return answer;
  }

  /**
   * A board write: the receipt answers a repeat from what it recorded, with
   * the current cursor (as the real host does); otherwise the effect applies
   * once and its rows stamp one batch naming the `commandId`.
   */
  #write<Extra extends object>(
    method: string,
    input: { commandId: string },
    effect: () => { projectId: string; changes: BoardChange[]; extra: Extra },
  ): Promise<BoardWriteAnswer & Extra> {
    return this.#call(method, input, () => {
      const prior = this.#receipts.get(input.commandId);
      if (prior !== undefined) {
        return {
          ...prior,
          receipt: { ...prior.receipt, replayed: true },
          throughCursor: this.cursor(prior.projectId as string),
        } as unknown as BoardWriteAnswer & Extra;
      }
      const { projectId, changes, extra } = effect();
      this.effects.set(input.commandId, (this.effects.get(input.commandId) ?? 0) + 1);
      const stamped = changes.map((change) =>
        Object.assign({}, change, { commandId: input.commandId }),
      );
      const throughCursor =
        stamped.length === 0 ? this.cursor(projectId) : this.stamp(projectId, stamped);
      const answer = {
        receipt: { commandId: input.commandId, status: "completed" as const, replayed: false },
        throughCursor,
        ...extra,
      };
      this.#receipts.set(input.commandId, { ...answer, projectId });
      return answer;
    });
  }

  /** Replaces one Workspace's rows; answers a change per row that moved or left. */
  #rewrite(projectId: string, next: (board: Ticket[]) => Ticket[]): BoardChange[] {
    const before = this.board(projectId);
    const after = next(before);
    this.tickets = [...this.tickets.filter((row) => row.projectId !== projectId), ...after];
    const prior = new Map(before.map((row) => [row.id, row]));
    const changes: BoardChange[] = after
      .filter((row) => prior.get(row.id) !== row)
      .map((row) => ({
        kind: "ticket",
        op: "upsert",
        id: row.id,
        projectId,
        ticket: summaryOf(row),
      }));
    const kept = new Set(after.map((row) => row.id));
    for (const row of before) {
      if (!kept.has(row.id)) changes.push({ kind: "ticket", op: "delete", id: row.id, projectId });
    }
    return changes;
  }

  #patch(
    method: string,
    input: { commandId: string; ticketId: string },
    fields: Partial<Ticket>,
  ): Promise<BoardWriteAnswer & { ticket: Ticket }> {
    return this.#write(method, input, () => {
      const target = this.tickets.find((row) => row.id === input.ticketId);
      if (target === undefined) throw new Error("Unknown ticket");
      const defined = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      const changes = this.#rewrite(target.projectId, (board) =>
        board.map((row) => (row.id === target.id ? { ...row, ...defined } : row)),
      );
      const updated = this.tickets.find((row) => row.id === input.ticketId)!;
      return { projectId: target.projectId, changes, extra: { ticket: updated } };
    });
  }

  snapshot(projectId: string): ReturnType<BoardSyncTransport["snapshot"]> {
    return this.#call("snapshot", projectId, () => ({
      project: this.projects.get(projectId)!,
      tickets: this.board(projectId),
      labels: this.labels.filter((row) => row.projectId === projectId),
      cursor: this.cursor(projectId),
    }));
  }

  roster(projectId: string): ReturnType<BoardSyncTransport["roster"]> {
    return this.#call("roster", projectId, () => ({
      tickets: this.board(projectId).map(summaryOf),
      labels: this.labels.filter((row) => row.projectId === projectId),
      cursor: this.cursor(projectId),
    }));
  }

  createTicket(
    input: Parameters<BoardSyncTransport["createTicket"]>[0],
  ): ReturnType<BoardSyncTransport["createTicket"]> {
    return this.#write("createTicket", input, () => {
      const column = this.board(input.projectId).filter((row) => row.status === input.status);
      const created = ticket(`n${this.#nextTicket++}`, input.status, column.length, {
        projectId: input.projectId,
        title: input.title,
        body: input.body ?? "",
        priority: input.priority ?? "medium",
        labels: input.labels ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const changes = this.#rewrite(input.projectId, (board) => [...board, created]);
      return { projectId: input.projectId, changes, extra: { ticket: created } };
    });
  }

  moveTickets(
    input: Parameters<BoardSyncTransport["moveTickets"]>[0],
  ): ReturnType<BoardSyncTransport["moveTickets"]> {
    return this.#write("moveTickets", input, () => ({
      projectId: input.projectId,
      changes: this.#rewrite(input.projectId, (board) =>
        input.ticketIds.length === 1
          ? moveTicket(board, input.ticketIds[0]!, input.toStatus, input.toIndex, Date.now())
          : moveTickets(board, input.ticketIds, input.toStatus, input.toIndex, Date.now()),
      ),
      extra: {},
    }));
  }

  setPriority(
    input: Parameters<BoardSyncTransport["setPriority"]>[0],
  ): ReturnType<BoardSyncTransport["setPriority"]> {
    return this.#patch("setPriority", input, { priority: input.priority });
  }

  updateTicket(
    input: Parameters<BoardSyncTransport["updateTicket"]>[0],
  ): ReturnType<BoardSyncTransport["updateTicket"]> {
    const { commandId: _commandId, ticketId: _ticketId, ...fields } = input;
    return this.#patch("updateTicket", input, fields);
  }

  setLabels(
    input: Parameters<BoardSyncTransport["setLabels"]>[0],
  ): ReturnType<BoardSyncTransport["setLabels"]> {
    return this.#patch("setLabels", input, { labels: input.labels });
  }

  setLabelColor(
    input: Parameters<BoardSyncTransport["setLabelColor"]>[0],
  ): ReturnType<BoardSyncTransport["setLabelColor"]> {
    return this.#write("setLabelColor", input, () => {
      const target = this.labels.find((row) => row.id === input.labelId)!;
      const updated = { ...target, color: input.color };
      this.labels = this.labels.map((row) => (row.id === target.id ? updated : row));
      return {
        projectId: target.projectId,
        changes: [
          {
            kind: "label",
            op: "upsert",
            id: target.id,
            projectId: target.projectId,
            label: updated,
          },
        ],
        extra: { label: updated },
      };
    });
  }

  archiveTicket(
    input: Parameters<BoardSyncTransport["archiveTicket"]>[0],
  ): ReturnType<BoardSyncTransport["archiveTicket"]> {
    return this.#write("archiveTicket", input, () => {
      const target = this.tickets.find((row) => row.id === input.ticketId)!;
      this.archived = [{ ...target, archivedAt: Date.now() }, ...this.archived];
      const changes = this.#rewrite(target.projectId, (board) =>
        board.filter((row) => row.id !== target.id),
      );
      return { projectId: target.projectId, changes, extra: {} };
    });
  }

  unarchiveTicket(
    input: Parameters<BoardSyncTransport["unarchiveTicket"]>[0],
  ): ReturnType<BoardSyncTransport["unarchiveTicket"]> {
    return this.#write("unarchiveTicket", input, () => {
      const target = this.archived.find((row) => row.id === input.ticketId)!;
      this.archived = this.archived.filter((row) => row.id !== target.id);
      const { archivedAt: _archivedAt, ...live } = target;
      const column = this.board(target.projectId).filter((row) => row.status === live.status);
      const revived = { ...live, order: column.length };
      const changes = this.#rewrite(target.projectId, (board) => [...board, revived]);
      return { projectId: target.projectId, changes, extra: { ticket: revived } };
    });
  }

  deleteTicket(
    input: Parameters<BoardSyncTransport["deleteTicket"]>[0],
  ): ReturnType<BoardSyncTransport["deleteTicket"]> {
    return this.#write("deleteTicket", input, () => {
      const target = this.archived.find((row) => row.id === input.ticketId)!;
      this.archived = this.archived.filter((row) => row.id !== target.id);
      return {
        projectId: target.projectId,
        changes: [{ kind: "ticket", op: "delete", id: target.id, projectId: target.projectId }],
        extra: {},
      };
    });
  }

  archivedTickets(projectId: string): Promise<ArchivedTicket[]> {
    return this.#call("archivedTickets", projectId, () =>
      this.archived.filter((row) => row.projectId === projectId),
    );
  }
}

// ---- the view ------------------------------------------------------------------------------

interface Paint {
  readonly projectId: string;
  readonly tickets: Ticket[];
  readonly labels: Label[];
  readonly unloaded: ReadonlySet<string>;
  readonly at: number;
}

function recorder() {
  const paints: Paint[] = [];
  const view = {
    paint: vi.fn<BoardSyncView["paint"]>((projectId, tickets, labels, unloaded) => {
      paints.push({ projectId, tickets, labels, unloaded: new Set(unloaded), at: Date.now() });
    }),
    adoptProject: vi.fn<BoardSyncView["adoptProject"]>(),
    notePlanningChange: vi.fn<BoardSyncView["notePlanningChange"]>(),
    checkoutMoved: vi.fn<BoardSyncView["checkoutMoved"]>(),
    failed: vi.fn<BoardSyncView["failed"]>(),
    unconfirmed: undefined as BoardSyncView["unconfirmed"],
  };
  const last = (projectId = "p1"): Paint => {
    const found = paints.findLast((paint) => paint.projectId === projectId);
    if (found === undefined) throw new Error(`nothing painted for ${projectId}`);
    return found;
  };
  return { paints, view, last };
}

/**
 * A host holding p1's board — backlog A B C, todo D E F, doing G,
 * needs_review H, done I; labels bug and ui — and a sync over it whose
 * command ids are `cmd-1`, `cmd-2`, ….
 */
function harness(options: Partial<BoardSyncOptions> = {}) {
  const host = new FakeHost();
  host.tickets = [
    ticket("A", "backlog", 0),
    ticket("B", "backlog", 1),
    ticket("C", "backlog", 2),
    ticket("D", "todo", 0),
    ticket("E", "todo", 1),
    ticket("F", "todo", 2),
    ticket("G", "doing", 0),
    ticket("H", "needs_review", 0),
    ticket("I", "done", 0),
  ];
  host.labels = [label("bug"), label("ui")];
  const { paints, view, last } = recorder();
  let minted = 0;
  const sync = new BoardSync({
    transport: host,
    view,
    mintCommandId: () => `cmd-${++minted}`,
    ...options,
  });
  return { host, sync, paints, view, last };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- opening ---------------------------------------------------------------------------------

describe("opening a Workspace", () => {
  it("paints nothing until the snapshot lands, then the snapshot, and follows the feed from its cursor", async () => {
    const { host, sync, paints, view, last } = harness();
    host.latency = { request: 50, reply: 50, feed: 0 };

    const opening = sync.open("p1");
    expect(sync.follows("p1")).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(paints).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await opening;

    expect(paints).toHaveLength(1);
    expect(columns(last().tickets)).toEqual({
      backlog: ["A", "B", "C"],
      todo: ["D", "E", "F"],
      doing: ["G"],
      needs_review: ["H"],
      done: ["I"],
    });
    expect(last().tickets.find(({ id }) => id === "A")?.body).toBe("# A");
    expect(last().labels).toEqual([label("bug"), label("ui")]);
    expect(last().unloaded.size).toBe(0);
    expect(view.adoptProject).toHaveBeenCalledWith(project("p1"));
    expect(host.subscriptions).toEqual([{ projectId: "p1", lastEventId: "p1:0" }]);
    expect(sync.follows("p2")).toBe(false);
  });

  it("holds a write made before the snapshot lands until there is a base to paint it over", async () => {
    const { host, sync, paints, last } = harness();
    host.methodLatency.snapshot = { request: 100 };

    const opening = sync.open("p1");
    const move = sync.moveTickets("p1", ["A"], "doing", 0);
    expect(paints).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([opening, move]);

    // The snapshot was read after the write landed: it holds the move, once.
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);
    expect(columns(last().tickets).backlog).toEqual(["B", "C"]);
  });

  it("reports rows whose body it has never read as unloaded, and keeps a body adopted on its own", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    // A row the host only names: the roster carries no body (VC-387).
    host.tickets.push(ticket("Z", "todo", 3));
    host.stamp("p1", [{ kind: "ticket", op: "upsert", id: "Z", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(16);

    expect(last().unloaded).toEqual(new Set(["Z"]));
    expect(last().tickets.find(({ id }) => id === "Z")?.body).toBe("");

    sync.adoptBody("Z", "# Read on its own");
    host.externalRetitle("p1", "Z", "Renamed");

    expect(last().unloaded).toEqual(new Set());
    expect(last().tickets.find(({ id }) => id === "Z")).toMatchObject({
      title: "Renamed",
      body: "# Read on its own",
    });
  });

  it("re-opening re-reads the snapshot, stops the old feed, and retires the edits it confirms", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    host.dropFeed = true;
    await sync.moveTickets("p1", ["A"], "done", 0);
    host.dropFeed = false;
    expect(host.subscriberCount).toBe(1);

    await sync.open("p1");

    expect(host.unsubscribes).toBe(1);
    expect(host.subscriberCount).toBe(1);
    expect(host.subscriptions.at(-1)).toEqual({ projectId: "p1", lastEventId: "p1:1" });
    // Retired by the snapshot: another writer's later move shows through.
    host.externalMove("p1", "A", "backlog", 0);
    expect(placement(last().tickets, "A")).toBe("backlog#0");
  });
});

// ---- the pending layer ---------------------------------------------------------------------

describe("pending writes (T5)", () => {
  it("paints an edit the moment it is made, before any answer", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency = { request: 100, reply: 100, feed: 100 };

    const move = sync.moveTickets("p1", ["A"], "doing", 1);

    expect(columns(last().tickets)).toMatchObject({ backlog: ["B", "C"], doing: ["G", "A"] });
    expect(host.callsTo("moveTickets")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    await move;
  });

  it("keeps the edit over the base until the feed delivers its cursor, not on the reply alone", async () => {
    const { host, sync, paints, last } = harness();
    await sync.open("p1");
    host.latency = { request: 0, reply: 0, feed: 200 };
    // Another writer's change, stamped before ours, still travelling on the feed.
    host.externalRetitle("p1", "D", "Renamed elsewhere");
    await vi.advanceTimersByTimeAsync(10);

    await sync.moveTickets("p1", ["A"], "doing", 0);
    const afterReply = paints.length;
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);

    // t=200: the other writer's batch lands; ours (t=210) has not.
    await vi.advanceTimersByTimeAsync(195);
    expect(paints.length).toBe(afterReply + 1);
    expect(last().tickets.find(({ id }) => id === "D")?.title).toBe("Renamed elsewhere");
    // The base still holds A in backlog: the edit replayed over it, no rubber band.
    expect(columns(last().tickets)).toMatchObject({ backlog: ["B", "C"], doing: ["A", "G"] });

    // t=210: our cursor lands. The edit is retired: another writer's later
    // move of the same card now shows through instead of being overridden.
    await vi.advanceTimersByTimeAsync(10);
    host.latency.feed = 0;
    host.externalMove("p1", "A", "done", 1);
    expect(columns(last().tickets)).toMatchObject({ doing: ["G"], done: ["I", "A"] });
    expect(host.callsTo("roster")).toEqual([]);
  });

  it("retires the edit on its reply when the feed delivered the cursor first", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency = { request: 0, reply: 100, feed: 0 };

    const move = sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(100);
    await move;

    host.externalMove("p1", "A", "done", 0);
    expect(placement(last().tickets, "A")).toBe("done#0");
    // Nothing left waiting for a confirming read.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.callsTo("roster")).toEqual([]);
  });

  it("retires a no-op write at once: its cursor is one the feed already delivered", async () => {
    const { host, sync } = harness();
    await sync.open("p1");

    await sync.moveTickets("p1", ["A"], "backlog", 0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.callsTo("roster")).toEqual([]);
  });

  it("confirms with one roster read when the feed has not delivered the cursor in time", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 1_000 });
    await sync.open("p1");
    host.dropFeed = true;

    await sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(999);
    expect(host.callsTo("roster")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + 16);

    expect(host.callsTo("roster")).toHaveLength(1);
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);
    // Retired by the read (it started after the reply): the host's word wins now.
    host.dropFeed = false;
    host.externalMove("p1", "A", "todo", 0);
    expect(placement(last().tickets, "A")).toBe("todo#0");
  });

  it("retires on the cursor when it lands after the confirm timer fired, before its read answers", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 1_000 });
    await sync.open("p1");
    host.latency.feed = 1_100;
    host.methodLatency.roster = { request: 0, reply: 500 };

    await sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(1_016);
    expect(host.callsTo("roster")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(84);

    // Retired by its cursor: another writer's move of the card shows through.
    host.latency.feed = 0;
    host.externalMove("p1", "A", "done", 0);
    expect(placement(last().tickets, "A")).toBe("done#0");
    await vi.advanceTimersByTimeAsync(500);
    expect(placement(last().tickets, "A")).toBe("done#0");
  });

  it("leaves another Workspace's pending edits alone when a batch lands", async () => {
    const { host, sync, last } = harness();
    host.projects.set("p2", project("p2"));
    host.tickets.push(ticket("X", "todo", 0, { projectId: "p2" }));
    await sync.open("p1");
    await sync.open("p2");
    host.latency.request = 50;

    const write = sync.setPriority("p2", "X", "high");
    host.externalMove("p1", "A", "done", 0);

    expect(last("p2").tickets[0]?.priority).toBe("high");
    await vi.advanceTimersByTimeAsync(50);
    await write;
    expect(last("p2").tickets[0]?.priority).toBe("high");
  });

  it("retires a write on its reply however many batches the feed delivered since its cursor", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 1_000 });
    await sync.open("p1");
    host.latency.reply = 10;

    // A write whose cursor the feed delivers, then 600 more batches before its reply.
    const move = sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 600; i++) {
      host.stamp("p1", [
        { kind: "comment", op: "upsert", id: `c${i}`, projectId: "p1", ticketId: "B" },
      ]);
    }
    await vi.advanceTimersByTimeAsync(10);
    await move;

    // The base is past its cursor: retired at once, with no read to confirm it.
    await vi.advanceTimersByTimeAsync(1_000 + 16);
    expect(host.callsTo("roster")).toEqual([]);
    host.externalMove("p1", "A", "todo", 0);
    expect(placement(last().tickets, "A")).toBe("todo#0");
  });

  it("does not let a read that started before the reply retire the edit", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 300 };
    host.methodLatency.moveTickets = { request: 100, reply: 0 };
    host.latency.feed = 500;
    // A rowless change starts a read that captures the board before the move.
    host.externalRetitle("p1", "H", "Elsewhere", true);
    await vi.advanceTimersByTimeAsync(500 + 16);
    expect(host.callsTo("roster")).toHaveLength(1);

    const move = sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(100);
    await move;
    // The read (started before the reply) lands with A still in backlog.
    await vi.advanceTimersByTimeAsync(200);
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);
    expect(last().tickets.find(({ id }) => id === "H")?.title).toBe("Elsewhere");
  });

  it("retries an ambiguous failure under the same commandId; the host applies it once", async () => {
    const { host, sync, view, last } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    // The host took the write; its answer was lost, and so was its feed row.
    host.fail("moveTickets", unreachable, { applied: true });
    host.dropFeed = true;

    const move = sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(100);
    await move;

    const sent = host
      .callsTo("moveTickets")
      .map(({ input }) => (input as { commandId: string }).commandId);
    expect(sent).toEqual(["cmd-1", "cmd-1"]);
    expect(host.effects.get("cmd-1")).toBe(1);
    expect(view.failed).not.toHaveBeenCalled();
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);
    expect(columns(host.board("p1")).doing).toEqual(["A", "G"]);
  });

  it("settles on the feed's proof without a retry when only the reply was lost", async () => {
    const { host, sync, view, last } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    host.fail("moveTickets", unreachable, { applied: true });

    await sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(1_000);

    // The feed named cmd-1 as the host applied it: that is the proof.
    expect(host.callsTo("moveTickets")).toHaveLength(1);
    expect(host.effects.get("cmd-1")).toBe(1);
    expect(view.failed).not.toHaveBeenCalled();
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);
    host.externalMove("p1", "A", "todo", 0);
    expect(placement(last().tickets, "A")).toBe("todo#0");
  });

  it("retries a failure with no host envelope (a dead bridge) until the host takes it", async () => {
    const { host, sync, view } = harness({ retryDelaysMs: [10, 20] });
    await sync.open("p1");
    host.fail("setPriority", new Error("bridge gone"), { times: 2 });

    const write = sync.setPriority("p1", "A", "high");
    await vi.advanceTimersByTimeAsync(10);
    expect(host.callsTo("setPriority")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20);
    await write;

    expect(host.callsTo("setPriority")).toHaveLength(3);
    expect(host.effects.get("cmd-1")).toBe(1);
    expect(view.failed).not.toHaveBeenCalled();
  });

  it("drops the edit and says why on a definitive refusal", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    host.fail("moveTickets", conflict);

    await sync.moveTickets("p1", ["A"], "doing", 0);

    expect(host.callsTo("moveTickets")).toHaveLength(1);
    expect(view.failed).toHaveBeenCalledWith("Couldn't move ticket: stale board");
    expect(columns(last().tickets)).toMatchObject({ backlog: ["A", "B", "C"], doing: ["G"] });
  });

  it("names a group move, and reads the message off an Error or anything else thrown", async () => {
    const { host, sync, view } = harness({ isAmbiguous: () => false });
    await sync.open("p1");
    host.fail("moveTickets", new Error("db locked"));
    host.fail("setLabels", "no labels today");

    await sync.moveTickets("p1", ["A", "B"], "todo", 0);
    await sync.setLabels("p1", "A", ["bug"]);

    expect(view.failed).toHaveBeenNthCalledWith(1, "Couldn't move tickets: db locked");
    expect(view.failed).toHaveBeenNthCalledWith(2, "Couldn't update labels: no labels today");
  });

  it("never gives up on an unknown outcome: it keeps sending, says so once, and never reverts", async () => {
    const unconfirmed = vi.fn();
    const { host, sync, view, last } = harness({ retryDelaysMs: [10, 20], maxAttempts: 4 });
    view.unconfirmed = unconfirmed;
    await sync.open("p1");
    host.fail("setPriority", unreachable, { times: 10 });

    const write = sync.setPriority("p1", "A", "high");
    let settled = false;
    void write.then(() => (settled = true));
    expect(last().tickets.find(({ id }) => id === "A")?.priority).toBe("high");
    await vi.advanceTimersByTimeAsync(10 + 20 + 20);
    expect(host.callsTo("setPriority")).toHaveLength(4);
    expect(unconfirmed).toHaveBeenCalledExactlyOnceWith(
      "Still trying to update priority: host-unreachable",
    );
    // Past its attempts: the last delay repeats, the edit stays, nothing failed.
    await vi.advanceTimersByTimeAsync(20 * 6);
    expect(host.callsTo("setPriority")).toHaveLength(10);
    expect(settled).toBe(false);
    expect(last().tickets.find(({ id }) => id === "A")?.priority).toBe("high");
    expect(view.failed).not.toHaveBeenCalled();
    // The host comes back: the next send lands, under the same id.
    await vi.advanceTimersByTimeAsync(20);
    await write;
    const times = host.callsTo("setPriority").map(({ at }) => at);
    expect(times.slice(1).map((at, index) => at - times[index]!)).toEqual([
      10, 20, 20, 20, 20, 20, 20, 20, 20, 20,
    ]);
    expect(
      new Set(
        host.callsTo("setPriority").map(({ input }) => (input as { commandId: string }).commandId),
      ),
    ).toEqual(new Set(["cmd-1"]));
    expect(host.effects.get("cmd-1")).toBe(1);
    expect(unconfirmed).toHaveBeenCalledTimes(1);
  });

  it("does not retry a write whose Workspace closed while it was in flight, and paints nothing", async () => {
    const { host, sync, view, paints } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    host.latency.request = 50;
    host.fail("moveTickets", unreachable);

    const move = sync.moveTickets("p1", ["A"], "doing", 0);
    sync.close("p1");
    const painted = paints.length;
    await vi.advanceTimersByTimeAsync(50 + 100);
    await move;

    expect(host.callsTo("moveTickets")).toHaveLength(1);
    expect(paints.length).toBe(painted);
    expect(view.failed).toHaveBeenCalledWith("Couldn't move ticket: host-unreachable");
  });

  it("answers a write to a Workspace it does not follow, painting nothing", async () => {
    const { host, sync, paints } = harness();
    host.projects.set("p2", project("p2"));
    host.tickets.push(ticket("X", "todo", 0, { projectId: "p2" }));

    await sync.setPriority("p2", "X", "low");

    expect(paints).toEqual([]);
    expect(host.board("p2")[0]?.priority).toBe("low");
  });

  it("a confirm timer that fires after its edit retired reads nothing", async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const { host, sync } = harness({
      confirmTimeoutMs: 1_000,
      // A clear that loses the race: the timer still fires.
      setTimer: (run, ms) => timers.push({ run, ms }),
      clearTimer: () => {},
    });
    await sync.open("p1");
    host.latency.feed = 100;
    await sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(100);

    for (const timer of timers) timer.run();

    expect(timers.map(({ ms }) => ms)).toEqual([1_000]);
    expect(host.callsTo("roster")).toEqual([]);
  });
});

// ---- each write -------------------------------------------------------------------------------

describe("each write", () => {
  it("shows a created ticket at once as a placeholder, then the confirmed row in its place", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency = { request: 50, reply: 50, feed: 0 };

    const creating = sync.createTicket("p1", { status: "todo", title: "New one" });

    const placeholder = last().tickets.find(({ id }) => id === placeholderTicketId("cmd-1"));
    expect(placeholder).toMatchObject({
      projectId: "p1",
      ticketNumber: 0,
      title: "New one",
      body: "",
      status: "todo",
      priority: "medium",
      labels: [],
      usesWorktree: true,
      preferredHarnessId: "claude-code",
      order: 3,
      baseBranch: null,
    });
    expect(columns(last().tickets).todo).toEqual(["D", "E", "F", "pending:cmd-1"]);

    // The feed delivers the confirmed row as the host applies it.
    await vi.advanceTimersByTimeAsync(50);
    expect(columns(last().tickets).todo).toEqual(["D", "E", "F", "n1"]);
    await vi.advanceTimersByTimeAsync(50);
    const created = await creating;

    expect(created).toEqual(host.board("p1").find(({ id }) => id === "n1"));
    // Its body is known: it came back with the reply.
    host.externalRetitle("p1", "n1", "Renamed");
    expect(last().unloaded.has("n1")).toBe(false);
  });

  it("carries every field a create names onto its placeholder", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency.request = 10;

    const creating = sync.createTicket("p1", {
      status: "needs_review",
      title: "Full",
      body: "# Body",
      priority: "high",
      labels: ["bug"],
      usesWorktree: false,
      preferredHarnessId: "codex",
      baseBranch: "main",
    });

    expect(last().tickets.find(({ id }) => id === "pending:cmd-1")).toMatchObject({
      body: "# Body",
      priority: "high",
      labels: ["bug"],
      usesWorktree: false,
      preferredHarnessId: "codex",
      baseBranch: "main",
      order: 1,
    });
    await vi.advanceTimersByTimeAsync(10);
    await creating;
  });

  it("drops the placeholder and resolves null when the create is refused", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    host.fail("createTicket", conflict);

    expect(await sync.createTicket("p1", { status: "todo", title: "No" })).toBeNull();

    expect(columns(last().tickets).todo).toEqual(["D", "E", "F"]);
    expect(view.failed).toHaveBeenCalledWith("Couldn't create ticket: stale board");
  });

  it("moves a group as one command, passing a deliberate choice through", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");

    await sync.moveTickets("p1", ["A", "D"], "doing", 1, { kind: "move-only" });

    expect(host.callsTo("moveTickets")[0]?.input).toEqual({
      commandId: "cmd-1",
      projectId: "p1",
      ticketIds: ["A", "D"],
      toStatus: "doing",
      toIndex: 1,
      choice: { kind: "move-only" },
    });
    expect(columns(last().tickets).doing).toEqual(["G", "A", "D"]);
    expect(columns(last().tickets)).toEqual(columns(host.board("p1")));
  });

  it("sets priority and labels on the card at once, and the host agrees", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency.request = 10;

    const priority = sync.setPriority("p1", "B", "high");
    const labels = sync.setLabels("p1", "B", ["bug", "ui"]);
    expect(last().tickets.find(({ id }) => id === "B")).toMatchObject({
      priority: "high",
      labels: ["bug", "ui"],
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([priority, labels]);

    expect(host.board("p1").find(({ id }) => id === "B")).toMatchObject({
      priority: "high",
      labels: ["bug", "ui"],
    });
    expect(last().tickets).toEqual(host.board("p1"));
  });

  it("updates only the fields it names, resolves the updated ticket, and keeps its new body", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency.request = 10;

    const updating = sync.updateTicket("p1", {
      ticketId: "C",
      title: "Retitled",
      body: "# New body",
      branch: undefined,
    });
    expect(last().tickets.find(({ id }) => id === "C")).toMatchObject({
      title: "Retitled",
      body: "# New body",
      branch: null,
    });
    await vi.advanceTimersByTimeAsync(10);
    const updated = await updating;

    expect(updated).toMatchObject({ id: "C", title: "Retitled", body: "# New body" });
    // A later roster read carries no body: the one the update returned stays.
    host.externalRetitle("p1", "C", "Again", true);
    await vi.advanceTimersByTimeAsync(16 + 10);
    expect(host.callsTo("roster")).toHaveLength(1);
    expect(last().tickets.find(({ id }) => id === "C")).toMatchObject({
      title: "Again",
      body: "# New body",
    });
  });

  it("resolves null when an update is refused", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");
    host.fail("updateTicket", conflict);

    expect(await sync.updateTicket("p1", { ticketId: "C", title: "No" })).toBeNull();
    expect(view.failed).toHaveBeenCalledWith("Couldn't update ticket: stale board");
  });

  it("recolors a label at once and reverts it on a refusal", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    host.latency.request = 10;

    const recolor = sync.setLabelColor("p1", "bug", "#f00");
    expect(last().labels).toEqual([{ ...label("bug"), color: "#f00" }, label("ui")]);
    await vi.advanceTimersByTimeAsync(10);
    await recolor;
    expect(last().labels).toEqual(host.labels);

    host.fail("setLabelColor", conflict);
    const refused = sync.setLabelColor("p1", "ui", "#0f0");
    expect(last().labels[1]?.color).toBe("#0f0");
    await vi.advanceTimersByTimeAsync(10);
    await refused;
    expect(last().labels[1]?.color).toBeNull();
    expect(view.failed).toHaveBeenCalledWith("Couldn't update label color: stale board");
  });

  it("takes an archived card off the board at once and resolves whether it was accepted", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    host.latency.request = 10;

    const archiving = sync.archiveTicket("p1", "E");
    expect(columns(last().tickets).todo).toEqual(["D", "F"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await archiving).toBe(true);
    expect(host.archived.map(({ id }) => id)).toEqual(["E"]);

    host.fail("archiveTicket", conflict);
    const refused = sync.archiveTicket("p1", "F");
    expect(columns(last().tickets).todo).toEqual(["D"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await refused).toBe(false);
    expect(columns(last().tickets).todo).toEqual(["D", "F"]);
    expect(view.failed).toHaveBeenCalledWith("Couldn't archive ticket: stale board");
  });

  it("shows an unarchived card at once, appended to its column, and resolves the live ticket", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    const archived = { ...ticket("Q", "doing", 7), archivedAt: 5 };
    host.archived = [archived];
    host.latency.request = 10;

    const reviving = sync.unarchiveTicket("p1", archived);
    expect(last().tickets.find(({ id }) => id === "Q")).toEqual({ ...ticket("Q", "doing", 1) });
    await vi.advanceTimersByTimeAsync(10);
    const revived = await reviving;

    expect(revived).toEqual(ticket("Q", "doing", 1));
    expect(columns(last().tickets).doing).toEqual(["G", "Q"]);

    host.latency.request = 0;
    host.fail("unarchiveTicket", conflict);
    expect(
      await sync.unarchiveTicket("p1", { ...ticket("R", "todo", 0), archivedAt: 1 }),
    ).toBeNull();
    expect(view.failed).toHaveBeenCalledWith("Couldn't unarchive ticket: stale board");
    expect(placement(last().tickets, "R")).toBe("absent");
  });

  it("does not show an unarchived card twice when the board already holds it", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.latency.request = 10;
    host.fail("unarchiveTicket", conflict);

    const reviving = sync.unarchiveTicket("p1", { ...ticket("G", "doing", 0), archivedAt: 1 });

    expect(columns(last().tickets).doing).toEqual(["G"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await reviving).toBeNull();
    expect(columns(last().tickets).doing).toEqual(["G"]);
  });

  it("deletes an archived ticket and resolves whether it was accepted", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");
    host.archived = [{ ...ticket("Q", "done", 0), archivedAt: 1 }];

    expect(await sync.deleteTicket("p1", "Q")).toBe(true);
    expect(host.archived).toEqual([]);

    host.fail("deleteTicket", conflict);
    expect(await sync.deleteTicket("p1", "Q")).toBe(false);
    expect(view.failed).toHaveBeenCalledWith("Couldn't delete ticket: stale board");
  });

  it("counts a retried delete the host no longer finds as done: its first answer was lost", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");
    host.archived = [{ ...ticket("Q", "done", 0), archivedAt: 1 }];
    // The delete lands, its answer is lost, and the retry names a ticket that
    // is gone (a WebSocket host refuses an absent resource before any receipt).
    host.fail("deleteTicket", unreachable, { applied: true });
    host.fail("deleteTicket", notFound);
    const deleting = sync.deleteTicket("p1", "Q");
    await vi.advanceTimersByTimeAsync(250);

    expect(await deleting).toBe(true);
    expect(host.archived).toEqual([]);
    expect(view.failed).not.toHaveBeenCalled();

    // A first attempt that finds nothing is a refusal, as it always was.
    host.fail("deleteTicket", notFound);
    expect(await sync.deleteTicket("p1", "Q")).toBe(false);
    expect(view.failed).toHaveBeenCalledWith(
      "Couldn't delete ticket: Not found in this Workspace.",
    );
  });

  it("reads the archive, and says so when the read fails", async () => {
    const { host, sync, view } = harness();
    host.archived = [{ ...ticket("Q", "done", 0), archivedAt: 1 }];

    expect(await sync.archivedTickets("p1")).toEqual(host.archived);

    host.fail("archivedTickets", conflict);
    expect(await sync.archivedTickets("p1")).toBeNull();
    expect(view.failed).toHaveBeenCalledWith("Couldn't load archive: stale board");
  });
});

// ---- the feed --------------------------------------------------------------------------------

describe("the change feed", () => {
  it("applies rows, labels and tombstones another writer stamped", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");

    host.externalMove("p1", "C", "done", 0);
    host.stamp("p1", [
      { kind: "label", op: "upsert", id: "new", projectId: "p1", label: label("new") },
      { kind: "label", op: "delete", id: "ui", projectId: "p1" },
      { kind: "ticket", op: "delete", id: "I", projectId: "p1" },
    ]);

    expect(columns(last().tickets)).toMatchObject({ backlog: ["A", "B"], done: ["C"] });
    expect(last().labels.map(({ id }) => id)).toEqual(["bug", "new"]);
    // A row with no commandId is another writer's: per-ticket surfaces re-read.
    expect(view.notePlanningChange).toHaveBeenCalledWith({ ticketId: "C", projectId: "p1" });
    expect(host.callsTo("roster")).toEqual([]);
  });

  it("does not ask per-ticket surfaces to re-read for a row its own command stamped", async () => {
    const { sync, view } = harness();
    await sync.open("p1");

    await sync.moveTickets("p1", ["A"], "doing", 0);

    expect(view.notePlanningChange).not.toHaveBeenCalled();
  });

  it("tells per-ticket surfaces about comments and ticket events, painting no board change", async () => {
    const { host, sync, view, paints } = harness();
    await sync.open("p1");
    const before = paints.at(-1)!;

    host.stamp("p1", [
      { kind: "comment", op: "upsert", id: "c1", projectId: "p1", ticketId: "A" },
      { kind: "ticketEvent", op: "upsert", id: "B", projectId: "p1", ticketId: "B" },
    ]);

    expect(view.notePlanningChange.mock.calls).toEqual([
      [{ ticketId: "A", projectId: "p1" }],
      [{ ticketId: "B", projectId: "p1" }],
    ]);
    expect(paints.at(-1)?.tickets).toEqual(before.tickets);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.callsTo("roster")).toEqual([]);
  });

  it("says a ticket's checkout moved", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");

    host.stamp("p1", [
      { kind: "ticket", op: "upsert", id: "A", projectId: "p1", checkoutMoved: true },
    ]);

    expect(view.checkoutMoved).toHaveBeenCalledWith("A");
  });

  it("adopts a project row, and reads the snapshot for a project change without one", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");
    const renamed = { ...project("p1"), name: "Renamed" };

    host.stamp("p1", [
      { kind: "project", op: "upsert", id: "p1", projectId: "p1", project: renamed },
    ]);
    expect(view.adoptProject).toHaveBeenLastCalledWith(renamed);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.callsTo("roster")).toEqual([]);

    // Relinked elsewhere, announced without its row: the snapshot carries it.
    host.projects.set("p1", { ...project("p1"), path: "/relinked" });
    host.stamp("p1", [{ kind: "project", op: "upsert", id: "p1", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(16);
    expect(host.callsTo("roster")).toEqual([]);
    expect(host.callsTo("snapshot")).toHaveLength(2);
    expect(view.adoptProject).toHaveBeenLastCalledWith({ ...project("p1"), path: "/relinked" });
  });

  it("ignores a change kind this build does not know", async () => {
    const { host, sync, view, paints } = harness();
    await sync.open("p1");
    const before = paints.at(-1)!;

    host.stamp("p1", [
      { kind: "automation", op: "upsert", id: "x", projectId: "p1" } as unknown as BoardChange,
    ]);
    await vi.advanceTimersByTimeAsync(100);

    expect(paints.at(-1)?.tickets).toEqual(before.tickets);
    expect(host.callsTo("roster")).toEqual([]);
    expect(view.notePlanningChange).not.toHaveBeenCalled();
    expect(view.failed).not.toHaveBeenCalled();
  });

  it("re-reads a label change that carries no row", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.labels = [...host.labels, label("docs")];

    host.stamp("p1", [{ kind: "label", op: "upsert", id: "docs", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(16);

    expect(last().labels.map(({ id }) => id)).toEqual(["bug", "ui", "docs"]);
  });

  it("re-opens on a resnapshot, retiring the edits the new snapshot holds", async () => {
    const { host, sync, view, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    host.dropFeed = true;
    await sync.moveTickets("p1", ["A"], "doing", 0);
    host.dropFeed = false;

    host.requireResnapshot("p1");
    await vi.advanceTimersByTimeAsync(0);

    expect(host.callsTo("snapshot")).toHaveLength(2);
    expect(view.adoptProject).toHaveBeenCalledTimes(2);
    expect(host.subscriptions.at(-1)).toEqual({ projectId: "p1", lastEventId: "p1:1" });
    host.externalMove("p1", "A", "todo", 0);
    expect(placement(last().tickets, "A")).toBe("todo#0");
  });

  it("retires a create the snapshot already holds, though the resumed feed never names it", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    // The create commits at 10 ms and answers at 210 ms; the resnapshot's read
    // lands between, so it holds the row, and its feed resumes after it.
    host.methodLatency["createTicket"] = { request: 10, reply: 200 };
    host.methodLatency["snapshot"] = { request: 50, reply: 0 };
    host.dropFeed = true;
    const creating = sync.createTicket("p1", { status: "todo", title: "Held" });
    host.requireResnapshot("p1");
    await vi.advanceTimersByTimeAsync(12);
    // Another write after it, before the read: the write's own cursor is not
    // the snapshot's, so only its row says the snapshot holds it.
    host.externalRetitle("p1", "D", "Elsewhere");
    await vi.advanceTimersByTimeAsync(8);
    host.dropFeed = false;
    await vi.advanceTimersByTimeAsync(200);
    const created = await creating;

    expect(created?.title).toBe("Held");
    const todo = columns(last().tickets).todo;
    expect(todo.filter((id) => id === created!.id)).toHaveLength(1);
    expect(todo.some((id) => id.startsWith("pending:"))).toBe(false);
  });

  it("retries a resnapshot whose snapshot read failed, following from the last cursor", async () => {
    const { host, sync } = harness({ feedRetryDelaysMs: [100] });
    await sync.open("p1");
    host.fail("snapshot", unreachable);

    host.requireResnapshot("p1");
    await vi.advanceTimersByTimeAsync(99);
    expect(host.subscriptions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(host.subscriptions).toEqual([
      { projectId: "p1", lastEventId: "p1:0" },
      { projectId: "p1", lastEventId: "p1:0" },
    ]);
  });

  it("re-subscribes from the last cursor after a feed error, catching up on what it missed", async () => {
    const { host, sync, last } = harness({ feedRetryDelaysMs: [100, 300] });
    await sync.open("p1");
    host.externalMove("p1", "A", "doing", 0);

    host.breakFeed("p1");
    host.externalMove("p1", "B", "doing", 0);
    expect(placement(last().tickets, "B")).toBe("backlog#0");
    await vi.advanceTimersByTimeAsync(99);
    expect(host.subscriptions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(host.subscriptions.at(-1)).toEqual({ projectId: "p1", lastEventId: "p1:1" });
    expect(columns(last().tickets).doing).toEqual(["B", "A", "G"]);
  });

  it("backs off further while the feed keeps failing, and starts over once a batch lands", async () => {
    const { host, sync } = harness({ feedRetryDelaysMs: [100, 300] });
    await sync.open("p1");

    host.breakFeed("p1");
    await vi.advanceTimersByTimeAsync(100);
    host.breakFeed("p1");
    await vi.advanceTimersByTimeAsync(299);
    expect(host.subscriptions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.subscriptions).toHaveLength(3);
    // The last delay repeats.
    host.breakFeed("p1");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.subscriptions).toHaveLength(4);

    // A delivered batch resets the back-off.
    host.externalMove("p1", "A", "doing", 0);
    host.breakFeed("p1");
    await vi.advanceTimersByTimeAsync(100);
    expect(host.subscriptions).toHaveLength(5);
  });

  it("does not follow twice when the Workspace re-opened before the retry", async () => {
    const { host, sync } = harness({ feedRetryDelaysMs: [100] });
    await sync.open("p1");

    host.breakFeed("p1");
    await sync.open("p1");
    await vi.advanceTimersByTimeAsync(100);

    expect(host.subscriptions).toHaveLength(2);
    expect(host.subscriberCount).toBe(1);
  });
});

// ---- reads -----------------------------------------------------------------------------------

describe("roster reads", () => {
  it("reads once for a burst of rowless changes", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");

    host.externalRetitle("p1", "A", "One", true);
    await vi.advanceTimersByTimeAsync(5);
    host.externalRetitle("p1", "B", "Two", true);
    await vi.advanceTimersByTimeAsync(5);
    host.externalRetitle("p1", "C", "Three", true);
    await vi.advanceTimersByTimeAsync(100);

    expect(host.callsTo("roster")).toHaveLength(1);
    expect(
      last()
        .tickets.slice(0, 3)
        .map(({ title }) => title),
    ).toEqual(["One", "Two", "Three"]);
    expect(view.notePlanningChange).toHaveBeenCalledTimes(3);
  });

  it("runs one read at a time with at most one queued behind it", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 200 };

    host.externalRetitle("p1", "A", "One", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(host.callsTo("roster")).toHaveLength(1);
    // Three more while the first is in flight: one more read, after it.
    host.externalRetitle("p1", "B", "Two", true);
    await vi.advanceTimersByTimeAsync(50);
    host.externalRetitle("p1", "C", "Three", true);
    host.externalRetitle("p1", "D", "Four", true);
    await vi.advanceTimersByTimeAsync(149);
    expect(host.callsTo("roster")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + 16);
    expect(host.callsTo("roster")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(host.callsTo("roster")).toHaveLength(2);
    expect(last().tickets.find(({ id }) => id === "D")?.title).toBe("Four");
  });

  it("replays what the feed delivered during a slow read over its older answer", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    // The read captures the board at once and answers 300 ms later.
    host.methodLatency.roster = { request: 0, reply: 300 };
    host.externalRetitle("p1", "A", "Rowless", true);
    await vi.advanceTimersByTimeAsync(16);

    // Newer rows, of every kind, land while it is in flight.
    host.externalMove("p1", "B", "done", 0);
    host.stamp("p1", [
      { kind: "label", op: "upsert", id: "new", projectId: "p1", label: label("new") },
      { kind: "label", op: "delete", id: "ui", projectId: "p1" },
      { kind: "ticket", op: "delete", id: "C", projectId: "p1" },
      { kind: "ticket", op: "upsert", id: "D", projectId: "p1", checkoutMoved: true },
      { kind: "project", op: "upsert", id: "p1", projectId: "p1", project: project("p1") },
      { kind: "comment", op: "upsert", id: "c", projectId: "p1", ticketId: "E" },
      { kind: "automation", op: "upsert", id: "x", projectId: "p1" } as unknown as BoardChange,
    ]);
    host.tickets = host.tickets.filter(({ id }) => id !== "C");
    const noted = view.notePlanningChange.mock.calls.length;
    const checkouts = view.checkoutMoved.mock.calls.length;
    const adopted = view.adoptProject.mock.calls.length;
    expect(columns(last().tickets).done).toEqual(["B", "I"]);
    await vi.advanceTimersByTimeAsync(300);

    // The read's answer is older than B's move: the move still shows.
    expect(columns(last().tickets)).toMatchObject({ backlog: ["A"], done: ["B", "I"] });
    expect(last().tickets.find(({ id }) => id === "A")?.title).toBe("Rowless");
    expect(last().labels.map(({ id }) => id)).toEqual(["bug", "new"]);
    // A replay tells nobody anything twice.
    expect(view.notePlanningChange.mock.calls.length).toBe(noted);
    expect(view.checkoutMoved.mock.calls.length).toBe(checkouts);
    expect(view.adoptProject.mock.calls.length).toBe(adopted);
    // The rowless D asked for a read of its own, after this one.
    await vi.advanceTimersByTimeAsync(16);
    expect(host.callsTo("roster")).toHaveLength(2);
  });

  it("says once when a read fails, and reads again with backoff until one lands", async () => {
    const { host, sync, view, last } = harness({ feedRetryDelaysMs: [250, 1_000] });
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 100 };
    host.fail("roster", conflict, { applied: true, times: 2 });

    host.externalRetitle("p1", "A", "One", true);
    await vi.advanceTimersByTimeAsync(16);
    host.externalRetitle("p1", "B", "Two", true);
    await vi.advanceTimersByTimeAsync(100);
    expect(view.failed).toHaveBeenCalledExactlyOnceWith("Couldn't refresh the board: stale board");
    await vi.advanceTimersByTimeAsync(249);
    expect(host.callsTo("roster")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + 100 + 1_000 + 100);

    expect(host.callsTo("roster")).toHaveLength(3);
    expect(view.failed).toHaveBeenCalledTimes(1);
    expect(
      last()
        .tickets.slice(0, 2)
        .map(({ title }) => title),
    ).toEqual(["One", "Two"]);
  });
});

// ---- closing ---------------------------------------------------------------------------------

describe("closing", () => {
  it("stops the feed, drops that Workspace's pending edits, and leaves the others alone", async () => {
    const { host, sync, paints, last } = harness();
    host.projects.set("p2", project("p2"));
    host.tickets.push(ticket("X", "todo", 0, { projectId: "p2" }));
    await sync.open("p1");
    await sync.open("p2");
    host.latency.request = 50;

    const p1Move = sync.moveTickets("p1", ["A"], "doing", 0);
    const p2Write = sync.setPriority("p2", "X", "high");
    sync.close("p1");
    sync.close("p1");
    const painted = paints.filter(({ projectId }) => projectId === "p1").length;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([p1Move, p2Write]);

    expect(sync.follows("p1")).toBe(false);
    expect(host.unsubscribes).toBe(1);
    expect(paints.filter(({ projectId }) => projectId === "p1")).toHaveLength(painted);
    expect(last("p2").tickets[0]?.priority).toBe("high");
  });

  it("drops an edit still waiting for its cursor", async () => {
    const { host, sync, paints } = harness({ confirmTimeoutMs: 1_000 });
    await sync.open("p1");
    host.latency.feed = 100;
    await sync.moveTickets("p1", ["A"], "doing", 0);

    sync.close("p1");
    const painted = paints.length;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(host.callsTo("roster")).toEqual([]);
    expect(paints).toHaveLength(painted);
  });

  it("clears a read waiting to start and never paints a read that lands after", async () => {
    const { host, sync, paints } = harness();
    await sync.open("p1");
    host.externalRetitle("p1", "A", "One", true);
    sync.close("p1");
    await vi.advanceTimersByTimeAsync(100);
    expect(host.callsTo("roster")).toEqual([]);

    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 100 };
    host.externalRetitle("p1", "A", "Two", true);
    await vi.advanceTimersByTimeAsync(16);
    host.externalRetitle("p1", "B", "Three", true);
    const painted = paints.length;
    sync.close("p1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(host.callsTo("roster")).toHaveLength(1);
    expect(paints).toHaveLength(painted);
  });

  it("never paints a snapshot that lands after the Workspace closed", async () => {
    const { host, sync, paints, view } = harness();
    host.latency.request = 50;

    const opening = sync.open("p1");
    sync.close("p1");
    await vi.advanceTimersByTimeAsync(50);
    await opening;

    expect(paints).toEqual([]);
    expect(view.adoptProject).not.toHaveBeenCalled();
    expect(host.subscriptions).toEqual([]);
  });

  it("closes every Workspace at once", async () => {
    const { host, sync } = harness();
    host.projects.set("p2", project("p2"));
    await sync.open("p1");
    await sync.open("p2");

    sync.closeAll();

    expect(sync.follows("p1")).toBe(false);
    expect(sync.follows("p2")).toBe(false);
    expect(host.subscriberCount).toBe(0);
  });

  it("ignores a feed that keeps talking after its Workspace closed", async () => {
    let handlers: FeedHandlers | undefined;
    const host = new FakeHost();
    const { view, paints } = recorder();
    const transport: BoardSyncTransport = {
      ...Object.fromEntries(
        (["snapshot", "roster", "archivedTickets"] as const).map((name) => [
          name,
          host[name].bind(host),
        ]),
      ),
      changes: (_projectId, _cursor, given) => {
        handlers = given;
        return () => {};
      },
    } as BoardSyncTransport;
    const sync = new BoardSync({ transport, view, feedRetryDelaysMs: [10] });
    await sync.open("p1");
    sync.close("p1");

    handlers!.onBatch({ cursor: "p1:9", changes: [] });
    handlers!.onResnapshot();
    handlers!.onError(new Error("late"));
    await vi.advanceTimersByTimeAsync(100);

    expect(paints).toHaveLength(1);
    expect(host.callsTo("snapshot")).toHaveLength(1);
  });
});

// ---- defaults ----------------------------------------------------------------------------------

describe("defaults", () => {
  it("mints a fresh UUID per write and runs on the real timer functions", async () => {
    const host = new FakeHost();
    host.tickets = [ticket("A", "backlog", 0)];
    const { view, last } = recorder();
    const sync = new BoardSync({ transport: host, view });
    await sync.open("p1");
    host.latency.feed = 100;

    await sync.moveTickets("p1", ["A"], "done", 0);
    await vi.advanceTimersByTimeAsync(100);

    const [sent] = host.callsTo("moveTickets");
    expect((sent!.input as { commandId: string }).commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(placement(last().tickets, "A")).toBe("done#0");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.callsTo("roster")).toEqual([]);
  });
});

describe("isAmbiguousBoardFailure", () => {
  it.each([
    [new Error("no envelope"), true],
    [null, true],
    [{ data: {} }, true],
    [{ data: { hostError: null } }, true],
    [{ data: { hostError: { code: "SERVICE_UNAVAILABLE" } } }, true],
    [{ data: { hostError: { code: "CLIENT_CLOSED_REQUEST" } } }, true],
    [{ data: { hostError: { code: "TIMEOUT" } } }, true],
    [{ data: { hostError: { code: "CONFLICT" } } }, false],
    [{ data: { hostError: { code: "BAD_REQUEST" } } }, false],
  ])("%j → %s", (error, ambiguous) => {
    expect(isAmbiguousBoardFailure(error)).toBe(ambiguous);
  });
});

// ---- T5 under latency ------------------------------------------------------------------------

/** Each command sent took effect exactly once, and nothing took effect that was not sent. */
function expectEachSentOnce(host: FakeHost): void {
  const sent = new Set(
    host.callsTo("moveTickets").map(({ input }) => (input as { commandId: string }).commandId),
  );
  expect([...host.effects.keys()].toSorted()).toEqual([...sent].toSorted());
  expect([...host.effects.values()].every((count) => count === 1)).toBe(true);
}

/** Gives each successive call of `method` its own trip to the host, in order, then none. */
function reorderTrips(host: FakeHost, method: "moveTickets", trips: readonly number[]): void {
  const send = host[method].bind(host);
  let call = 0;
  host[method] = (input) => {
    host.methodLatency[method] = { request: trips[call++] ?? 0 };
    return send(input);
  };
}

describe("a burst of drags under latency (T5)", () => {
  // The person's drags, ~10 ms apart: five different cards across columns,
  // then a reorder of a card already moved. Between them another writer edits
  // three cards the host only announces rowless.
  const drags: { at: number; ids: string[]; to: TicketStatus; index: number }[] = [
    { at: 0, ids: ["A"], to: "doing", index: 1 },
    { at: 10, ids: ["B"], to: "doing", index: 0 },
    { at: 20, ids: ["D"], to: "done", index: 0 },
    { at: 30, ids: ["E"], to: "needs_review", index: 0 },
    { at: 40, ids: ["C"], to: "todo", index: 0 },
    { at: 50, ids: ["B"], to: "doing", index: 2 },
  ];
  const rowless: { at: number; id: string }[] = [
    { at: 5, id: "G" },
    { at: 25, id: "H" },
    { at: 45, id: "I" },
  ];

  const shapes: [string, Latency, (readonly number[])?][] = [
    ["150 ms on every call and on the feed", { request: 150, reply: 150, feed: 150 }],
    ["the feed ahead of the reply", { request: 150, reply: 150, feed: 0 }],
    ["the feed behind the reply", { request: 150, reply: 0, feed: 150 }],
    ["all of it on the way back", { request: 0, reply: 150, feed: 150 }],
    // Each send's trip to the host differs, so a later send would overtake an
    // earlier one if it were let go before the earlier one settled.
    ["reordered delivery", { request: 150, reply: 150, feed: 150 }, [300, 0, 220, 10, 150, 0]],
  ];

  it.each(shapes)(
    "never rubber-bands a card, and reads once (%s)",
    async (_shape, latency, trips) => {
      // The rowless edits arrive inside one 50 ms coalescing window.
      const { host, sync, paints, view } = harness({ readCoalesceMs: 50 });
      host.latency = { ...latency };
      if (trips !== undefined) reorderTrips(host, "moveTickets", trips);
      const opening = sync.open("p1");
      await vi.advanceTimersByTimeAsync(300);
      await opening;
      const start = Date.now();

      // What the person has made after k drags: the board a local board would show.
      const made: Ticket[][] = [host.board("p1")];
      for (const drag of drags) {
        made.push(moveTicket(made.at(-1)!, drag.ids[0]!, drag.to, drag.index, 0));
      }
      let dragged = 0;
      const stageOfPaint: number[] = [];
      const record = view.paint.getMockImplementation()!;
      view.paint.mockImplementation((...args) => {
        record(...args);
        stageOfPaint.push(dragged);
      });
      const firstPaint = paints.length;

      const writes: Promise<void>[] = [];
      const script = [
        ...drags.map((drag) => ({
          at: drag.at,
          run: () => {
            dragged += 1;
            writes.push(sync.moveTickets("p1", drag.ids, drag.to, drag.index));
          },
        })),
        ...rowless.map(({ at, id }) => ({
          at,
          run: () => void host.externalRetitle("p1", id, `${id} elsewhere`, true),
        })),
      ].toSorted((left, right) => left.at - right.at);
      for (const step of script) {
        await vi.advanceTimersByTimeAsync(start + step.at - Date.now());
        step.run();
      }
      // Long enough for every answer, every batch, and any confirm timeout.
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(writes);

      // Each paint, with how many drags the person had made when it showed.
      const painted = paints
        .slice(firstPaint)
        .map((paint, index) => Object.assign({}, paint, { stage: stageOfPaint[index]! }));
      expect(painted.length).toBeGreaterThan(drags.length);

      // No rubber band: every paint shows each card exactly where the person's
      // latest drag left it — never an older placement — so each card's
      // sequence of placements only ever moves toward its final one.
      const violations: string[] = [];
      for (const paint of painted) {
        for (const { id } of made[0]!) {
          const shown = placement(paint.tickets, id);
          const newest = placement(made[paint.stage]!, id);
          if (shown !== newest) {
            violations.push(`t+${paint.at - start}ms: ${id} at ${shown}, last put at ${newest}`);
          }
        }
      }
      expect(violations).toEqual([]);
      // The same claim per card, read as a walk: each placement it shows is
      // found at or after the previous one in the history of placements the
      // person gave it, never only behind it.
      for (const { id } of made[0]!) {
        const history = made.map((board) => placement(board, id));
        let at = 0;
        for (const paint of painted) {
          while (at < history.length && history[at] !== placement(paint.tickets, id)) at += 1;
          expect(at, `${id} went back to ${placement(paint.tickets, id)}`).toBeLessThan(
            history.length,
          );
        }
        expect(history[at]).toBe(history.at(-1));
      }

      // The final view is the host's board, the other writer's edits included.
      const finalPaint = painted.at(-1)!;
      expect(finalPaint.tickets.toSorted((l, r) => l.id.localeCompare(r.id))).toEqual(
        host.board("p1").toSorted((l, r) => l.id.localeCompare(r.id)),
      );
      expect(columns(host.board("p1"))).toEqual(columns(made.at(-1)!));
      expect(finalPaint.tickets.find(({ id }) => id === "I")?.title).toBe("I elsewhere");
      // Each drag sent took effect exactly once (one still queued when its card
      // moved again collapsed into the newer one, never sent), none failed, and
      // the burst's three rowless changes cost one roster read.
      expectEachSentOnce(host);
      expect(view.failed).not.toHaveBeenCalled();
      expect(host.callsTo("roster")).toHaveLength(1);
    },
  );

  it("never rubber-bands at 150 ms through a lost first send, a failed confirmation read and a resnapshot mid-read", async () => {
    const { host, sync, paints, view } = harness({ readCoalesceMs: 50, confirmTimeoutMs: 1_000 });
    host.latency = { request: 150, reply: 150, feed: 150 };
    const opening = sync.open("p1");
    await vi.advanceTimersByTimeAsync(300);
    await opening;
    const start = Date.now();
    const burst: { at: number; ids: string[]; to: TicketStatus; index: number }[] = [
      ...drags,
      // A, whose first send is lost, dragged again: the older drag is superseded.
      { at: 60, ids: ["A"], to: "done", index: 0 },
    ];
    const made: Ticket[][] = [host.board("p1")];
    for (const drag of burst) {
      made.push(moveTicket(made.at(-1)!, drag.ids[0]!, drag.to, drag.index, 0));
    }
    let dragged = 0;
    const stageOfPaint: number[] = [];
    const record = view.paint.getMockImplementation()!;
    view.paint.mockImplementation((...args) => {
      record(...args);
      stageOfPaint.push(dragged);
    });
    const firstPaint = paints.length;
    // The first drag's send never lands; the first read fails.
    host.fail("moveTickets", unreachable);
    host.fail("roster", unreachable);

    const writes: Promise<void>[] = [];
    const script = [
      ...burst.map((drag) => ({
        at: drag.at,
        run: () => {
          dragged += 1;
          writes.push(sync.moveTickets("p1", drag.ids, drag.to, drag.index));
        },
      })),
      ...rowless.map(({ at, id }) => ({
        at,
        run: () => void host.externalRetitle("p1", id, `${id} elsewhere`, true),
      })),
      // The burst's read fails at t+355 and is retried at t+605; the host
      // restarts its feed while that retry is in flight.
      { at: 700, run: () => host.requireResnapshot("p1") },
    ].toSorted((left, right) => left.at - right.at);
    for (const step of script) {
      await vi.advanceTimersByTimeAsync(start + step.at - Date.now());
      step.run();
    }
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(writes);

    const painted = paints
      .slice(firstPaint)
      .map((paint, index) => Object.assign({}, paint, { stage: stageOfPaint[index]! }));
    const violations: string[] = [];
    for (const paint of painted) {
      for (const { id } of made[0]!) {
        const shown = placement(paint.tickets, id);
        const newest = placement(made[paint.stage]!, id);
        if (shown !== newest) {
          violations.push(`t+${paint.at - start}ms: ${id} at ${shown}, last put at ${newest}`);
        }
      }
    }
    expect(violations).toEqual([]);
    const finalPaint = painted.at(-1)!;
    expect(finalPaint.tickets.toSorted((l, r) => l.id.localeCompare(r.id))).toEqual(
      host.board("p1").toSorted((l, r) => l.id.localeCompare(r.id)),
    );
    expect(columns(host.board("p1"))).toEqual(columns(made.at(-1)!));
    expect(finalPaint.tickets.find(({ id }) => id === "I")?.title).toBe("I elsewhere");
    // The lost first drag was sent again under its id and applied once,
    // before any later drag of the board; every other drag sent applied once.
    expect(host.effects.get("cmd-1")).toBe(1);
    expectEachSentOnce(host);
    // The failed read was said once, and retried until one landed.
    expect(view.failed).toHaveBeenCalledExactlyOnceWith(
      "Couldn't refresh the board: host-unreachable",
    );
    expect(host.callsTo("roster")).toHaveLength(2);
    expect(host.callsTo("snapshot")).toHaveLength(2);
  });
});

// ---- the #810 review's interleavings (VC-565), each a guarantee ----------------------------

describe("interleavings: a newer write supersedes, any proof decides, the base is monotonic", () => {
  it("keeps the latest drag when an earlier unsent command would retry after it", async () => {
    const { host, sync, last } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    host.fail("moveTickets", unreachable); // the first attempt did NOT land
    const earlier = sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(0);
    const latest = sync.moveTickets("p1", ["A"], "done", 0);
    await vi.advanceTimersByTimeAsync(0);
    // The person sees the latest drag at once; its send waits for the earlier one.
    expect(placement(last().tickets, "A")).toBe("done#0");
    expect(host.callsTo("moveTickets")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([earlier, latest]);
    // The earlier drag's retry lands first, the latest after it: Done holds.
    expect(
      host.callsTo("moveTickets").map(({ input }) => (input as { commandId: string }).commandId),
    ).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
    expect(host.effects.get("cmd-1")).toBe(1);
    expect(host.effects.get("cmd-2")).toBe(1);
    expect(placement(last().tickets, "A")).toBe("done#0");
    expect(placement(host.board("p1"), "A")).toBe("done#0");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(placement(last().tickets, "A")).toBe("done#0");
  });

  it("collapses drags queued behind an unsettled one into the latest: only it is sent next", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.moveTickets = { request: 100 };
    const first = sync.moveTickets("p1", ["A"], "doing", 0);
    const second = sync.moveTickets("p1", ["A"], "todo", 0);
    const third = sync.moveTickets("p1", ["A"], "done", 0);
    expect(placement(last().tickets, "A")).toBe("done#0");
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([first, second, third]);
    expect(
      host.callsTo("moveTickets").map(({ input }) => (input as { commandId: string }).commandId),
    ).toEqual(["cmd-1", "cmd-3"]);
    expect(placement(host.board("p1"), "A")).toBe("done#0");
    expect(placement(last().tickets, "A")).toBe("done#0");
  });

  it("holds a newer write that only overlaps an older unsettled one until it settles, in order", async () => {
    const { host, sync, last } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    host.fail("updateTicket", unreachable);
    const both = sync.updateTicket("p1", { ticketId: "A", title: "First", body: "# First" });
    await vi.advanceTimersByTimeAsync(0);
    // Overlaps the title but not the body: it cannot replace the older write.
    const title = sync.updateTicket("p1", { ticketId: "A", title: "Second" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().tickets.find(({ id }) => id === "A")).toMatchObject({
      title: "Second",
      body: "# First",
    });
    expect(host.callsTo("updateTicket")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([both, title]);
    expect(
      host.callsTo("updateTicket").map(({ input }) => (input as { commandId: string }).commandId),
    ).toEqual(["cmd-1", "cmd-1", "cmd-2"]);
    expect(host.board("p1").find(({ id }) => id === "A")).toMatchObject({
      title: "Second",
      body: "# First",
    });
    expect(last().tickets.find(({ id }) => id === "A")).toMatchObject({
      title: "Second",
      body: "# First",
    });
  });

  it("does not roll a saved body back when the feed leads the reply", async () => {
    const { host, sync, paints, last } = harness();
    await sync.open("p1");
    host.methodLatency.updateTicket = { request: 0, reply: 150 };
    const painted = paints.length;
    const update = sync.updateTicket("p1", { ticketId: "A", body: "new body" });
    await vi.advanceTimersByTimeAsync(150);
    expect((await update)?.body).toBe("new body");
    // Not one paint in between showed the old body.
    for (const paint of paints.slice(painted)) {
      expect(paint.tickets.find(({ id }) => id === "A")?.body).toBe("new body");
    }
    expect(last().tickets.find(({ id }) => id === "A")?.body).toBe("new body");
  });

  it("shows a created ticket's body as soon as the feed proves the create, before the reply", async () => {
    const { host, sync, paints, last } = harness();
    await sync.open("p1");
    host.methodLatency.createTicket = { request: 0, reply: 150 };
    const creating = sync.createTicket("p1", { status: "todo", title: "New", body: "# Mine" });
    await vi.advanceTimersByTimeAsync(0);
    const confirmed = last().tickets.find(({ id }) => id === "n1");
    expect(confirmed?.body).toBe("# Mine");
    expect(last().unloaded.has("n1")).toBe(false);
    expect(last().tickets.some(({ id }) => id.startsWith("pending:"))).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect((await creating)?.id).toBe("n1");
    expect(paints.at(-1)?.tickets.find(({ id }) => id === "n1")?.body).toBe("# Mine");
  });

  it("retries the confirmation read after a transient failure instead of keeping a pending edit forever", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.dropFeed = true;
    await sync.setPriority("p1", "A", "high");
    host.fail("roster", unreachable);
    await vi.advanceTimersByTimeAsync(60_000);
    // A confirmed write by another writer must now supersede our completed edit.
    host.dropFeed = false;
    host.tickets = host.tickets.map((t) => (t.id === "A" ? { ...t, priority: "low" } : t));
    host.stamp("p1", [
      {
        kind: "ticket",
        op: "upsert",
        id: "A",
        projectId: "p1",
        ticket: summaryOf(host.tickets.find((t) => t.id === "A")!),
      },
    ]);
    expect(last().tickets.find((t) => t.id === "A")?.priority).toBe("low");
    expect(host.callsTo("roster").length).toBe(2);
  });

  it("does not let a pre-resnapshot roster overwrite a newer snapshot", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 300 };
    host.externalRetitle("p1", "A", "old", true);
    await vi.advanceTimersByTimeAsync(16); // the old roster is captured
    host.methodLatency.snapshot = { request: 50, reply: 0 };
    host.requireResnapshot("p1");
    host.dropFeed = true;
    host.externalRetitle("p1", "A", "new"); // while the old feed is stopped
    await vi.advanceTimersByTimeAsync(50);
    host.dropFeed = false;
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("new");
    await vi.advanceTimersByTimeAsync(300);
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("new");
    expect(host.board("p1").find((t) => t.id === "A")?.title).toBe("new");
  });

  it("does not replay an older feed row over a newer roster while a later feed row is delayed", async () => {
    const { host, sync, last, paints } = harness();
    await sync.open("p1");
    host.methodLatency.roster = { request: 100, reply: 0 };
    host.externalRetitle("p1", "H", "trigger", true);
    await vi.advanceTimersByTimeAsync(16); // the read is sent; it captures at t116
    host.latency.feed = 30;
    host.externalRetitle("p1", "A", "old"); // delivered at t46
    await vi.advanceTimersByTimeAsync(10);
    host.latency.feed = 200;
    host.externalRetitle("p1", "A", "new"); // delivered at t226; the roster already holds it
    await vi.advanceTimersByTimeAsync(90); // t116
    expect(host.board("p1").find((t) => t.id === "A")?.title).toBe("new");
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("new");
    const painted = paints.length;
    // The late batch is older than the base: its row is dropped, the title holds.
    await vi.advanceTimersByTimeAsync(200);
    expect(
      paints.slice(painted).map((p) => p.tickets.find((t) => t.id === "A")?.title),
    ).not.toContain("old");
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("new");
  });

  it("recovers a failed first snapshot without an explicit reopen", async () => {
    const { host, sync, last } = harness();
    host.fail("snapshot", unreachable);
    await expect(sync.open("p1")).rejects.toEqual(unreachable);
    expect(sync.follows("p1")).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.callsTo("snapshot")).toHaveLength(2);
    expect(host.subscriberCount).toBe(1);
    expect(columns(last().tickets).doing).toEqual(["G"]);
  });

  it("keeps re-opening with backoff while the snapshot keeps failing, and stops once closed", async () => {
    const { host, sync } = harness({ feedRetryDelaysMs: [100, 300] });
    host.fail("snapshot", unreachable, { times: 3 });
    await expect(sync.open("p1")).rejects.toEqual(unreachable);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.callsTo("snapshot")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(host.callsTo("snapshot")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.callsTo("snapshot")).toHaveLength(3);
    sync.close("p1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.callsTo("snapshot")).toHaveLength(3);
    expect(host.subscriberCount).toBe(0);
  });

  it("refreshes the Project row on a rowless project change (a relink)", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");
    host.projects.set("p1", { ...project("p1"), path: "/relinked" });
    host.stamp("p1", [{ kind: "project", op: "upsert", id: "p1", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.callsTo("snapshot")).toHaveLength(2);
    expect(view.adoptProject.mock.lastCall?.[0].path).toBe("/relinked");
  });

  it("drops a read answered from another feed: the feed's own resnapshot replaces the base", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    const roster = host.roster.bind(host);
    host.roster = async (projectId) => ({ ...(await roster(projectId)), cursor: "other-feed:9" });
    host.externalRetitle("p1", "A", "Elsewhere", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(host.callsTo("roster")).toHaveLength(1);
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("Ticket A");
  });

  it("drops an older read it can no longer replay (too much changed meanwhile), and reads again", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 100 };
    host.externalRetitle("p1", "A", "Rowless", true);
    await vi.advanceTimersByTimeAsync(16);
    // More entities change during the read than it keeps.
    host.stamp(
      "p1",
      Array.from({ length: READ_LOG_ENTITIES + 1 }, (_, i) => ({
        kind: "label" as const,
        op: "upsert" as const,
        id: `l${i}`,
        projectId: "p1",
        label: label(`l${i}`),
      })),
    );
    await vi.advanceTimersByTimeAsync(100);
    // Its answer is older than the base and cannot be replayed: dropped, read again.
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("Ticket A");
    expect(last().labels).toHaveLength(2 + READ_LOG_ENTITIES + 1);
    await vi.advanceTimersByTimeAsync(16 + 100);
    expect(host.callsTo("roster")).toHaveLength(2);
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("Rowless");
  });

  it("drops a batch older than the base, but still tells per-ticket surfaces what it says", async () => {
    const { host, sync, view, last } = harness();
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 0 };
    host.latency.feed = 100;
    host.externalRetitle("p1", "A", "Rowless", true); // delivered at t100
    host.latency.feed = 0;
    // A read the base asks for itself lands first and is newer.
    host.externalRetitle("p1", "B", "Fresh", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("Rowless");
    view.notePlanningChange.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.notePlanningChange).toHaveBeenCalledWith({ ticketId: "A", projectId: "p1" });
    // No further read: the late rowless change is one the read already covered.
    await vi.advanceTimersByTimeAsync(100);
    expect(host.callsTo("roster")).toHaveLength(1);
  });
});

describe("bounded memory", () => {
  it("drops a ticket's body when it leaves the board, and a Workspace's bodies when it closes", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.stamp("p1", [{ kind: "ticket", op: "delete", id: "A", projectId: "p1" }]);
    // Back on the board with no body read since: it shows as unloaded, not a stale body.
    host.stamp("p1", [
      {
        kind: "ticket",
        op: "upsert",
        id: "A",
        projectId: "p1",
        ticket: summaryOf(ticket("A", "backlog", 0)),
      },
    ]);
    expect(last().unloaded.has("A")).toBe(true);
    sync.close("p1");
    await sync.open("p1");
    expect(last().unloaded.size).toBe(0);
  });

  it("forgets the bodies of tickets a read no longer finds", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.tickets = host.tickets.filter(({ id }) => id !== "B");
    host.externalRetitle("p1", "A", "Rowless", true);
    await vi.advanceTimersByTimeAsync(16);
    expect(last().tickets.some(({ id }) => id === "B")).toBe(false);
    host.tickets.push(ticket("B", "backlog", 1));
    host.stamp("p1", [
      {
        kind: "ticket",
        op: "upsert",
        id: "B",
        projectId: "p1",
        ticket: summaryOf(ticket("B", "backlog", 1)),
      },
    ]);
    expect(last().unloaded.has("B")).toBe(true);
  });

  it("ignores a body for a ticket no followed board holds", async () => {
    const { sync, last } = harness();
    await sync.open("p1");
    sync.adoptBody("nowhere", "# Orphan");
    expect(last().tickets.some(({ id }) => id === "nowhere")).toBe(false);
    expect(sync.workspaceOf("A")).toBe("p1");
    expect(sync.workspaceOf("nowhere")).toBeUndefined();
  });
});

describe("per-surface commands", () => {
  it("settles a command on the feed row that names it, after its reply was lost", async () => {
    const { host, sync, view } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    let sent = 0;
    const result = sync.command({
      verb: "add comment",
      send: async (commandId) => {
        sent += 1;
        // The host stamps the comment, naming the command; the reply is lost.
        host.stamp("p1", [
          {
            kind: "comment",
            op: "upsert",
            id: "c1",
            projectId: "p1",
            ticketId: "A",
            commandId,
            comment: { id: "c1", ticketId: "A", body: "Hi" } as never,
          },
        ]);
        throw unreachable;
      },
      fromFeed: (row) => ({ comment: row }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({
      ok: true,
      answer: { comment: { id: "c1", ticketId: "A", body: "Hi" } },
    });
    expect(sent).toBe(1);
    expect(view.failed).not.toHaveBeenCalled();
  });

  it("answers a refusal as the legacy envelope, and a retried removal that finds nothing as done", async () => {
    const { sync, view } = harness({ retryDelaysMs: [10] });
    expect(
      await sync.command({
        verb: "edit comment",
        send: async () => {
          throw conflict;
        },
        fromFeed: () => null,
      }),
    ).toEqual({ ok: false, error: "stale board" });
    // The surface says it, in its own words: not twice.
    expect(view.failed).not.toHaveBeenCalled();

    let attempts = 0;
    const removing = sync.command({
      verb: "delete comment",
      send: async () => {
        attempts += 1;
        throw attempts === 1 ? unreachable : notFound;
      },
      fromFeed: () => "gone",
      goneMeansDone: true,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(await removing).toEqual({ ok: true, answer: "gone" });
  });
});

describe("an archive's side effects run once, on its first proof", () => {
  afterEach(() => {
    stopBoardProtocol();
    vi.unstubAllGlobals();
  });

  function storeOver(host: FakeHost, sync: Partial<BoardSyncOptions>) {
    const kill = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", { api: { terminal: { kill } } });
    useSessionsStore.setState({ byOwner: {}, sessionOwner: {}, lastOutputAt: {}, starting: {} });
    const store = createBoardStore();
    const { view } = recorder();
    view.paint.mockImplementation((...args) => store.getState().paintProtocolBoard(...args));
    const started = startBoardProtocol({
      client: {} as never,
      view,
      sync: { transport: host, ...sync },
    });
    return { kill, store, view, sync: started.sync };
  }

  it.each(["archive", "delete"] as const)(
    "%s kills a Session once after a lost reply and a same-id retry",
    async (kind) => {
      const host = new FakeHost();
      host.tickets = [ticket("A", "doing", 0)];
      host.dropFeed = true;
      const { kill, store, sync } = storeOver(host, { retryDelaysMs: [100] });
      await sync.open("p1");
      if (kind === "delete") {
        host.tickets = [];
        host.archived = [{ ...ticket("A", "done", 0), archivedAt: 1 }];
        store.setState({ archivedByProject: { p1: host.archived } });
      }
      useSessionsStore.getState().addSession(ticketScope("p1", "A"), "s1", {
        title: "s1",
        harnessId: "claude-code",
        launchKind: "shell",
        createdAt: 0,
      });
      const method = kind === "archive" ? "archiveTicket" : "deleteTicket";
      host.fail(method, unreachable, { applied: true });
      if (kind === "delete") host.fail(method, notFound);
      const changing =
        kind === "archive"
          ? store.getState().archiveTicket("p1", "A")
          : store.getState().deleteArchivedTicket("p1", "A");
      await vi.advanceTimersByTimeAsync(100);
      await changing;
      expect(kill).toHaveBeenCalledTimes(1);
      expect(host.callsTo(method)).toHaveLength(2);
      expect([...host.effects.values()]).toEqual([1]);
    },
  );

  it("counts an archive the feed proved as done though every reply was lost", async () => {
    const host = new FakeHost();
    host.tickets = [ticket("A", "doing", 0)];
    const { kill, store, view, sync } = storeOver(host, { retryDelaysMs: [10], maxAttempts: 2 });
    await sync.open("p1");
    useSessionsStore.getState().addSession(ticketScope("p1", "A"), "s1", {
      title: "s1",
      harnessId: "claude-code",
      launchKind: "shell",
      createdAt: 0,
    });
    host.fail("archiveTicket", unreachable, { applied: true, times: 2 });
    const archiving = store.getState().archiveTicket("p1", "A");
    await vi.advanceTimersByTimeAsync(10);
    await archiving;
    expect(host.archived.map((t) => t.id)).toEqual(["A"]);
    expect([...host.effects.values()]).toEqual([1]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(view.failed).not.toHaveBeenCalled();
    // One send: the feed's proof stopped the retry.
    expect(host.callsTo("archiveTicket")).toHaveLength(1);
  });
});

describe("edges of the rules", () => {
  it.each([
    ["createTicket", "n1"],
    ["updateTicket", "A"],
    ["unarchiveTicket", "Q"],
  ] as const)(
    "answers a %s the feed proved, after every reply was lost, with the row the base holds",
    async (method, id) => {
      const { host, sync, view } = harness({ retryDelaysMs: [100] });
      await sync.open("p1");
      const archived = { ...ticket("Q", "doing", 7), archivedAt: 5 };
      host.archived = [archived];
      host.fail(method, unreachable, { applied: true });
      const answer = await (method === "createTicket"
        ? sync.createTicket("p1", { status: "todo", title: "New", body: "# New" })
        : method === "updateTicket"
          ? sync.updateTicket("p1", { ticketId: "A", title: "Renamed", body: "# Renamed" })
          : sync.unarchiveTicket("p1", archived));
      expect(answer).toEqual(host.board("p1").find((row) => row.id === id));
      expect(host.callsTo(method)).toHaveLength(1);
      expect(view.failed).not.toHaveBeenCalled();
    },
  );

  it("re-opens at once when asked during a failed open's backoff, and drops the pending retry", async () => {
    const { host, sync } = harness({ feedRetryDelaysMs: [500] });
    host.fail("snapshot", unreachable);
    await expect(sync.open("p1")).rejects.toEqual(unreachable);
    await sync.open("p1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.callsTo("snapshot")).toHaveLength(2);
    expect(host.subscriberCount).toBe(1);
  });

  it("does not re-open a snapshot that failed after its Workspace closed", async () => {
    const { host, sync } = harness({ feedRetryDelaysMs: [100] });
    host.methodLatency.snapshot = { request: 50 };
    host.fail("snapshot", unreachable);
    const opening = expect(sync.open("p1")).rejects.toEqual(unreachable);
    sync.close("p1");
    await vi.advanceTimersByTimeAsync(50);
    await opening;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.callsTo("snapshot")).toHaveLength(1);
  });

  it("answers a per-surface command still out when every Workspace closes as not done", async () => {
    const { sync } = harness();
    let fail!: (error: unknown) => void;
    const result = sync.command({
      verb: "add comment",
      send: () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      fromFeed: () => null,
    });
    await vi.advanceTimersByTimeAsync(0);
    sync.closeAll();
    fail(unreachable);
    expect(await result).toEqual({ ok: false, error: "host-unreachable" });
  });

  it("takes a per-surface command's reply after the feed proved it, and settles once", async () => {
    const { host, sync } = harness();
    await sync.open("p1");
    const relinked = { ...host.projects.get("p1")!, baseBranch: "trunk" };
    const result = await sync.command({
      verb: "update project",
      send: async (commandId) => {
        host.stamp("p1", [
          {
            kind: "project",
            op: "upsert",
            id: "p1",
            projectId: "p1",
            commandId,
            project: relinked,
          },
        ]);
        return { project: relinked };
      },
      fromFeed: (row) => ({ project: row }),
    });
    expect(result).toEqual({ ok: true, answer: { project: relinked } });
  });

  it("settles a per-surface command on the project row the feed carried", async () => {
    const { host, sync } = harness({ retryDelaysMs: [100] });
    await sync.open("p1");
    const relinked = { ...host.projects.get("p1")!, baseBranch: "trunk" };
    const result = sync.command({
      verb: "update project",
      send: async (commandId) => {
        host.stamp("p1", [
          {
            kind: "project",
            op: "upsert",
            id: "p1",
            projectId: "p1",
            commandId,
            project: relinked,
          },
        ]);
        throw unreachable;
      },
      fromFeed: (row) => ({ project: row }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual({ ok: true, answer: { project: { ...relinked } } });
  });

  it("sends a newer write at once when the older one it overlaps is already accepted", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    host.dropFeed = true;
    await sync.updateTicket("p1", { ticketId: "A", title: "First", body: "# First" });
    host.latency.request = 10;
    const second = sync.updateTicket("p1", { ticketId: "A", title: "Second" });
    // Accepted is settled: the host already has the older one, so the order holds.
    expect(host.callsTo("updateTicket")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    await second;
    expect(last().tickets.find((t) => t.id === "A")).toMatchObject({
      title: "Second",
      body: "# First",
    });
  });

  it("keeps an accepted write's edit under a newer one that covers it, until the base holds it", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    host.dropFeed = true;
    await sync.moveTickets("p1", ["A"], "doing", 0);
    host.latency.request = 10;
    const latest = sync.moveTickets("p1", ["A"], "done", 0);
    expect(placement(last().tickets, "A")).toBe("done#0");
    await vi.advanceTimersByTimeAsync(10);
    await latest;
    expect(host.effects.get("cmd-1")).toBe(1);
    expect(host.effects.get("cmd-2")).toBe(1);
    expect(placement(last().tickets, "A")).toBe("done#0");
  });

  it("ignores a batch from another feed on its subscription", async () => {
    let handlers: FeedHandlers | undefined;
    const host = new FakeHost();
    host.tickets = [ticket("A", "backlog", 0)];
    const { view, last } = recorder();
    host.changes = (_projectId, _cursor, given) => {
      handlers = given;
      return () => {};
    };
    const sync = new BoardSync({ transport: host, view });
    await sync.open("p1");
    handlers!.onBatch({
      cursor: "elsewhere:9",
      changes: [{ kind: "ticket", op: "delete", id: "A", projectId: "p1" }],
    });
    expect(placement(last().tickets, "A")).toBe("backlog#0");
  });

  it("retires a write stamped on another feed only once a snapshot replaces the base", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    host.dropFeed = true;
    const move = host.moveTickets.bind(host);
    // The host restarted between its write and its answer.
    host.moveTickets = async (input) => ({ ...(await move(input)), throughCursor: "restarted:1" });
    await sync.moveTickets("p1", ["A"], "doing", 0);
    host.dropFeed = false;
    host.externalMove("p1", "B", "done", 0);
    // Not held by a batch of the old feed: the edit stays.
    host.tickets = host.tickets.map((t) => (t.id === "A" ? { ...t, status: "backlog" } : t));
    host.externalRetitle("p1", "C", "Nudge");
    expect(columns(last().tickets).doing).toEqual(["A", "G"]);
    // A snapshot of the later feed holds it.
    host.requireResnapshot("p1");
    await vi.advanceTimersByTimeAsync(0);
    expect(placement(last().tickets, "A")).toBe("backlog#0");
  });

  it("waits again for a write a confirmation read could not place", async () => {
    const { host, sync } = harness({ confirmTimeoutMs: 1_000 });
    await sync.open("p1");
    host.dropFeed = true;
    const roster = host.roster.bind(host);
    host.roster = async (projectId) => ({ ...(await roster(projectId)), cursor: "elsewhere:5" });
    await sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(1_000 + 16);
    expect(host.callsTo("roster")).toHaveLength(1);
    // Dropped (another feed), so the write waits for its cursor again, not in a loop.
    await vi.advanceTimersByTimeAsync(999);
    expect(host.callsTo("roster")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 + 16);
    expect(host.callsTo("roster")).toHaveLength(2);
  });

  it("does not retry a failed confirmation read once the feed brought the write", async () => {
    const { host, sync, view } = harness({ confirmTimeoutMs: 1_000, feedRetryDelaysMs: [100] });
    await sync.open("p1");
    host.latency.feed = 1_050;
    host.methodLatency.roster = { request: 0, reply: 100 };
    host.fail("roster", unreachable, { applied: true });
    await sync.moveTickets("p1", ["A"], "doing", 0);
    // Another write still out asks for no read of its own.
    host.methodLatency.setPriority = { request: 10_000 };
    void sync.setPriority("p1", "B", "high");
    await vi.advanceTimersByTimeAsync(1_016 + 100 + 1_000);
    expect(view.failed).toHaveBeenCalledOnce();
    expect(host.callsTo("roster")).toHaveLength(1);
  });

  it("keeps a body this window holds over an older snapshot read's", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.snapshot = { request: 0, reply: 100 };
    host.stamp("p1", [{ kind: "project", op: "upsert", id: "p1", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(16); // the snapshot read captures at once
    host.tickets = host.tickets.map((t) => (t.id === "A" ? { ...t, body: "# Later" } : t));
    host.externalRetitle("p1", "A", "Later");
    sync.adoptBody("A", "# Later");
    await vi.advanceTimersByTimeAsync(100);
    expect(last().tickets.find((t) => t.id === "A")).toMatchObject({
      title: "Later",
      body: "# Later",
    });
  });

  it("keeps a newer project row over a snapshot read's, and reads again for a newer rowless one", async () => {
    const { host, sync, view } = harness();
    await sync.open("p1");
    host.methodLatency.snapshot = { request: 0, reply: 100 };
    host.stamp("p1", [{ kind: "project", op: "upsert", id: "p1", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(16);
    const renamed = { ...project("p1"), name: "Renamed" };
    host.projects.set("p1", renamed);
    host.stamp("p1", [
      { kind: "project", op: "upsert", id: "p1", projectId: "p1", project: renamed },
      { kind: "project", op: "upsert", id: "p1", projectId: "p1" },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(view.adoptProject).toHaveBeenLastCalledWith(renamed);
    await vi.advanceTimersByTimeAsync(16 + 100);
    expect(host.callsTo("snapshot")).toHaveLength(3);
  });
});

// ---- the #810 re-check's interleavings (VC-565), each a guarantee ---------------------------

describe("re-check: per-aspect order, body freshness, generation-scoped reads", () => {
  it("keeps the latest drag even when the superseded request reaches the host late", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.moveTickets = { request: 200, reply: 0 };
    const old = sync.moveTickets("p1", ["A"], "doing", 0);
    await vi.advanceTimersByTimeAsync(10);
    host.methodLatency.moveTickets = { request: 0, reply: 0 };
    const latest = sync.moveTickets("p1", ["A"], "done", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(placement(last().tickets, "A")).toBe("done#0");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([old, latest]);
    // The latest drag was sent only once the older request settled.
    expect(placement(host.board("p1"), "A")).toBe("done#0");
    expect(placement(last().tickets, "A")).toBe("done#0");
  });

  it("does not let a late reply to an already proved save roll a newer save back", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.updateTicket = { request: 0, reply: 200 };
    const old = sync.updateTicket("p1", { ticketId: "A", body: "first save" });
    await vi.advanceTimersByTimeAsync(10);
    host.methodLatency.updateTicket = { request: 0, reply: 0 };
    const latest = sync.updateTicket("p1", { ticketId: "A", body: "latest save" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last().tickets.find((t) => t.id === "A")?.body).toBe("latest save");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([old, latest]);
    expect(host.board("p1").find((t) => t.id === "A")?.body).toBe("latest save");
    expect(last().tickets.find((t) => t.id === "A")?.body).toBe("latest save");
  });

  it("does not adopt an older write's late reply over a newer write's body", async () => {
    const { host, sync, last } = harness({ confirmTimeoutMs: 60_000 });
    await sync.open("p1");
    // Two saves of different fields' writes to the body: the older one's
    // reply is the one held back.
    host.methodLatency.updateTicket = { request: 0, reply: 300 };
    const first = sync.updateTicket("p1", { ticketId: "A", title: "T1", body: "one" });
    await vi.advanceTimersByTimeAsync(0);
    host.methodLatency.updateTicket = { request: 0, reply: 0 };
    const second = sync.updateTicket("p1", { ticketId: "A", body: "two" });
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([first, second]);
    expect(last().tickets.find((t) => t.id === "A")).toMatchObject({ title: "T1", body: "two" });
  });

  it("does not lose a new generation's rowless read behind an old generation's read", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.roster = { request: 0, reply: 300 };
    host.externalRetitle("p1", "A", "old generation", true);
    await vi.advanceTimersByTimeAsync(16);
    host.methodLatency.snapshot = { request: 50, reply: 0 };
    host.requireResnapshot("p1");
    host.externalRetitle("p1", "A", "snapshot value");
    await vi.advanceTimersByTimeAsync(50);
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("snapshot value");
    host.externalRetitle("p1", "A", "post snapshot rowless", true);
    host.methodLatency.roster = { request: 0, reply: 0 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.board("p1").find((t) => t.id === "A")?.title).toBe("post snapshot rowless");
    expect(last().tickets.find((t) => t.id === "A")?.title).toBe("post snapshot rowless");
  });

  it("does not put a body back for a ticket that left the board when a late reply lands", async () => {
    const set = Map.prototype.set;
    let bodies: Map<string, string> | undefined;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (key === "A" && value === "# A") bodies = this as Map<string, string>;
      return set.call(this, key, value);
    });
    try {
      const { host, sync } = harness();
      await sync.open("p1");
      expect(bodies?.get("A")).toBe("# A");
      host.methodLatency.updateTicket = { request: 0, reply: 200 };
      const save = sync.updateTicket("p1", { ticketId: "A", body: "late saved body" });
      await vi.advanceTimersByTimeAsync(10);
      await sync.archiveTicket("p1", "A");
      expect(bodies?.has("A")).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await save;
      expect(bodies?.has("A")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a body adopted while a snapshot read was in flight over that read's older one", async () => {
    const { host, sync, last } = harness();
    await sync.open("p1");
    host.methodLatency.snapshot = { request: 0, reply: 100 };
    host.stamp("p1", [{ kind: "project", op: "upsert", id: "p1", projectId: "p1" }]);
    await vi.advanceTimersByTimeAsync(16); // the read captures "# A"
    sync.adoptBody("A", "# Read since");
    await vi.advanceTimersByTimeAsync(100);
    expect(last().tickets.find((t) => t.id === "A")?.body).toBe("# Read since");
  });
});

// ---- routing by Workspace (VC-711) ----------------------------------------------------------

/** Lets the fake hosts answer: they answer on a timer, even at no latency. */
async function go<Answer>(call: Promise<Answer>): Promise<Answer> {
  const state = { settled: false };
  void call.finally(() => (state.settled = true)).catch(() => {});
  for (let tick = 0; tick < 400; tick++) {
    if (state.settled) return call;
    await vi.advanceTimersByTimeAsync(25);
  }
  throw new Error("never settled");
}

describe("routing each Workspace to its own host", () => {
  it("sends every read, feed and write of a Workspace to that Workspace's transport", async () => {
    const local = new FakeHost();
    local.tickets = [ticket("A", "todo", 0)];
    const remote = new FakeHost();
    remote.projects.set("r1", project("r1"));
    remote.tickets = [ticket("R", "todo", 0, { projectId: "r1" })];
    remote.labels = [label("box", "r1")];
    const { view, last } = recorder();
    let minted = 0;
    const sync = new BoardSync({
      transport: (projectId) => (projectId === "r1" ? remote : local),
      view,
      mintCommandId: () => `cmd-${++minted}`,
    });
    await go(sync.open("p1"));
    await go(sync.open("r1"));
    expect(last("r1").tickets.map(({ id }) => id)).toEqual(["R"]);
    expect(remote.subscriptions.map(({ projectId }) => projectId)).toEqual(["r1"]);
    expect(local.subscriptions.map(({ projectId }) => projectId)).toEqual(["p1"]);

    const made = await go(sync.createTicket("r1", { status: "todo", title: "On the box" }));
    await go(sync.setPriority("r1", "R", "high"));
    await go(sync.updateTicket("r1", { ticketId: "R", title: "Renamed" }));
    await go(sync.setLabels("r1", "R", ["box"]));
    await go(sync.setLabelColor("r1", remote.labels[0]!.id, "#ff0000"));
    await go(sync.moveTickets("r1", ["R"], "doing", 0));
    await go(sync.archiveTicket("r1", made!.id));
    const archived = await go(sync.archivedTickets("r1"));
    await go(sync.unarchiveTicket("r1", archived![0]!));
    await go(sync.setPriority("p1", "A", "low"));

    expect(remote.calls.map(({ method }) => method)).toEqual(
      expect.arrayContaining([
        "snapshot",
        "createTicket",
        "setPriority",
        "updateTicket",
        "setLabels",
        "setLabelColor",
        "moveTickets",
        "archiveTicket",
        "archivedTickets",
        "unarchiveTicket",
      ]),
    );
    expect(local.calls.map(({ method }) => method)).toEqual(["snapshot", "setPriority"]);
  });
});

// ---- what a closed Workspace owns, and a host with no board (VC-711) ----------------------

const failure = (reason?: string) => ({ data: { hostError: { code: "X", message: "m", reason } } });

describe("a Workspace's own commands, and a host that offers no board", () => {
  it("ends a per-surface command made for a Workspace when that Workspace closes", async () => {
    const { host, sync } = harness();
    await go(sync.open("p1"));
    const send = vi.fn(() => Promise.reject(unreachable));
    const owned = sync.command({
      verb: "add comment",
      owner: "p1",
      send,
      fromFeed: () => "fed",
    });
    const unowned = sync.command({
      verb: "add comment",
      send: () => Promise.reject(unreachable),
      fromFeed: () => "fed",
    });
    await vi.advanceTimersByTimeAsync(10);
    sync.close("p1");
    expect(await owned).toEqual({ ok: false, error: "The board closed before the host answered" });
    const attempts = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(attempts);
    // A command no Workspace owns is not this close's.
    sync.closeAll();
    expect(await unowned).toMatchObject({ ok: false });
    expect(host.calls.map(({ method }) => method)).toEqual(["snapshot"]);
  });

  it("stops opening a Workspace whose host refuses its board, and follows it no more", async () => {
    const { host, sync } = harness();
    for (const reason of ["verb-refused", "operation-unavailable", "workspace-unknown"]) {
      host.fail("snapshot", { data: { hostError: { code: "FORBIDDEN", message: "no", reason } } });
      await expect(go(sync.open("p1"))).rejects.toBeDefined();
      expect(sync.follows("p1")).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(host.callsTo("snapshot")).toHaveLength(3);
    // An outage is still retried, with backoff, until it lands.
    host.fail("snapshot", unreachable);
    await expect(go(sync.open("p1"))).rejects.toBeDefined();
    expect(sync.follows("p1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.callsTo("snapshot")).toHaveLength(5);
  });

  it("names only a refusal of the board itself as one it cannot get past", () => {
    expect(isBoardUnavailable(failure("verb-refused"))).toBe(true);
    expect(isBoardUnavailable(failure("operation-unavailable"))).toBe(true);
    expect(isBoardUnavailable(failure("workspace-unknown"))).toBe(true);
    expect(isBoardUnavailable(failure("host-unreachable"))).toBe(false);
    expect(isBoardUnavailable(failure())).toBe(false);
    expect(isBoardUnavailable(new Error("x"))).toBe(false);
    expect(isBoardUnavailable(null)).toBe(false);
  });
});

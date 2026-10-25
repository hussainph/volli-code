import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeCloud, refusal } from "./fake-cloud.test-support";
import type { CloudTicketRow } from "./projection";
import {
  CLOUD_READ_ONLY,
  BOARD_NOT_LOADED,
  CLOUD_WRITES_UNAVAILABLE,
  ConvexBoardSource,
  LABEL_PENDING,
  UNCONFIRMED_AFTER_MS,
  type CloudBoardView,
} from "./source";

const P = "00000000-0000-4000-8000-0000000000aa";
const tid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function row(n: number, overrides: Partial<CloudTicketRow> = {}) {
  return {
    id: tid(n),
    projectId: P,
    number: n,
    title: `T${n}`,
    status: "todo" as const,
    priority: "medium" as const,
    position: `a${n}`,
    labelIds: [] as string[],
    assigneeUserId: null,
    checkoutMode: "worktree",
    preferredHarnessId: "claude-code",
    branch: null,
    baseBranch: null,
    retentionKeep: false,
    placeRunnerId: null,
    archivedAt: null,
    pullRequests: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function view() {
  return {
    paint: vi.fn<CloudBoardView["paint"]>(),
    notePlanningChange: vi.fn<CloudBoardView["notePlanningChange"]>(),
    failed: vi.fn<CloudBoardView["failed"]>(),
    refused: vi.fn<CloudBoardView["refused"]>(),
    unconfirmed: vi.fn<CloudBoardView["unconfirmed"]>(),
    readOnly: vi.fn<CloudBoardView["readOnly"]>(() => null),
    dropped: vi.fn<CloudBoardView["dropped"]>(),
  };
}

async function setup(tickets = [row(1), row(2), row(3, { status: "doing", position: "a0" })]) {
  const cloud = fakeCloud();
  const screen = view();
  const source = new ConvexBoardSource(screen, "user-1");
  source.attach(cloud.session);
  await source.open(P);
  cloud.answer("board:roster", { projectId: P }, { tickets, labels: [] });
  const lastPaint = () => screen.paint.mock.calls.at(-1)![1];
  return { cloud, screen, source, lastPaint };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the cloud board's writes (VC-889)", () => {
  it("refuses at once, and issues nothing, while not connected or read-only", async () => {
    const { cloud, screen, source } = await setup();
    cloud.connected = false;
    await source.moveTickets(P, [tid(1)], "doing", 0);
    expect(screen.refused).toHaveBeenLastCalledWith(CLOUD_READ_ONLY);
    cloud.connected = true;
    screen.readOnly.mockReturnValueOnce("Can’t reach Volli Cloud · Read-only");
    await source.setPriority(P, tid(1), "high");
    expect(screen.refused).toHaveBeenLastCalledWith("Can’t reach Volli Cloud · Read-only");
    expect(cloud.mutations).toEqual([]);
    // No client at all is not connected either.
    const detached = new ConvexBoardSource(view(), "user-1");
    expect(await detached.archiveTicket(P, tid(1))).toBe(false);
  });

  it("moves with the drop's neighbours, painting before the answer", async () => {
    const { cloud, source, lastPaint } = await setup();
    const moving = source.moveTickets(P, [tid(3)], "todo", 1, { kind: "move-only" });
    // Painted at once: the card sits between T1 and T2.
    const todo = lastPaint().filter(({ status }) => status === "todo");
    expect(todo.map(({ ticketNumber }) => ticketNumber)).toEqual([1, 3, 2]);
    const [mutation] = cloud.mutations;
    expect(mutation).toMatchObject({
      name: "board:moveTickets",
      args: {
        projectId: P,
        ticketIds: [tid(3)],
        toStatus: "todo",
        afterTicketId: tid(1),
        beforeTicketId: tid(2),
        choice: { kind: "move-only" },
      },
    });
    mutation!.resolve({ moved: [tid(3)], unstartedRuns: [] });
    await moving;
  });

  it("says when a picked Automation has nowhere to run, and when a write goes unanswered", async () => {
    vi.useFakeTimers();
    const { cloud, screen, source } = await setup();
    const moving = source.moveTickets(P, [tid(1)], "doing", 0);
    await vi.advanceTimersByTimeAsync(UNCONFIRMED_AFTER_MS);
    expect(screen.unconfirmed).toHaveBeenCalledWith("Still saving to Volli Cloud…");
    cloud.mutations[0]!.resolve({ moved: [tid(1)], unstartedRuns: ["run"] });
    await moving;
    expect(screen.unconfirmed).toHaveBeenLastCalledWith(
      "The picked Automation has nowhere to run yet.",
    );
    // A socket that dropped meanwhile does not add the warning (the Island says it).
    const second = source.moveTickets(P, [tid(2)], "doing", 0);
    cloud.connected = false;
    await vi.advanceTimersByTimeAsync(UNCONFIRMED_AFTER_MS);
    expect(screen.unconfirmed).toHaveBeenCalledTimes(2);
    cloud.mutations[1]!.resolve({ moved: [], unstartedRuns: [] });
    await second;
  });

  it("says the backend's refusal, and leaves a project it can no longer write", async () => {
    const { cloud, screen, source, lastPaint } = await setup();
    const move = source.moveTickets(P, [tid(1)], "doing", 0);
    expect(lastPaint().find(({ id }) => id === tid(1))?.status).toBe("doing");
    cloud.mutations[0]!.reject(refusal("invalid_position", "Out of order."));
    await move;
    // Rolled back: the card is where it was.
    expect(lastPaint().find(({ id }) => id === tid(1))?.status).toBe("todo");
    expect(screen.failed).toHaveBeenLastCalledWith("Couldn’t move ticket: Out of order.");
    // A write's not_found names what it named, never the project: it stays.
    const stale = source.moveTickets(P, [tid(1)], "doing", 0);
    cloud.mutations[1]!.reject(
      refusal("not_found", "A move names a neighbour that does not exist."),
    );
    await stale;
    expect(source.follows(P)).toBe(true);
    expect(screen.dropped).not.toHaveBeenCalled();
    const group = source.moveTickets(P, [tid(1), tid(2)], "done", 0);
    cloud.mutations[2]!.reject(refusal("not_a_member", "Not a Member."));
    await group;
    // Said once: the drop says why, with no second "Couldn't" line.
    expect(screen.dropped).toHaveBeenCalledWith(P, "Not a Member.");
    expect(screen.failed).toHaveBeenCalledTimes(2);
    expect(source.follows(P)).toBe(false);
    // A board it no longer follows has no place to drop into: refused, never issued.
    await source.moveTickets(P, [tid(1)], "doing", 0);
    expect(screen.refused).toHaveBeenLastCalledWith(BOARD_NOT_LOADED);
    expect(cloud.mutations).toHaveLength(3);
  });

  it("creates with its own id and no key, answering the card as the board paints it", async () => {
    const { cloud, source, lastPaint } = await setup([]);
    const creating = source.createTicket(P, {
      status: "todo",
      title: "New",
      body: "# Body",
      priority: "high",
      labels: ["bug"],
      usesWorktree: false,
      preferredHarnessId: "codex",
      baseBranch: "main",
    });
    expect(lastPaint()).toMatchObject([{ title: "New", ticketNumber: 0, body: "# Body" }]);
    const [mutation] = cloud.mutations;
    expect(mutation!.args).toMatchObject({
      title: "New",
      body: "# Body",
      priority: "high",
      labels: ["bug"],
      checkoutMode: "main_checkout",
      preferredHarnessId: "codex",
      baseBranch: "main",
    });
    mutation!.resolve({ ticketId: mutation!.args["ticketId"], number: 1, key: "VC-1" });
    expect(await creating).toMatchObject({ title: "New", usesWorktree: false });

    const worktree = source.createTicket(P, { status: "doing", title: "Two", usesWorktree: true });
    expect(cloud.mutations[1]!.args).toMatchObject({ checkoutMode: "worktree" });
    cloud.mutations[1]!.resolve({});
    await worktree;
    const refused = source.createTicket(P, { status: "todo", title: "Three", body: "x" });
    cloud.mutations[2]!.reject(new Error("offline"));
    expect(await refused).toBeNull();
  });

  it("answers an accepted card even when the board cannot be read, never 'not created'", async () => {
    const cloud = fakeCloud();
    const source = new ConvexBoardSource(view(), "user-1");
    source.attach(cloud.session);
    const creating = source.createTicket(P, { status: "todo", title: " New " });
    cloud.mutations[0]!.resolve({ number: 4 });
    expect(await creating).toMatchObject({
      title: "New",
      ticketNumber: 4,
      body: "",
      priority: "medium",
      labels: [],
      usesWorktree: true,
      preferredHarnessId: "claude-code",
      baseBranch: null,
    });
    // A watched board not answered yet, or whose roster read fails, answers the same way.
    await source.open(P);
    const unanswered = source.createTicket(P, {
      status: "doing",
      title: "Two",
      body: "b",
      priority: "low",
      labels: ["x"],
      usesWorktree: false,
      preferredHarnessId: "codex",
      baseBranch: "main",
    });
    cloud.mutations[1]!.resolve({ number: 5 });
    expect(await unanswered).toMatchObject({
      ticketNumber: 5,
      status: "doing",
      body: "b",
      priority: "low",
      labels: ["x"],
      usesWorktree: false,
      preferredHarnessId: "codex",
      baseBranch: "main",
    });
    cloud.fail("board:roster", { projectId: P }, new Error("down"));
    const second = source.createTicket(P, { status: "todo", title: "Three" });
    cloud.mutations[2]!.resolve({ number: 6 });
    expect(await second).toMatchObject({ ticketNumber: 6 });
    const restoring = source.unarchiveTicket(P, {
      id: tid(9),
      title: "Old",
      archivedAt: 3,
    } as never);
    cloud.mutations[3]!.resolve({});
    expect(await restoring).toEqual({ id: tid(9), title: "Old" });
  });

  it("updates a ticket's fields, priority and labels, and never a runner's branch", async () => {
    const { cloud, screen, source, lastPaint } = await setup();
    const updating = source.updateTicket(P, { ticketId: tid(1), title: "Renamed", body: "b" });
    expect(lastPaint()[0]).toMatchObject({ title: "Renamed" });
    cloud.mutations[0]!.resolve({});
    expect(await updating).toMatchObject({ title: "Renamed", body: "b" });
    const scoping = source.updateTicket(P, { ticketId: tid(1), usesWorktree: false });
    expect(cloud.mutations[1]!.args).toMatchObject({ checkoutMode: "main_checkout" });
    cloud.mutations[1]!.reject(refusal("checkout_mode_locked", "Already has a worktree."));
    expect(await scoping).toBeNull();
    void source.updateTicket(P, { ticketId: tid(1), usesWorktree: true });
    expect(cloud.mutations[2]!.args).toMatchObject({ checkoutMode: "worktree" });
    cloud.mutations[2]!.resolve({});

    expect(await source.updateTicket(P, { ticketId: tid(1), branch: "x" })).toBeNull();
    expect(screen.refused).toHaveBeenLastCalledWith(CLOUD_WRITES_UNAVAILABLE);

    void source.setPriority(P, tid(2), "low");
    void source.setLabels(P, tid(2), ["bug"]);
    expect(cloud.mutations.slice(3).map(({ args }) => args)).toEqual([
      expect.objectContaining({ ticketId: tid(2), priority: "low" }),
      expect.objectContaining({ ticketId: tid(2), labels: ["bug"] }),
    ]);
  });

  it("recolors a label, archives and unarchives, and offers no delete", async () => {
    const { cloud, screen, source, lastPaint } = await setup();
    void source.setLabelColor(P, "l1", "#ff0000");
    expect(cloud.mutations[0]).toMatchObject({
      name: "board:setLabelColor",
      args: { labelId: "l1", color: "#ff0000" },
    });
    const archiving = source.archiveTicket(P, tid(2));
    expect(lastPaint().map(({ id }) => id)).not.toContain(tid(2));
    cloud.mutations[1]!.resolve({});
    expect(await archiving).toBe(true);
    const restoring = source.unarchiveTicket(P, { ...lastPaint()[0]!, archivedAt: 1 });
    expect(cloud.mutations[2]).toMatchObject({ name: "board:unarchiveTicket" });
    cloud.mutations[2]!.resolve({});
    expect(await restoring).toMatchObject({ id: tid(1) });
    // One the roster does not hold (yet) answers as accepted.
    const offBoard = source.unarchiveTicket(P, {
      id: tid(8),
      title: "Gone",
      archivedAt: 1,
    } as never);
    cloud.mutations.at(-1)!.resolve({});
    expect(await offBoard).toEqual({ id: tid(8), title: "Gone" });
    // A label the backend has not named yet cannot be recolored.
    await source.setLabelColor(P, "pending:abc", null);
    expect(screen.refused).toHaveBeenLastCalledWith(LABEL_PENDING);
    const refused = source.unarchiveTicket(P, { id: tid(9) } as never);
    cloud.mutations.at(-1)!.reject(new Error("gone"));
    expect(await refused).toBeNull();
    expect(await source.deleteTicket(P, tid(1))).toBe(false);
    expect(screen.refused).toHaveBeenLastCalledWith(CLOUD_WRITES_UNAVAILABLE);
  });

  it("writes comments, answering the outcome for the caller to say", async () => {
    const { cloud, screen, source } = await setup();
    cloud.answer("board:comments", { ticketId: tid(1) }, []);
    const created = source.createComment(tid(1), "hi");
    expect(cloud.mutations[0]!.args).toMatchObject({ ticketId: tid(1), body: "hi" });
    cloud.mutations[0]!.resolve({});
    expect(await created).toMatchObject({ ok: true, comment: { body: "hi", actor: "user" } });
    const edited = source.updateComment(tid(1), "c1", "edit");
    cloud.mutations[1]!.resolve({});
    expect(await edited).toEqual({ ok: true });
    const removed = source.removeComment(tid(1), "c1");
    cloud.mutations[2]!.reject(refusal("forbidden", "Not yours."));
    expect(await removed).toEqual({ ok: false, error: "Not yours." });
    const failedEdit = source.updateComment(tid(1), "c1", "x");
    cloud.mutations[3]!.reject(new Error("down"));
    expect(await failedEdit).toEqual({ ok: false, error: "down" });
    const removedAgain = source.removeComment(tid(1), "c1");
    cloud.mutations[4]!.resolve({});
    expect(await removedAgain).toEqual({ ok: true });
    cloud.connected = false;
    expect(await source.createComment(tid(1), "later")).toEqual({
      ok: false,
      error: CLOUD_READ_ONLY,
    });
    // A comment on a ticket of no followed board (one the offline snapshot
    // painted) asks about Volli Cloud itself.
    cloud.connected = true;
    screen.readOnly.mockReturnValueOnce(CLOUD_READ_ONLY);
    expect(await source.createComment("unknown", "x")).toEqual({
      ok: false,
      error: CLOUD_READ_ONLY,
    });
    expect(screen.readOnly).toHaveBeenLastCalledWith(undefined);
    const orphan = source.createComment("unknown", "x");
    cloud.mutations[5]!.resolve({});
    expect(await orphan).toMatchObject({ ok: true });
    expect(screen.failed).not.toHaveBeenCalled();
  });
});

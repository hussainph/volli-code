// @vitest-environment node
/**
 * The board (VC-565) through the PRODUCTION listener: `startHostProtocolListener`
 * serving the composed host router, a fresh hello per connection, and the
 * stock tRPC WebSocket client. The host behind it is `fakeBoard()`, an
 * in-memory board with a receipt map and a feed the test drives; nothing
 * hands the router a context but the listener's handshake.
 *
 * `apps/hostd`'s "serves the board to a verified device" runs the same
 * operations against the real host; this file pins the contract every board
 * door owes, so it runs without a database.
 */
import { getUntypedClient } from "@trpc/client";
import { buildHostHello, encodeHostHello, HOST_FEATURE_OPERATIONS } from "@volli/host-protocol";
import {
  describeContract,
  expectHostError,
  recordSubscription,
  servedWebSocketContractLink,
} from "@volli/host-protocol/testing";
import { expect, it, vi } from "vite-plus/test";

import {
  BOARD_DEVICE,
  BOARD_HOST,
  BOARD_WORKSPACE,
  FEED_INSTANCE,
  OTHER_WORKSPACE,
  fakeBoard,
  type FakeBoard,
} from "./board-host.test-support";
import { WORKSPACE_UNKNOWN_MESSAGE } from "./catalog";
import { createHostRouter, type HostRouter } from "./host-router";
import { RpcDiagnosticLog } from "./index";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import { startHostProtocolListener } from "./websocket-server";

const BOARD_FEATURES = ["board.read", "board.write"] as const;
const COMMAND = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SECOND_COMMAND = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const THIRD_COMMAND = "9b2e4c1a-7d3f-4e8b-a6c5-1f0d2e3b4a59";

interface BoardHost {
  readonly board: FakeBoard;
  /** What the listener offers; the board's two features unless a case says otherwise. */
  readonly offered?: readonly string[];
  /** What the client's hello requests; the board's two features unless a case says otherwise. */
  readonly requested?: readonly string[];
}

const link = servedWebSocketContractLink<BoardHost, HostRouter>({
  serve: (host) =>
    startHostProtocolListener({
      router: createHostRouter(),
      bind: { host: "127.0.0.1", port: 0 },
      host: { id: BOARD_HOST, version: "board-contract" },
      workspace: (id) => (id === BOARD_WORKSPACE ? { id, epoch: 1 } : null),
      verifier: {
        verify: async () => ({
          actor: { kind: "device", deviceId: BOARD_DEVICE, workspaceId: BOARD_WORKSPACE },
          current: () => true,
        }),
      },
      features: host.offered ?? [...BOARD_FEATURES, "sessions", "session.read"],
      context: () => ({
        handlers: { ...sessionHandlersFrom({ runtime: {} }), ...host.board.handlers },
        diagnostics: new RpcDiagnosticLog(),
        resourceWorkspace: (resource) => host.board.resourceWorkspace(resource),
      }),
    }),
  connectionParams: (host) =>
    encodeHostHello(
      buildHostHello({
        client: { kind: "desktop", version: "board-contract" },
        workspaceId: BOARD_WORKSPACE,
        lastSeen: null,
        features: host.requested ?? BOARD_FEATURES,
        credential: "test-only-credential",
      }),
    ),
});

type Frame = { id: string; data: { cursor: string; changes: Record<string, unknown>[] } };

describeContract("the board", [link], ({ connect }) => {
  it("reads one Workspace's board, its tickets' parts and its feed cursor", async () => {
    const board = fakeBoard();
    const client = await connect({ board });
    expect((await client.protocol.welcome.query()).features).toEqual([...BOARD_FEATURES]);
    const snapshot = await client.board.snapshot.query({ projectId: BOARD_WORKSPACE });
    expect(snapshot.project).toMatchObject({
      id: BOARD_WORKSPACE,
      name: "Board",
      ticketPrefix: "VC",
    });
    expect(snapshot.project.skillModes).toEqual({ "code-review": "manual" });
    expect(snapshot.project.sessionModel).toEqual({
      providerId: "anthropic",
      modelId: "model-a",
      reasoningLevel: "high",
    });
    expect(snapshot.tickets.map(({ id }) => id)).toEqual(["ticket-a", "ticket-b"]);
    expect(snapshot.labels.map(({ id }) => id)).toEqual(["label-ui"]);
    expect(snapshot.cursor).toBe(`${FEED_INSTANCE}:0`);
    const roster = await client.board.roster.query({ projectId: BOARD_WORKSPACE });
    expect(roster.tickets.map(({ id }) => id)).toEqual(["ticket-a", "ticket-b"]);
    for (const summary of roster.tickets) expect(summary).not.toHaveProperty("body");
    expect(await client.board.ticketBody.query({ ticketId: "ticket-a" })).toEqual({
      body: "First card, in Markdown.",
    });
    expect(await client.board.projectFolder.query({ projectId: BOARD_WORKSPACE })).toEqual({
      path: "/work/vc",
      state: "present",
    });
    expect(
      (await client.board.archivedTickets.query({ projectId: BOARD_WORKSPACE })).map(
        ({ id, archivedAt }) => [id, archivedAt],
      ),
    ).toEqual([["ticket-c", 300]]);
    expect(await client.board.ticketEvents.query({ ticketId: "ticket-a" })).toMatchObject([
      { id: "event-a", payload: { kind: "created", title: "First card" } },
      {
        id: "event-b",
        actorContext: { sessionId: "session-a", ticketId: "ticket-a" },
        payload: { kind: "commented", commentId: "comment-a" },
      },
    ]);
    expect(await client.board.latestSignals.query({ projectId: BOARD_WORKSPACE })).toEqual([
      {
        ticketId: "ticket-b",
        sessionId: "session-b",
        signal: "blocked",
        reason: "Needs a key",
        createdAt: 270,
      },
    ]);
    expect(await client.board.statusEntries.query({ projectId: BOARD_WORKSPACE })).toEqual([
      { ticketId: "ticket-a", status: "todo", enteredAt: 200 },
      { ticketId: "ticket-b", status: "doing", enteredAt: 200 },
    ]);
    expect(
      (await client.board.comments.query({ ticketId: "ticket-a" })).map(({ id }) => id),
    ).toEqual(["comment-a"]);
    expect(board.effects).toEqual([]);
  });

  it("records a write once under its commandId, and answers its retry from the receipt", async () => {
    const board = fakeBoard();
    const client = await connect({ board });
    const input = {
      commandId: COMMAND,
      projectId: BOARD_WORKSPACE,
      status: "todo" as const,
      title: "Over the wire",
      labels: ["ui", "remote"],
    };
    const created = await client.board.createTicket.mutate(input);
    expect(created.receipt).toEqual({ commandId: COMMAND, status: "completed", replayed: false });
    expect(created.ticket).toMatchObject({
      title: "Over the wire",
      ticketNumber: 4,
      labels: ["ui", "remote"],
    });
    const retried = await client.board.createTicket.mutate(input);
    expect(retried).toStrictEqual({ ...created, receipt: { ...created.receipt, replayed: true } });
    // One effect: one ticket on the board, one command run.
    expect(board.effects).toEqual(["board.createTicket"]);
    expect((await client.board.roster.query({ projectId: BOARD_WORKSPACE })).tickets).toHaveLength(
      3,
    );
    // The same id for another intent is the client's conflict, and runs nothing.
    expect(
      await expectHostError(
        client.board.createTicket.mutate({ ...input, title: "Something else" }),
      ),
    ).toMatchObject({ code: "CONFLICT", reason: "command-conflict" });
    expect(board.effects).toEqual(["board.createTicket"]);
  });

  it("serves every board write with its receipt", async () => {
    const board = fakeBoard();
    const client = await connect({ board });
    let n = 0;
    const nextCommand = () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
    const projectId = BOARD_WORKSPACE;
    const answers = [
      await client.board.updateProject.mutate({
        commandId: nextCommand(),
        projectId,
        baseBranch: "trunk",
        setupCommand: "make",
      }),
      await client.board.setSkillModes.mutate({
        commandId: nextCommand(),
        projectId,
        modes: { deploy: "off" },
      }),
      await client.board.setSessionDefaults.mutate({
        commandId: nextCommand(),
        projectId,
        model: null,
      }),
      await client.board.createTicket.mutate({
        commandId: nextCommand(),
        projectId,
        status: "backlog",
        title: "Every field",
        priority: "low",
        body: "Body",
        usesWorktree: false,
        preferredHarnessId: "codex",
        baseBranch: null,
      }),
      await client.board.moveTickets.mutate({
        commandId: nextCommand(),
        projectId,
        ticketIds: ["ticket-a"],
        toStatus: "doing",
        toIndex: 0,
      }),
      await client.board.moveTickets.mutate({
        commandId: nextCommand(),
        projectId,
        ticketIds: ["ticket-a", "ticket-b"],
        toStatus: "needs_review",
        toIndex: 1,
      }),
      await client.board.setPriority.mutate({
        commandId: nextCommand(),
        ticketId: "ticket-a",
        priority: "low",
      }),
      await client.board.updateTicket.mutate({
        commandId: nextCommand(),
        ticketId: "ticket-a",
        title: "Renamed",
        branch: null,
      }),
      await client.board.setLabels.mutate({
        commandId: nextCommand(),
        ticketId: "ticket-a",
        labels: ["ui", "new"],
      }),
      await client.board.archiveTicket.mutate({ commandId: nextCommand(), ticketId: "ticket-b" }),
      await client.board.unarchiveTicket.mutate({ commandId: nextCommand(), ticketId: "ticket-c" }),
      await client.board.deleteTicket.mutate({ commandId: nextCommand(), ticketId: "ticket-b" }),
      await client.board.createComment.mutate({
        commandId: nextCommand(),
        ticketId: "ticket-a",
        body: "Noted",
      }),
      await client.board.createComment.mutate({
        commandId: nextCommand(),
        ticketId: "ticket-a",
        body: "From a Session",
        sessionId: "session-a",
      }),
      await client.board.updateComment.mutate({
        commandId: nextCommand(),
        commentId: "comment-a",
        body: "Edited",
      }),
      await client.board.removeComment.mutate({ commandId: nextCommand(), commentId: "comment-a" }),
      await client.board.setLabelColor.mutate({
        commandId: nextCommand(),
        labelId: "label-ui",
        color: "#abcdef",
      }),
    ];
    expect(answers.map(({ receipt }) => receipt.commandId)).toEqual(
      Array.from(
        { length: answers.length },
        (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ),
    );
    expect(
      answers.every(({ receipt }) => receipt.status === "completed" && !receipt.replayed),
    ).toBe(true);
    expect(board.effects).toHaveLength(answers.length);
    expect(
      await client.ticket.move.mutate({ projectId, ticketId: "ticket-a", toStatus: "done" }),
    ).toEqual({ ticket: { id: "ticket-a", status: "done", order: 1 } });
    const snapshot = await client.board.snapshot.query({ projectId });
    expect(snapshot.project).toMatchObject({
      baseBranch: "trunk",
      setupCommand: "make",
      skillModes: { deploy: "off" },
      sessionModel: null,
    });
    expect(snapshot.tickets.map(({ id, title }) => [id, title])).toEqual([
      ["ticket-a", "Renamed"],
      ["ticket-c", "Shelved card"],
      ["ticket-1", "Every field"],
    ]);
    expect(snapshot.labels).toEqual([
      { id: "label-ui", projectId, name: "ui", color: "#abcdef" },
      { id: "label-2", projectId, name: "new", color: null },
    ]);
    expect(
      (await client.board.comments.query({ ticketId: "ticket-a" })).map(({ body, sessionId }) => [
        body,
        sessionId,
      ]),
    ).toEqual([
      ["Noted", null],
      ["From a Session", "session-a"],
    ]);
  });

  it("answers another Workspace's ticket, comment, label and board exactly as absent ones, before the handler", async () => {
    const board = fakeBoard();
    const client = await connect({
      board,
      requested: [...BOARD_FEATURES, "sessions", "session.read"],
    });
    const refusals = await Promise.all([
      expectHostError(client.board.snapshot.query({ projectId: OTHER_WORKSPACE })),
      expectHostError(client.board.ticketBody.query({ ticketId: "ticket-x" })),
      expectHostError(
        client.board.updateComment.mutate({
          commandId: COMMAND,
          commentId: "comment-x",
          body: "Hi",
        }),
      ),
      expectHostError(
        client.board.setLabelColor.mutate({ commandId: COMMAND, labelId: "label-x", color: null }),
      ),
      expectHostError(client.board.ticketBody.query({ ticketId: "ticket-none" })),
      expectHostError(
        client.board.removeComment.mutate({ commandId: COMMAND, commentId: "comment-none" }),
      ),
      expectHostError(
        client.board.setLabelColor.mutate({
          commandId: COMMAND,
          labelId: "label-none",
          color: null,
        }),
      ),
      expectHostError(
        client.board.snapshot.query({ projectId: "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }),
      ),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toStrictEqual({
        code: "NOT_FOUND",
        reason: "workspace-unknown",
        message: WORKSPACE_UNKNOWN_MESSAGE,
      });
    }
    // A Session-family Workspace read answers with the same envelope.
    expect(
      await expectHostError(client.session.list.query({ projectId: OTHER_WORKSPACE })),
    ).toStrictEqual(refusals[0]);
    // The one port answers every family's kinds: a Session is no board kind,
    // and the board's answer for it is no Workspace.
    expect(
      await expectHostError(client.session.snapshot.query({ sessionId: "session-a" })),
    ).toStrictEqual(refusals[0]);
    expect(board.reached).toEqual([]);
  });

  it("refuses every write without board.write before reading its input, and still reads", async () => {
    const board = fakeBoard();
    const client = await connect({ board, requested: ["board.read", "future.area"] });
    expect((await client.protocol.welcome.query()).features).toEqual(["board.read"]);
    const raw = getUntypedClient(client);
    for (const path of HOST_FEATURE_OPERATIONS["board.write"]) {
      expect(await expectHostError(raw.mutation(path, { malformed: true }))).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
    expect(board.reached).toEqual([]);
    await client.board.roster.query({ projectId: BOARD_WORKSPACE });
    expect(board.reached).toEqual(["board.roster"]);
  });

  it("delivers the feed as tracked frames naming the command, and resumes after lastEventId", async () => {
    const board = fakeBoard();
    const client = await connect({ board });
    const { cursor } = await client.board.snapshot.query({ projectId: BOARD_WORKSPACE });
    const live = recordSubscription<Frame>((handlers) =>
      client.board.changes.subscribe(
        { projectId: BOARD_WORKSPACE, lastEventId: cursor },
        handlers as never,
      ),
    );
    await live.started;
    await vi.waitFor(() => expect(board.listeners()).toBe(1));
    await client.board.setPriority.mutate({
      commandId: COMMAND,
      ticketId: "ticket-a",
      priority: "low",
    });
    const [first] = await live.received(1);
    expect(first).toMatchObject({
      id: `${FEED_INSTANCE}:1`,
      data: {
        cursor: `${FEED_INSTANCE}:1`,
        changes: [
          {
            kind: "ticket",
            op: "upsert",
            id: "ticket-a",
            commandId: COMMAND,
            ticket: { priority: "low" },
          },
        ],
      },
    });
    expect(first!.data.changes[0]!.ticket).not.toHaveProperty("body");
    live.unsubscribe();
    await vi.waitFor(() => expect(board.listeners()).toBe(0));

    // Written while no one listened, and replayed strictly after the last applied id.
    await client.board.setPriority.mutate({
      commandId: SECOND_COMMAND,
      ticketId: "ticket-b",
      priority: "low",
    });
    const resumed = recordSubscription<Frame>((handlers) =>
      client.board.changes.subscribe(
        { projectId: BOARD_WORKSPACE, lastEventId: first!.id },
        handlers as never,
      ),
    );
    const [replayed] = await resumed.received(1);
    expect(replayed).toMatchObject({
      id: `${FEED_INSTANCE}:2`,
      data: { changes: [{ id: "ticket-b", commandId: SECOND_COMMAND }] },
    });
    expect(board.afters).toEqual([cursor, first!.id]);

    // Naming no cursor opens at the head: nothing replayed, the next change live.
    const head = recordSubscription<Frame>((handlers) =>
      client.board.changes.subscribe({ projectId: BOARD_WORKSPACE }, handlers as never),
    );
    await vi.waitFor(() => expect(board.listeners()).toBe(2));
    await client.board.setLabelColor.mutate({
      commandId: THIRD_COMMAND,
      labelId: "label-ui",
      color: "#000000",
    });
    const [live3] = await head.received(1);
    expect(live3).toMatchObject({
      id: `${FEED_INSTANCE}:3`,
      data: { changes: [{ kind: "label", id: "label-ui", commandId: THIRD_COMMAND }] },
    });
    expect((await resumed.received(2))[1]).toStrictEqual(live3);
    expect(head.frames).toHaveLength(1);
    expect(board.afters).toEqual([cursor, first!.id, null]);
    resumed.unsubscribe();
    head.unsubscribe();
    await vi.waitFor(() => expect(board.listeners()).toBe(0));
  });

  it("answers a cursor this feed never minted subscription-resnapshot-required", async () => {
    const board = fakeBoard();
    const client = await connect({ board });
    const stale = recordSubscription((handlers) =>
      client.board.changes.subscribe(
        { projectId: BOARD_WORKSPACE, lastEventId: "feed-b:4" },
        handlers as never,
      ),
    );
    expect(await stale.ended).toMatchObject({
      kind: "error",
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(board.afters).toEqual(["feed-b:4"]);
    expect(board.listeners()).toBe(0);
  });
});

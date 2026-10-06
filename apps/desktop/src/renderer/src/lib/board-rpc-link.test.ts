/**
 * The renderer's board link (VC-565) over a fake bridge: every answer the
 * bridge can give, every frame order main can produce, and what the caller
 * sees for each, read through `readHostError` as the board's sync engine
 * reads it on either link.
 */
import { TRPCClientError, type Operation } from "@trpc/client";
import { readHostError } from "@volli/host-protocol";
import { describe, expect, it } from "vite-plus/test";

import type {
  BoardRpcIpcEvent,
  BoardRpcIpcRequest,
  BoardRpcIpcResponse,
} from "../../../ipc/contract";
import { boardRpcIpcLink, createBoardIpcClient, type BoardRpcBridge } from "./board-rpc-link";

const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const COMMAND = "0f8fad5b-d9cb-469f-a165-70867728950e";

interface FakeBridge extends BoardRpcBridge {
  readonly requests: BoardRpcIpcRequest[];
  readonly cancelled: string[];
  /** Answers the oldest unanswered request. */
  reply(response: BoardRpcIpcResponse): void;
  /** Rejects the oldest unanswered request, as `ipcRenderer.invoke` does when main is gone. */
  fail(cause: unknown): void;
  emit(event: BoardRpcIpcEvent): void;
  listenerCount(): number;
}

function fakeBridge(): FakeBridge {
  const requests: BoardRpcIpcRequest[] = [];
  const cancelled: string[] = [];
  const listeners = new Set<(event: BoardRpcIpcEvent) => void>();
  const pending: { resolve(value: BoardRpcIpcResponse): void; reject(cause: unknown): void }[] = [];
  const next = () => {
    const oldest = pending.shift();
    if (oldest === undefined) throw new Error("No board request is awaiting an answer");
    return oldest;
  };
  return {
    requests,
    cancelled,
    request: (request) => {
      requests.push(structuredClone(request));
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: (subscriptionId) => void cancelled.push(subscriptionId),
    reply: (response) => next().resolve(response),
    fail: (cause) => next().reject(cause),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

/** Lets every queued microtask run: the link settles on promises. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  return {
    started: 0,
    data: [] as unknown[],
    errors: [] as unknown[],
    completed: 0,
  };
}

function follow(client: ReturnType<typeof createBoardIpcClient>, lastEventId?: string) {
  const seen = recorder();
  const subscription = client.board.changes.subscribe(
    lastEventId === undefined ? { projectId: PROJECT } : { projectId: PROJECT, lastEventId },
    {
      onStarted: () => void (seen.started += 1),
      onData: (frame) => void seen.data.push(frame),
      onError: (error) => void seen.errors.push(error),
      onComplete: () => void (seen.completed += 1),
    },
  );
  return { seen, subscription };
}

function batch(cursor: string) {
  return {
    cursor,
    changes: [{ kind: "ticket", op: "upsert", id: "ticket-1", projectId: PROJECT }],
  };
}

describe("the board link's calls", () => {
  it("sends a query by path and input, and resolves the bridge's data", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.ticketBody.query({ ticketId: "ticket-1" });
    await flush();
    expect(bridge.requests).toEqual([
      { path: "board.ticketBody", input: { ticketId: "ticket-1" } },
    ]);
    bridge.reply({ ok: true, data: { body: "Markdown." } });
    await expect(answer).resolves.toEqual({ body: "Markdown." });
  });

  it("sends a mutation the same way", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const input = { commandId: COMMAND, ticketId: "ticket-1", priority: "high" as const };
    const answer = client.board.setPriority.mutate(input);
    await flush();
    expect(bridge.requests).toEqual([{ path: "board.setPriority", input }]);
    const data = {
      receipt: { commandId: COMMAND, status: "completed", replayed: false },
      throughCursor: "feed:1",
      ticket: { id: "ticket-1" },
    };
    bridge.reply({ ok: true, data });
    await expect(answer).resolves.toEqual(data);
  });

  it("rejects with the router's envelope on data.hostError, its reason forwarded", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.ticketBody.query({ ticketId: "ticket-1" });
    await flush();
    bridge.reply({
      ok: false,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "The board is unavailable",
        reason: "operation-unavailable",
      },
    });
    const error = await answer.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect((error as TRPCClientError<never>).message).toBe("The board is unavailable");
    expect((error as TRPCClientError<never>).data).toMatchObject({
      code: "NOT_IMPLEMENTED",
      httpStatus: 501,
      path: "board.ticketBody",
    });
    expect(readHostError(error)).toEqual({
      code: "NOT_IMPLEMENTED",
      message: "The board is unavailable",
      reason: "operation-unavailable",
    });
  });

  it("rejects without a reason when the router gave none", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.snapshot.query({ projectId: PROJECT });
    await flush();
    bridge.reply({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid board request" } });
    const error = await answer.catch((caught: unknown) => caught);
    expect((error as { data: { hostError: unknown } }).data.hostError).toEqual({
      code: "BAD_REQUEST",
      message: "Invalid board request",
    });
    expect((error as TRPCClientError<never>).data).toMatchObject({ httpStatus: 400 });
  });

  it("reads a code tRPC does not know as INTERNAL_SERVER_ERROR", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.snapshot.query({ projectId: PROJECT });
    await flush();
    bridge.reply({ ok: false, error: { code: "TEAPOT", message: "Something new" } });
    expect(readHostError(await answer.catch((caught: unknown) => caught))).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Something new",
    });
  });

  it("answers a bridge that rejects as an unreachable host, the outcome unknown", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.archiveTicket.mutate({ commandId: COMMAND, ticketId: "ticket-1" });
    await flush();
    bridge.fail(new Error("No handler registered for 'volli:board-rpc'"));
    const error = await answer.catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("No handler registered for 'volli:board-rpc'");
    expect(readHostError(error)).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "No handler registered for 'volli:board-rpc'",
      reason: "host-unreachable",
    });
  });

  it("names a bridge rejection that is not an Error by its own words", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.roster.query({ projectId: PROJECT });
    await flush();
    bridge.fail("gone");
    expect(readHostError(await answer.catch((caught: unknown) => caught))).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "The board bridge is unreachable",
      reason: "host-unreachable",
    });
  });

  it("refuses a subscription's ack answered to a call", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const answer = client.board.snapshot.query({ projectId: PROJECT });
    await flush();
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    expect(readHostError(await answer.catch((caught: unknown) => caught))).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "board.snapshot answered a subscription",
    });
  });

  it("answers CLIENT_CLOSED_REQUEST for a call its caller abandoned, dropping the late answer", async () => {
    const bridge = fakeBridge();
    const link = boardRpcIpcLink(bridge)({} as never);
    const abort = new AbortController();
    const outcomes: { kind: string; value: unknown }[] = [];
    link({
      op: {
        id: 1,
        type: "mutation",
        path: "board.deleteTicket",
        input: { commandId: COMMAND, ticketId: "ticket-1" },
        context: {},
        signal: abort.signal,
      } as Operation,
      next: () => {
        throw new Error("A terminating link calls no next link");
      },
    }).subscribe({
      next: (value) => outcomes.push({ kind: "next", value }),
      error: (error) => outcomes.push({ kind: "error", value: error }),
      complete: () => outcomes.push({ kind: "complete", value: null }),
    });
    await flush();
    abort.abort();
    bridge.reply({ ok: true, data: { receipt: {}, throughCursor: "feed:1" } });
    await flush();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe("error");
    expect(readHostError(outcomes[0]!.value)).toEqual({
      code: "CLIENT_CLOSED_REQUEST",
      message: "board.deleteTicket was abandoned",
    });
  });
});

describe("the board link's subscriptions", () => {
  it("opens with the router's input, starts on the ack, and delivers tracked frames", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen } = follow(client, "feed:3");
    await flush();
    expect(bridge.requests).toEqual([
      { path: "board.changes", input: { projectId: PROJECT, lastEventId: "feed:3" } },
    ]);
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    await flush();
    expect(seen.started).toBe(1);
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-1",
      eventId: "feed:4",
      data: batch("feed:4"),
    });
    // Another subscription's frame is not this one's.
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-2",
      eventId: "feed:9",
      data: batch("feed:9"),
    });
    expect(seen.data).toEqual([{ id: "feed:4", data: batch("feed:4") }]);
  });

  it("holds frames that arrive before the ack, and delivers them in order once it lands", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen } = follow(client);
    await flush();
    // Main pumps before it answers: its first frames can beat the ack.
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-1",
      eventId: "feed:1",
      data: batch("feed:1"),
    });
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-1",
      eventId: "feed:2",
      data: batch("feed:2"),
    });
    bridge.emit({ kind: "done", subscriptionId: "subscription-1" });
    expect(seen.data).toEqual([]);
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    await flush();
    expect(seen.started).toBe(1);
    expect(seen.data).toEqual([
      { id: "feed:1", data: batch("feed:1") },
      { id: "feed:2", data: batch("feed:2") },
    ]);
    expect(seen.completed).toBe(1);
    expect(seen.errors).toEqual([]);
  });

  it("drops a straggler nobody awaits, and forgets unclaimed frames once every ack landed", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    // Nothing is waiting for an ack: a frame for an id nobody holds is dropped.
    bridge.emit({ kind: "data", subscriptionId: "gone", eventId: "feed:1", data: batch("feed:1") });
    const first = follow(client);
    await flush();
    // Held while an ack is outstanding, for an id that turns out to be nobody's…
    bridge.emit({
      kind: "data",
      subscriptionId: "orphan",
      eventId: "feed:1",
      data: batch("feed:1"),
    });
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    await flush();
    // …and cleared with the last ack, so a later ack naming it finds nothing.
    const second = follow(client);
    await flush();
    bridge.reply({ ok: true, subscriptionId: "orphan" });
    await flush();
    expect(second.seen.started).toBe(1);
    expect(second.seen.data).toEqual([]);
    expect(first.seen.data).toEqual([]);
  });

  it("completes on a done frame and fails on an error frame, reason forwarded", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const ending = follow(client);
    await flush();
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    const failing = follow(client);
    await flush();
    bridge.reply({ ok: true, subscriptionId: "subscription-2" });
    await flush();

    bridge.emit({ kind: "done", subscriptionId: "subscription-1" });
    expect(ending.seen.completed).toBe(1);
    bridge.emit({
      kind: "error",
      subscriptionId: "subscription-2",
      error: {
        code: "PRECONDITION_FAILED",
        message: "Resnapshot",
        reason: "subscription-resnapshot-required",
      },
    });
    expect(failing.seen.errors).toHaveLength(1);
    expect(readHostError(failing.seen.errors[0])).toEqual({
      code: "PRECONDITION_FAILED",
      message: "Resnapshot",
      reason: "subscription-resnapshot-required",
    });
    expect((failing.seen.errors[0] as TRPCClientError<never>).data).toMatchObject({
      path: "board.changes",
    });
    // Retired: a later frame for either id reaches nobody.
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-1",
      eventId: "feed:9",
      data: batch("feed:9"),
    });
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-2",
      eventId: "feed:9",
      data: batch("feed:9"),
    });
    expect(ending.seen.data).toEqual([]);
    expect(failing.seen.data).toEqual([]);
    // tRPC tears an ended observable down, and the teardown still cancels its
    // id: a cancel main answers by finding nothing (`board-rpc-ipc.test.ts`).
    expect(bridge.cancelled).toEqual(["subscription-1", "subscription-2"]);
  });

  it("cancels on unsubscribe after the ack, and delivers nothing more", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen, subscription } = follow(client);
    await flush();
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    await flush();
    subscription.unsubscribe();
    expect(bridge.cancelled).toEqual(["subscription-1"]);
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-1",
      eventId: "feed:1",
      data: batch("feed:1"),
    });
    expect(seen.data).toEqual([]);
  });

  it("cancels on arrival a subscription its subscriber left before the ack", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen, subscription } = follow(client);
    await flush();
    bridge.emit({
      kind: "data",
      subscriptionId: "subscription-1",
      eventId: "feed:1",
      data: batch("feed:1"),
    });
    subscription.unsubscribe();
    expect(bridge.cancelled).toEqual([]);
    bridge.reply({ ok: true, subscriptionId: "subscription-1" });
    await flush();
    expect(bridge.cancelled).toEqual(["subscription-1"]);
    expect(seen).toEqual(recorder());
  });

  it("fails with the router's refusal of the subscription", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen } = follow(client);
    await flush();
    bridge.reply({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Not found in this Workspace.",
        reason: "workspace-unknown",
      },
    });
    await flush();
    expect(seen.started).toBe(0);
    expect(readHostError(seen.errors[0])).toEqual({
      code: "NOT_FOUND",
      message: "Not found in this Workspace.",
      reason: "workspace-unknown",
    });
  });

  it("refuses a call's data answered to a subscription", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen } = follow(client);
    await flush();
    bridge.reply({ ok: true, data: { cursor: "feed:0" } });
    await flush();
    expect(readHostError(seen.errors[0])).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "board.changes answered a call",
    });
  });

  it("answers a bridge that rejects the subscription as an unreachable host", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    const { seen } = follow(client);
    await flush();
    bridge.fail(new Error("Renderer is reloading"));
    await flush();
    expect(readHostError(seen.errors[0])).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Renderer is reloading",
      reason: "host-unreachable",
    });
  });

  it("listens on the bridge once for every subscription it serves", async () => {
    const bridge = fakeBridge();
    const client = createBoardIpcClient(bridge);
    follow(client);
    follow(client);
    await flush();
    expect(bridge.listenerCount()).toBe(1);
  });
});

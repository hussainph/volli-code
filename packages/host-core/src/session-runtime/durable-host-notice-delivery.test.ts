import { describe, expect, it, vi } from "vite-plus/test";
import type {
  HostNotice,
  HostNoticeOutbox,
  HostNoticeReceipt,
  SessionRuntimeCommandRequest,
  SessionStreamEmission,
} from "@volli/session-engine";
import {
  sessionHostNoticeMetadata,
  type CommandReceipt,
  type SessionEvent,
  type SessionProjection,
} from "@volli/shared";
import { createHostNoticeDelivery } from "./durable-host-notice-delivery";
import { deliverHostNotice, type HostNoticeDeliveryPorts } from "./host-notice-delivery";

const READER = "aaaaaaaa-0000-0000-0000-000000000000";
const notice: HostNotice = {
  sessionId: READER,
  commandId: "shell:reader:shell:exit",
  messageId: "shell:reader:shell:exit:message",
  label: "shell notice",
  text: "sanitized text with original nonce",
  metadata: sessionHostNoticeMetadata({
    kind: "background-shell",
    event: "exited",
    shellId: "shell",
    label: "tests",
    code: 0,
    signal: null,
    runtimeMs: 100,
    byPerson: false,
  }),
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function frame(sequence: number, payload: SessionEvent["payload"]): SessionStreamEmission {
  return {
    sessionId: READER,
    sequence,
    event: {
      id: `e${sequence}`,
      sessionId: READER,
      sequence,
      occurredAt: sequence,
      recordedAt: sequence,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { kind: "local", id: "local" },
      },
      commandId: null,
      payload,
    },
    transcript: null,
  };
}
function receipt(status: "accepted" | "rejected" | "unreconciled"): CommandReceipt {
  return {
    id: `receipt-${status}`,
    commandId: notice.commandId,
    sequence: 10,
    recordedAt: 10,
    ...(status === "accepted"
      ? {
          status,
          acceptedAt: 10,
          result: { kind: "message.submitted", messageId: notice.messageId },
        }
      : status === "rejected"
        ? { status, code: "refused", detail: "not allowed" }
        : { status, detail: "unknown" }),
  } as CommandReceipt;
}
function fixture(options: { live?: boolean; replay?: SessionStreamEmission[] } = {}) {
  const rows = new Map<string, { notice: HostNotice | null; receipt: HostNoticeReceipt | null }>();
  const writes: string[] = [];
  const outbox: HostNoticeOutbox = {
    put: vi.fn(async (value) => {
      writes.push("put");
      if (!rows.has(value.commandId))
        rows.set(value.commandId, { notice: structuredClone(value), receipt: null });
      return rows.get(value.commandId)!.notice;
    }),
    pending: async () =>
      [...rows.values()].flatMap((row) => (row.notice === null ? [] : [row.notice])),
    settle: vi.fn(async (id, value) => {
      writes.push("settle");
      const row = rows.get(id)!;
      if (row.receipt === null) rows.set(id, { notice: null, receipt: value });
    }),
  };
  let live = options.live ?? false;
  let stopped = false;
  let receipts: CommandReceipt[] = [];
  const commands: SessionRuntimeCommandRequest[] = [];
  const reports: string[] = [];
  let dispatch: () => Promise<CommandReceipt | null> = async () => receipt("accepted");
  let onSubscribe: (() => Promise<void>) | null = null;
  let replay = options.replay ?? [];
  let subscriptions = 0;
  let releases = 0;
  const listeners = new Set<(emission: SessionStreamEmission) => void | Promise<void>>();
  const failures = new Map<
    (emission: SessionStreamEmission) => void | Promise<void>,
    (error: unknown) => void
  >();
  let eventListener: ((event: SessionEvent) => void) | null = null;
  const ports: HostNoticeDeliveryPorts = {
    report: (message) => reports.push(message),
    runtime: {
      projection: vi.fn(async () => {
        writes.push("projection");
        return {
          throughSequence: 0,
          projection: {
            liveExecutor: live ? { id: "a" } : null,
            stopped: stopped ? { at: 1 } : null,
            receipts,
          } as unknown as SessionProjection,
        };
      }),
      command: vi.fn(async (request) => {
        writes.push("command");
        commands.push(request);
        return { receipt: await dispatch() } as never;
      }),
      subscribe: vi.fn(async (_input, listener, onFailure) => {
        subscriptions++;
        listeners.add(listener);
        if (onFailure !== undefined) failures.set(listener, onFailure);
        for (const emission of replay) await listener(emission);
        await onSubscribe?.();
        return () => {
          failures.delete(listener);
          if (listeners.delete(listener)) releases++;
        };
      }),
    },
  };
  const delivery = createHostNoticeDelivery({
    ...ports,
    outbox,
    subscribeEvents: (listener) => {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    },
  });
  return {
    delivery,
    rows,
    writes,
    commands,
    reports,
    ports,
    outbox,
    subscriptions: () => subscriptions,
    releases: () => releases,
    failStream: () => {
      for (const failure of failures.values()) failure(new Error("stream lost"));
    },
    engineEmit: (payload: SessionEvent["payload"], sequence = 1) => {
      const emission = frame(sequence, payload);
      if ("event" in emission) eventListener?.(emission.event);
    },
    emit: async (payload: SessionEvent["payload"], sequence = 1) => {
      for (const listener of listeners) await listener(frame(sequence, payload));
    },
    live: (value: boolean) => {
      live = value;
    },
    replay: (value: SessionStreamEmission[]) => {
      replay = value;
    },
    stopped: () => {
      stopped = true;
    },
    receipts: (value: CommandReceipt[]) => {
      receipts = value;
    },
    dispatch: (value: typeof dispatch) => {
      dispatch = value;
    },
    onSubscribe: (value: typeof onSubscribe) => {
      onSubscribe = value;
    },
  };
}
const opened = { kind: "attachment.opened", attachment: { id: "a" } } as SessionEvent["payload"];
const stopped = { kind: "session.stopped", reason: null, by: { kind: "user" } } as const;

describe("durable host notice delivery", () => {
  it("commits the complete notice before live submission and coalesces duplicates while a turn is pending", async () => {
    const h = fixture({ live: true });
    const turn = Promise.withResolvers<CommandReceipt>();
    h.dispatch(() => turn.promise);
    await Promise.all([
      h.delivery.deliver(notice),
      h.delivery.deliver({ ...notice, text: "different nonce" }),
    ]);
    expect(h.commands).toHaveLength(1);
    expect(h.writes).toEqual(["put", "projection", "command"]);
    expect(h.rows.get(notice.commandId)?.notice).toEqual(notice);
    await h.delivery.deliver(notice);
    expect(h.commands).toHaveLength(1);
    turn.resolve(receipt("accepted"));
    await tick();
    expect(await h.outbox.pending()).toEqual([]);
    expect(h.releases()).toBe(1);
    expect(await h.delivery.deliver({ ...notice, text: "another nonce" })).toBe("already-settled");
    expect(h.commands).toHaveLength(1);
    h.delivery.close();
  });

  it("routes through the optional durable port without changing legacy callers", async () => {
    const h = fixture({ live: true });
    await deliverHostNotice({ ...h.ports, delivery: h.delivery }, notice);
    await tick();
    expect(h.writes[0]).toBe("put");
    expect(h.rows.get(notice.commandId)?.receipt?.status).toBe("accepted");
    h.delivery.close();
  });

  it("keeps the first text/nonce on failed and unreconciled retries", async () => {
    const h = fixture({ live: true });
    h.dispatch(async () => {
      throw new Error("transport disappeared");
    });
    await h.delivery.deliver(notice);
    await tick();
    expect(h.reports).toEqual([expect.stringContaining("transport disappeared")]);
    h.dispatch(async () => receipt("unreconciled"));
    await Promise.all([
      h.delivery.deliver({ ...notice, text: "new nonce" }),
      h.delivery.deliver(notice),
    ]);
    await tick();
    expect(h.commands).toHaveLength(2);
    expect(await h.outbox.pending()).toEqual([notice]);
    expect(h.reports[1]).toContain("no terminal receipt");
    h.dispatch(async () => receipt("accepted"));
    await h.delivery.deliver({ ...notice, text: "third nonce" });
    await tick();
    expect(
      h.commands.map((command) =>
        "sessionId" in command && command.command.kind === "message.submit"
          ? command.command.message.parts
          : [],
      ),
    ).toEqual(Array.from({ length: 3 }, () => [{ type: "text", text: notice.text }]));
    expect(await h.outbox.pending()).toEqual([]);
    h.delivery.close();
  });

  it("does not lose a new attachment that races the failure of an in-flight attempt", async () => {
    const h = fixture({ live: true });
    const oldAttempt = Promise.withResolvers<CommandReceipt>();
    let attempts = 0;
    h.dispatch(() =>
      attempts++ === 0 ? oldAttempt.promise : Promise.resolve(receipt("accepted")),
    );
    await h.delivery.deliver(notice);
    await h.emit({ kind: "attachment.closed", attachmentId: "a", outcome: "interrupted" }, 1);
    await h.emit(
      { kind: "attachment.opened", attachment: { id: "b" } } as SessionEvent["payload"],
      2,
    );
    expect(h.commands).toHaveLength(1);
    oldAttempt.reject(new Error("old transport gone"));
    await tick();
    expect(h.commands).toHaveLength(2);
    expect(await h.outbox.pending()).toEqual([]);
    expect(h.releases()).toBe(1);
    h.delivery.close();
  });

  it("subscribes before submitting, so replayed stop or detach wins over a stale live projection", async () => {
    const stop = fixture({ live: true, replay: [frame(1, opened), frame(2, stopped)] });
    expect(await stop.delivery.deliver(notice)).toBe("reader-stopped");
    await tick();
    expect(stop.commands).toEqual([]);
    expect(stop.releases()).toBe(1);
    expect(stop.rows.get(notice.commandId)?.receipt).toEqual({
      status: "dropped",
      reason: "reader-stopped",
    });
    const detach = fixture({
      live: true,
      replay: [frame(1, { kind: "attachment.closed", attachmentId: "a", outcome: "completed" })],
    });
    expect(await detach.delivery.deliver(notice)).toBe("parked");
    expect(detach.commands).toEqual([]);
    await detach.emit(opened, 2);
    await tick();
    expect(detach.commands).toHaveLength(1);
    detach.delivery.close();
    stop.delivery.close();
  });

  it("attachment replay submits once without awaiting an idle turn, and terminal receipt replay settles without resubmitting", async () => {
    const h = fixture({ replay: [frame(1, opened), frame(2, opened)] });
    const turn = Promise.withResolvers<CommandReceipt>();
    h.dispatch(() => turn.promise);
    expect(await h.delivery.deliver(notice)).toBe("delivered");
    expect(h.commands).toHaveLength(1);
    await h.emit({ kind: "command.receipt.recorded", receipt: receipt("accepted") }, 10);
    await tick();
    expect(h.releases()).toBe(1);
    expect(await h.outbox.pending()).toEqual([]);
    turn.resolve(receipt("accepted"));
    await tick();
    expect(h.outbox.settle).toHaveBeenCalledTimes(1);
    h.delivery.close();
    const replay = fixture({
      live: true,
      replay: [frame(1, { kind: "command.receipt.recorded", receipt: receipt("accepted") })],
    });
    await replay.delivery.deliver(notice);
    await tick();
    expect(replay.commands).toEqual([]);
    expect(replay.releases()).toBe(1);
    replay.delivery.close();
  });

  it("drops a parked reader on stop and releases its subscription", async () => {
    const h = fixture();
    await h.delivery.deliver(notice);
    await h.emit(stopped);
    await tick();
    expect(h.commands).toEqual([]);
    expect(h.reports).toEqual([expect.stringContaining("is stopped")]);
    expect(h.releases()).toBe(1);
    expect(await h.delivery.deliver(notice)).toBe("already-settled");
    h.delivery.close();
  });

  it.each(["stop", "receipt"] as const)(
    "settles a failed parked stream on a direct Engine %s",
    async (wake) => {
      const h = fixture();
      await h.delivery.deliver(notice);
      h.failStream();
      expect(h.releases()).toBe(1);
      expect(await h.outbox.pending()).toEqual([notice]);
      h.engineEmit(
        wake === "stop"
          ? stopped
          : {
              kind: "command.receipt.recorded",
              receipt: receipt("accepted"),
            },
      );
      await tick();
      expect(await h.outbox.pending()).toEqual([]);
      expect(h.rows.get(notice.commandId)?.receipt).toEqual(
        wake === "stop" ? { status: "dropped", reason: "reader-stopped" } : { status: "accepted" },
      );
      expect(h.commands).toEqual([]);
      h.delivery.close();
    },
  );

  it("retains tracking when a stream fails before subscribe returns", async () => {
    const h = fixture();
    h.onSubscribe(async () => h.failStream());
    expect(await h.delivery.deliver(notice)).toBe("parked");
    expect(h.releases()).toBe(1);
    h.engineEmit(stopped);
    await tick();
    expect(await h.outbox.pending()).toEqual([]);
    expect(h.commands).toEqual([]);
    h.delivery.close();
  });

  it("reconstructs a failed stream on the attachment receipt, not the pre-binding Engine open", async () => {
    const h = fixture();
    await h.delivery.deliver(notice);
    h.failStream();
    h.live(true);
    h.engineEmit(opened);
    await tick();
    expect(h.commands).toEqual([]);
    expect(h.subscriptions()).toBe(1);
    // The runtime has now installed the binding and published opened. Its
    // accepted start receipt is the safe wake, even with no fresh producer.
    h.replay([frame(1, opened), frame(2, opened)]);
    const turn = Promise.withResolvers<CommandReceipt>();
    h.dispatch(() => turn.promise);
    const attached: CommandReceipt = {
      ...receipt("accepted"),
      commandId: "reattach",
      status: "accepted",
      acceptedAt: 3,
      result: { kind: "executor.start.requested", sessionId: READER },
    };
    h.engineEmit({ kind: "command.receipt.recorded", receipt: attached }, 3);
    h.engineEmit({ kind: "command.receipt.recorded", receipt: attached }, 3);
    await tick();
    expect(h.subscriptions()).toBe(2);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      commandId: notice.commandId,
      command: { message: { id: notice.messageId, parts: [{ type: "text", text: notice.text }] } },
    });
    expect(h.outbox.put).toHaveBeenCalledTimes(1);
    // Replay and Engine writers did not await the idle turn.
    expect(await h.outbox.pending()).toEqual([notice]);
    turn.resolve(receipt("accepted"));
    await tick();
    expect(await h.outbox.pending()).toEqual([]);
    expect(h.releases()).toBe(2);
    h.delivery.close();
  });

  it("retries a failed stream from a duplicate producer without replacing its stored ids or nonce", async () => {
    const h = fixture();
    await h.delivery.deliver(notice);
    h.failStream();
    h.live(true);
    await h.delivery.deliver({ ...notice, messageId: "new-id", text: "new nonce" });
    await tick();
    expect(h.subscriptions()).toBe(2);
    expect(h.outbox.put).toHaveBeenCalledTimes(1);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      commandId: notice.commandId,
      command: { message: { id: notice.messageId, parts: [{ type: "text", text: notice.text }] } },
    });
    expect(await h.outbox.pending()).toEqual([]);
    h.delivery.close();
  });

  it("settles rejected receipts, including those already committed before recovery", async () => {
    const h = fixture({ live: true });
    h.dispatch(async () => receipt("rejected"));
    await h.delivery.deliver(notice);
    await tick();
    expect(h.rows.get(notice.commandId)?.receipt).toEqual({
      status: "rejected",
      code: "refused",
      detail: "not allowed",
    });
    expect(h.reports).toEqual([expect.stringContaining("was refused")]);
    h.delivery.close();
    const prior = fixture({ live: true });
    prior.receipts([receipt("unreconciled"), receipt("accepted")]);
    expect(await prior.delivery.deliver(notice)).toBe("already-settled");
    expect(prior.commands).toEqual([]);
    expect(prior.subscriptions()).toBe(0);
    prior.delivery.close();
  });

  it("close cleans up subscriptions even before subscribe returns and leaves payloads durable", async () => {
    const h = fixture();
    const subscription = Promise.withResolvers<void>();
    h.onSubscribe(() => subscription.promise);
    const delivery = h.delivery.deliver(notice);
    await tick();
    h.delivery.close();
    subscription.resolve();
    expect(await delivery).toBe("parked");
    expect(h.releases()).toBe(1);
    expect(await h.outbox.pending()).toEqual([notice]);
    await h.emit(opened);
    expect(h.commands).toEqual([]);
    await expect(h.delivery.deliver(notice)).rejects.toThrow("closed");
  });

  it("a persistence failure cannot reach runtime, and a subscription failure retains the payload for reconstruction", async () => {
    const h = fixture({ live: true });
    vi.mocked(h.outbox.put).mockRejectedValueOnce(new Error("disk full"));
    await expect(h.delivery.deliver(notice)).rejects.toThrow("disk full");
    expect(h.ports.runtime.projection).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
    vi.mocked(h.ports.runtime.subscribe).mockRejectedValueOnce(new Error("stream missing"));
    await expect(h.delivery.deliver(notice)).rejects.toThrow("stream missing");
    expect(await h.outbox.pending()).toEqual([notice]);
    await h.delivery.recover();
    await tick();
    expect(h.commands).toHaveLength(1);
    h.delivery.close();
  });
});

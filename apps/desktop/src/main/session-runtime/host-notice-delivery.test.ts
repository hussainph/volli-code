/**
 * One host notice, delivered when its reader can read it (VC-457). The race
 * this pins: an attachment that opens between the projection read and the
 * subscription is REPLAYED by `subscribe` before it returns, so the listener
 * runs with no unsubscribe handle yet. The notice must still be delivered once
 * and the subscription still released.
 */

import { describe, expect, it } from "vite-plus/test";
import type { SessionRuntimeCommandRequest, SessionStreamEmission } from "@volli/session-engine";
import { sessionHostNoticeMetadata } from "@volli/shared";
import type { SessionEvent, SessionProjection } from "@volli/shared";

import { cutAtCodePoint, deliverHostNotice } from "./host-notice-delivery";
import type { HostNoticeDeliveryPorts } from "./host-notice-delivery";

const READER = "aaaaaaaa-0000-0000-0000-000000000000";

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
        source: { kind: "system", id: "t", detail: null },
        venue: { id: "local", kind: "local" },
      },
      commandId: null,
      payload,
    },
    transcript: null,
  } as SessionStreamEmission;
}

function settleMicrotasks(): Promise<unknown> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: {
  live?: boolean;
  stopped?: boolean;
  /** Frames `subscribe` replays before it returns — the race. */
  replay?: SessionStreamEmission[];
  receipt?: "accepted" | "rejected" | "throws";
}) {
  const commands: SessionRuntimeCommandRequest[] = [];
  const reports: string[] = [];
  let releases = 0;
  let listener: ((emission: SessionStreamEmission) => void) | null = null;
  const ports: HostNoticeDeliveryPorts = {
    report: (message) => reports.push(message),
    runtime: {
      command: async (request) => {
        commands.push(request);
        if (options.receipt === "throws") throw new Error("runtime gone");
        return {
          receipt:
            options.receipt === "rejected"
              ? { status: "rejected", code: "no_live_executor", detail: "nobody home" }
              : { status: "accepted" },
        } as never;
      },
      projection: async () => ({
        projection: {
          stopped: options.stopped ? { at: 1, reason: null, by: { kind: "user" } } : null,
          liveExecutor: options.live ? { id: "a" } : null,
        } as unknown as SessionProjection,
        throughSequence: 0,
      }),
      subscribe: async (_input, onEmission) => {
        listener = onEmission as (emission: SessionStreamEmission) => void;
        for (const emission of options.replay ?? []) listener(emission);
        return () => {
          releases += 1;
        };
      },
    },
  };
  const notice = {
    sessionId: READER,
    commandId: "c",
    messageId: "m",
    text: "hello",
    metadata: sessionHostNoticeMetadata({
      kind: "watch",
      events: [{ subject: "ticket", id: "t", label: "VC-1", fact: "ticket-moved", detail: null }],
    }),
    label: "test notice",
  };
  return {
    deliver: () => deliverHostNotice(ports, notice),
    commands,
    reports,
    releases: () => releases,
    emit: (emission: SessionStreamEmission) => listener?.(emission),
    settle: settleMicrotasks,
  };
}

describe("deliverHostNotice", () => {
  it("submits at once to a live reader, and drops (and reports) for a stopped one", async () => {
    const live = harness({ live: true });
    expect(await live.deliver()).toBe("delivered");
    expect(live.commands).toHaveLength(1);
    const stopped = harness({ stopped: true });
    expect(await stopped.deliver()).toBe("reader-stopped");
    expect(stopped.reports).toEqual([expect.stringMatching(/is stopped/)]);
  });

  it("delivers once and releases the stream when the attachment opened inside the race", async () => {
    const h = harness({
      replay: [frame(1, { kind: "attachment.opened", attachment: {} as never })],
    });
    expect(await h.deliver()).toBe("parked");
    expect(h.commands).toHaveLength(1);
    expect(h.releases()).toBe(1);
    // A later frame changes nothing.
    h.emit(frame(2, { kind: "attachment.opened", attachment: {} as never }));
    expect(h.commands).toHaveLength(1);
    expect(h.reports).toEqual([]);
  });

  it("drops, reports and releases when the reader stopped inside the race", async () => {
    const h = harness({
      replay: [frame(1, { kind: "session.stopped", reason: null, by: { kind: "user" } })],
    });
    await h.deliver();
    expect(h.commands).toEqual([]);
    expect(h.releases()).toBe(1);
    expect(h.reports).toEqual([expect.stringMatching(/stopped before it attached again/)]);
  });

  it("waits for a later attachment when nothing raced, and ignores other frames", async () => {
    const h = harness({});
    await h.deliver();
    h.emit(frame(1, { kind: "turn.started", attachmentId: "a", turnId: "t" }));
    expect(h.commands).toEqual([]);
    h.emit(frame(2, { kind: "attachment.opened", attachment: {} as never }));
    expect(h.commands).toHaveLength(1);
    expect(h.releases()).toBe(1);
  });

  it("reports a refused or failed submit rather than swallowing it", async () => {
    const refused = harness({ live: true, receipt: "rejected" });
    await refused.deliver();
    await refused.settle();
    expect(refused.reports).toEqual([expect.stringMatching(/was refused: no_live_executor/)]);
    const failed = harness({ live: true, receipt: "throws" });
    await failed.deliver();
    await failed.settle();
    expect(failed.reports).toEqual([expect.stringMatching(/failed: runtime gone/)]);
  });
});

describe("cutAtCodePoint", () => {
  it("never leaves half a surrogate pair at the cut", () => {
    expect(cutAtCodePoint("abc", 5)).toBe("abc");
    expect(cutAtCodePoint("abcdef", 3)).toBe("abc");
    // "a" then U+1F600 (two UTF-16 units): a cut at 2 would split it.
    expect(cutAtCodePoint("a😀b", 2)).toBe("a");
    expect(cutAtCodePoint("a😀b", 3)).toBe("a😀");
  });
});

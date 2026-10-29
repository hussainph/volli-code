import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionEvent } from "@volli/shared";
import { TRANSCRIPT_PACK_INTERVAL_MS, TRANSCRIPT_PACK_MAX_BYTES } from "@volli/shared/cloud";
import { logContext, withLogContext } from "../log/context";
import { ObjectUploadError } from "../transcript-spool/object-store";
import type { BackendLink, LinkStatus } from "../cloud-runner/backend-link";
import type { DrainCursor } from "../cloud-runner/drain";
import { createTranscriptPacking } from "./transcript-packing";

const report = {
  transcript: [],
  piLogs: { segments: [], missing: [], truncated: [], oversized: [] },
};
const workers: ReturnType<typeof createTranscriptPacking>[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const rows = new Map<string, DrainCursor>();
  const events: SessionEvent[] = [];
  const listeners = new Set<(status: LinkStatus) => void>();
  const link = {
    status: { state: "connected" } as LinkStatus,
    onStatus(listener: (status: LinkStatus) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies Pick<BackendLink, "status" | "onStatus">;
  const pack = vi.fn(async (_id: string, _signal: AbortSignal) => report);
  const artifactBytes = vi.fn(async () => 1 as number | null);
  const onError = vi.fn();
  const onReport = vi.fn();
  const listEvents = vi.fn(({ sessionId, afterSequence, limit }) =>
    events
      .filter((event) => event.sessionId === sessionId && event.sequence > afterSequence)
      .slice(0, limit),
  );
  const worker = createTranscriptPacking({
    ownerUserId: "owner",
    link,
    pack,
    artifactBytes,
    onError,
    onReport,
    cursors: {
      list: () => [...rows.values()],
      get: (id) => rows.get(id) ?? null,
      save: (row) => {
        rows.set(row.sessionId, row);
      },
      update: (row, expected) => {
        const held = rows.get(row.sessionId);
        if (
          held?.ownerUserId !== row.ownerUserId ||
          held.generation !== expected.generation ||
          held.acceptedThrough !== expected.acceptedThrough
        ) {
          return false;
        }
        rows.set(row.sessionId, row);
        return true;
      },
    },
    ledger: { listEvents, latestEventSequence: () => events.length },
  });
  workers.push(worker);
  const row = (sessionId = "session", ownerUserId = "owner", acceptedThrough = 1) => {
    const cursor = { sessionId, ownerUserId, acceptedThrough, generation: 1, blocked: null };
    rows.set(sessionId, cursor);
    return cursor;
  };
  const accepted = (kind: string, sequence: number, through = sequence) => {
    events.push({
      sessionId: "session",
      sequence,
      payload: {
        kind,
        ...(kind === "transcript.referenced"
          ? {
              reference: {
                id: `sha256:${String(sequence).padStart(64, "0")}`,
                mediaType: "application/json",
              },
            }
          : {}),
      },
    } as SessionEvent);
    rows.get("session")!.acceptedThrough = through;
    worker.accepted("session", through);
  };
  return {
    worker,
    pack,
    artifactBytes,
    rows,
    row,
    accepted,
    onError,
    onReport,
    listEvents,
    listeners,
    status(state: LinkStatus) {
      link.status = state;
      for (const listener of listeners) listener(state);
    },
  };
}
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("accepted history packing lifecycle", () => {
  it("recovers caught-up owner cursors at start and reconnect, but not foreign, blocked or unborn Sessions", async () => {
    const f = fixture();
    f.row();
    f.row("foreign", "someone");
    f.row("unborn", "owner", 0);
    const blocked = f.row("blocked");
    f.rows.set("blocked", { ...blocked, blocked: { code: "fenced", message: "moved", at: 1 } });
    f.worker.start();
    f.worker.start();
    await tick();
    expect(f.pack.mock.calls.map(([id]) => id)).toEqual(["session"]);
    f.status({ state: "offline", since: 1 });
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_PACK_INTERVAL_MS);
    expect(f.pack).toHaveBeenCalledTimes(1);
    f.status({ state: "connected" });
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.worker.close();
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("packs only accepted end facts, coalesces acknowledgements, and handles interrupted/closed turns", async () => {
    const f = fixture();
    f.row();
    f.worker.start();
    await tick();
    f.pack.mockClear();
    f.accepted("turn.started", 2);
    f.accepted("turn.completed", 3, 2); // the end is not accepted yet
    await tick();
    expect(f.pack).not.toHaveBeenCalled();
    f.worker.accepted("session", 3);
    f.rows.get("session")!.acceptedThrough = 3;
    f.worker.accepted("session", 3);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(1);
    f.accepted("turn.interrupted", 4);
    f.accepted("attachment.closed", 5);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(2);
    expect(f.onReport).toHaveBeenCalledWith("session", report);
  });

  it("serializes Sessions, keeps one dirty rerun, and does not block accepts behind an upload", async () => {
    const f = fixture();
    f.row();
    f.row("second");
    const held = Promise.withResolvers<typeof report>();
    f.pack.mockImplementationOnce(() => held.promise);
    f.worker.start();
    await tick();
    f.accepted("turn.completed", 2);
    f.accepted("turn.completed", 3);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(1);
    held.resolve(report);
    await tick();
    expect(f.pack.mock.calls.map(([id]) => id)).toEqual(["session", "second", "session"]);
  });

  it("tails Pi-only growth and long turns on the shared ten-minute interval and after runtime binding", async () => {
    const f = fixture();
    f.row();
    f.worker.start();
    await tick();
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_PACK_INTERVAL_MS - 1);
    expect(f.pack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.worker.refresh();
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(3);
  });

  it("retries transient/redaction failures after five seconds but holds terminal fences until recovery", async () => {
    const f = fixture();
    f.row();
    f.pack.mockRejectedValueOnce(new Error("redaction unavailable"));
    f.worker.start();
    await tick();
    expect(f.onError).toHaveBeenLastCalledWith("session", "upload_failed");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.pack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.pack.mockRejectedValueOnce({ data: { code: "stale_claim" } });
    f.worker.refresh();
    await tick();
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_PACK_INTERVAL_MS);
    expect(f.pack).toHaveBeenCalledTimes(3);
    f.rows.get("session")!.generation = 2;
    f.worker.refresh();
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(4);
    f.pack.mockRejectedValueOnce({ code: "revoked" });
    f.worker.refresh();
    await tick();
    f.status({ state: "connected" });
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(5); // a network reconnect is not recovery from revocation
  });

  it("packs a continuing turn at four accepted MB and resets only successfully covered accounting", async () => {
    const f = fixture();
    f.row();
    f.worker.start();
    await tick();
    f.artifactBytes.mockResolvedValue(TRANSCRIPT_PACK_MAX_BYTES / 2);
    f.accepted("transcript.referenced", 2);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(1);
    f.accepted("transcript.referenced", 3);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.accepted("transcript.referenced", 4);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.artifactBytes.mockResolvedValue(null);
    f.accepted("transcript.referenced", 5);
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(3); // unreadable size tries packing, never drops history
  });

  it("never strands accepted work in promise finalization microtasks", async () => {
    for (let depth = 0; depth < 8; depth += 1) {
      const f = fixture();
      f.row();
      f.onReport.mockImplementationOnce(() => {
        let tail = Promise.resolve();
        for (let index = 0; index < depth; index += 1) tail = tail.then(() => {});
        void tail.then(() => f.accepted("turn.completed", 2));
      });
      f.worker.start();
      await tick();
      expect(f.pack, `microtask depth ${depth}`).toHaveBeenCalledTimes(2);
      f.worker.close();
    }
  });

  it("detaches background work from request traces and roots each Session separately", async () => {
    const f = fixture();
    f.row();
    f.row("second");
    const contexts: unknown[] = [];
    f.pack.mockImplementation(async () => {
      contexts.push(logContext());
      return report;
    });
    withLogContext({ traceId: "caller-trace", commandId: "caller-command" }, () =>
      f.worker.start(),
    );
    await tick();
    expect(contexts).toEqual([{ sessionId: "session" }, { sessionId: "second" }]);
  });

  it("holds non-retriable storage failures until a new claim or restart, not a network reconnect", async () => {
    const f = fixture();
    f.row();
    f.pack.mockRejectedValueOnce(new ObjectUploadError("key", 403));
    f.worker.start();
    await tick();
    expect(f.onError).toHaveBeenLastCalledWith("session", "object_http_403");
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_PACK_INTERVAL_MS);
    f.status({ state: "connected" });
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(1);
    f.rows.get("session")!.generation = 2;
    f.worker.refresh();
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.pack.mockRejectedValueOnce(new ObjectUploadError("key", 503));
    f.worker.refresh();
    await tick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.pack).toHaveBeenCalledTimes(4);
  });

  it("aborts in-flight work immediately, bounds stop, and ignores late failures without timers or DB reads", async () => {
    const f = fixture();
    f.row();
    const held = Promise.withResolvers<typeof report>();
    f.pack.mockImplementationOnce(() => held.promise);
    f.worker.start();
    await tick();
    const signal = f.pack.mock.calls[0]![1];
    const stopped = f.worker.stop();
    expect(signal.aborted).toBe(true);
    f.accepted("turn.completed", 2); // no post-close DB inspection
    const reads = f.listEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
    held.reject(new Error("late"));
    await tick();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.listEvents).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
    f.worker.start();
    f.worker.refresh();
    f.status({ state: "connected" });
    await tick();
    expect(f.pack).toHaveBeenCalledTimes(1);
  });

  it("times out a hung pass and catches history inspection failures outside the accept callback", async () => {
    const f = fixture();
    f.row();
    f.pack.mockImplementationOnce(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    f.worker.start();
    await tick();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(f.onError).toHaveBeenLastCalledWith("session", "upload_failed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.pack).toHaveBeenCalledTimes(2);
    f.listEvents.mockImplementationOnce(() => {
      throw new Error("db unavailable");
    });
    expect(() => f.accepted("turn.completed", 2)).not.toThrow();
    await tick();
    expect(f.onError).toHaveBeenLastCalledWith("session", "history_read_failed");
  });
});

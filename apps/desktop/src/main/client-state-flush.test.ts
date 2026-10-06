import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLIENT_STATE_FLUSH_TIMEOUT_MS,
  createClientStateFlush,
  type FlushTarget,
} from "./client-state-flush";

function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      setTimeout: (run: () => void) => {
        next += 1;
        pending.set(next, run);
        return next;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    fire: () => {
      for (const [id, run] of pending) {
        pending.delete(id);
        run();
      }
    },
    pendingCount: () => pending.size,
  };
}

function target(answer?: (id: string) => void): FlushTarget & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isDestroyed: () => false,
    requestFlush: (id) => {
      asked.push(id);
      answer?.(id);
    },
  };
}

describe("client-state flush before a forced destroy (VC-577)", () => {
  it("asks every live window and resolves once every one has acked", async () => {
    const clock = fakeClock();
    let id = 0;
    const flusher = createClientStateFlush({
      newRequestId: () => `r${++id}`,
      timers: clock.timers,
      log: vi.fn(),
    });
    const a = target();
    const b = target();
    const gone: FlushTarget = { isDestroyed: () => true, requestFlush: vi.fn() };
    let done = false;
    const flushed = flusher.flush([a, b, gone]).then((outcome) => {
      done = true;
      return outcome;
    });
    expect(a.asked).toEqual(["r1"]);
    expect(b.asked).toEqual(["r2"]);
    expect(gone.requestFlush).not.toHaveBeenCalled();
    flusher.acknowledge("r1");
    await Promise.resolve();
    expect(done).toBe(false);
    // Unknown, repeated and malformed acks are ignored.
    flusher.acknowledge("r1");
    flusher.acknowledge("nope");
    flusher.acknowledge(42);
    flusher.acknowledge("r2");
    await expect(flushed).resolves.toEqual({ acked: 2, unanswered: 0 });
    expect(clock.pendingCount()).toBe(0);
  });

  it("gives up at the bound, logs, and still resolves", async () => {
    const clock = fakeClock();
    const log = vi.fn();
    const flusher = createClientStateFlush({
      newRequestId: () => "only",
      timers: clock.timers,
      log,
    });
    const flushed = flusher.flush([target()]);
    clock.fire();
    await expect(flushed).resolves.toEqual({ acked: 0, unanswered: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("did not confirm"));
    // A late ack after the bound changes nothing.
    flusher.acknowledge("only");
  });

  it("counts a window whose send threw as unanswered, without waiting on it", async () => {
    const clock = fakeClock();
    const log = vi.fn();
    const flusher = createClientStateFlush({ newRequestId: () => "x", timers: clock.timers, log });
    const broken: FlushTarget = {
      isDestroyed: () => false,
      requestFlush: () => {
        throw new Error("render frame disposed");
      },
    };
    await expect(flusher.flush([broken])).resolves.toEqual({ acked: 0, unanswered: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not ask"));
    expect(clock.pendingCount()).toBe(0);
  });

  it("resolves at once with nothing to ask, and defaults to real timers and console", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const flusher = createClientStateFlush({ newRequestId: () => "r" });
      await expect(flusher.flush([])).resolves.toEqual({ acked: 0, unanswered: 0 });
      const synchronous = target((id) => flusher.acknowledge(id));
      await expect(flusher.flush([synchronous])).resolves.toEqual({ acked: 1, unanswered: 0 });
      const flushed = flusher.flush([target()]);
      vi.advanceTimersByTime(CLIENT_STATE_FLUSH_TIMEOUT_MS);
      await expect(flushed).resolves.toEqual({ acked: 0, unanswered: 1 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

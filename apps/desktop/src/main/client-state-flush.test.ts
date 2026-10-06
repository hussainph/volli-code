import { describe, expect, it, vi } from "vite-plus/test";
import { captureHostLog } from "@volli/host-core/testing";

import {
  createClientStateFlush,
  MENU_BAR_FLUSH_OVERDUE_MS,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
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

function target(
  answer?: (id: string) => void,
): FlushTarget & { asked: string[]; onAcked: ReturnType<typeof vi.fn<() => void>> } {
  const asked: string[] = [];
  return {
    asked,
    isDestroyed: () => false,
    requestFlush: (id) => {
      asked.push(id);
      answer?.(id);
    },
    onAcked: vi.fn<() => void>(),
  };
}

describe("client-state flush before a forced destroy (VC-577)", () => {
  it("bounds a menu-bar entry at 10s and a shutdown at 2s", () => {
    expect(MENU_BAR_FLUSH_OVERDUE_MS).toBe(10_000);
    expect(SHUTDOWN_FLUSH_TIMEOUT_MS).toBe(2_000);
  });

  it("asks every live window, tells each target its own ack at once, and resolves when all acked", async () => {
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
    const flushed = flusher.flush([a, b, gone], MENU_BAR_FLUSH_OVERDUE_MS).then((outcome) => {
      done = true;
      return outcome;
    });
    expect(a.asked).toEqual(["r1"]);
    expect(b.asked).toEqual(["r2"]);
    expect(gone.requestFlush).not.toHaveBeenCalled();
    flusher.acknowledge("r1");
    // `a` hears its ack before `b` answers: its window can go now.
    expect(a.onAcked).toHaveBeenCalledOnce();
    expect(b.onAcked).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(done).toBe(false);
    // Unknown, repeated and malformed acks are ignored.
    flusher.acknowledge("r1");
    flusher.acknowledge("nope");
    flusher.acknowledge(42);
    expect(a.onAcked).toHaveBeenCalledOnce();
    flusher.acknowledge("r2");
    await expect(flushed).resolves.toEqual({ acked: 2, unanswered: 0 });
    expect(clock.pendingCount()).toBe(0);
  });

  it("resolves at the bound and logs, but a late ack still reaches its target", async () => {
    const clock = fakeClock();
    const log = vi.fn();
    const flusher = createClientStateFlush({
      newRequestId: () => "slow",
      timers: clock.timers,
      log,
    });
    const slow = target();
    const flushed = flusher.flush([slow], MENU_BAR_FLUSH_OVERDUE_MS);
    clock.fire();
    await expect(flushed).resolves.toEqual({ acked: 0, unanswered: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("had not confirmed"));
    expect(slow.onAcked).not.toHaveBeenCalled();
    // The slow renderer finally saved: menu-bar entry may destroy it now.
    flusher.acknowledge("slow");
    expect(slow.onAcked).toHaveBeenCalledOnce();
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
    await expect(flusher.flush([broken], SHUTDOWN_FLUSH_TIMEOUT_MS)).resolves.toEqual({
      acked: 0,
      unanswered: 1,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not ask"));
    expect(clock.pendingCount()).toBe(0);
  });

  it("resolves at once with nothing to ask, and defaults to real timers and the host log", async () => {
    vi.useFakeTimers();
    const captured = captureHostLog();
    try {
      const flusher = createClientStateFlush({ newRequestId: () => "r" });
      await expect(flusher.flush([], SHUTDOWN_FLUSH_TIMEOUT_MS)).resolves.toEqual({
        acked: 0,
        unanswered: 0,
      });
      // An ack with no `onAcked` (the shutdown's targets) settles the same way.
      const synchronous: FlushTarget = {
        isDestroyed: () => false,
        requestFlush: (id) => flusher.acknowledge(id),
      };
      await expect(flusher.flush([synchronous], SHUTDOWN_FLUSH_TIMEOUT_MS)).resolves.toEqual({
        acked: 1,
        unanswered: 0,
      });
      const flushed = flusher.flush([target()], SHUTDOWN_FLUSH_TIMEOUT_MS);
      vi.advanceTimersByTime(SHUTDOWN_FLUSH_TIMEOUT_MS);
      await expect(flushed).resolves.toEqual({ acked: 0, unanswered: 1 });
      expect(captured.of("client-state").map(({ level }) => level)).toContain("warn");
    } finally {
      captured.restore();
      vi.useRealTimers();
    }
  });
});

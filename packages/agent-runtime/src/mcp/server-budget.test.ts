import type { RuntimeMcpCall, RuntimeMcpCallResult, RuntimeMcpPort } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_MCP_SERVER_LIMITS, McpServerBudget, type McpServerLimits } from "./server-budget";

interface Pending {
  request: RuntimeMcpCall;
  signal: AbortSignal;
  finish: (text?: string) => void;
  fail: (error: unknown) => void;
}

/** A port whose calls stay open until the test settles them. */
function manualPort(): RuntimeMcpPort & {
  pending: Pending[];
  calls: RuntimeMcpCall[];
  startedAt: number[];
} {
  const pending: Pending[] = [];
  const calls: RuntimeMcpCall[] = [];
  const startedAt: number[] = [];
  return {
    pending,
    calls,
    startedAt,
    call: (request, signal) =>
      new Promise<RuntimeMcpCallResult>((resolve, reject) => {
        calls.push(request);
        startedAt.push(Date.now());
        const entry: Pending = {
          request,
          signal,
          finish: (text = request.toolCallId) => {
            pending.splice(pending.indexOf(entry), 1);
            resolve({ content: [{ type: "text", text }], isError: false });
          },
          fail: (error) => {
            pending.splice(pending.indexOf(entry), 1);
            reject(error);
          },
        };
        pending.push(entry);
        signal.addEventListener("abort", () => entry.fail(signal.reason), { once: true });
      }),
  };
}

function mcpCall(serverId: string, toolCallId: string): RuntimeMcpCall {
  return { serverId, toolName: "read", arguments: {}, toolCallId };
}

function budget(limits: Record<string, McpServerLimits>): McpServerBudget {
  return new McpServerBudget({ limitsFor: (serverId) => limits[serverId], now: () => Date.now() });
}

const never = new AbortController().signal;

/** Finish every call still open on `port`, oldest first. */
function finishAll(port: { pending: Pending[] }): void {
  while (port.pending.length > 0) port.pending[0]!.finish();
}

/** Let queued admissions and the calls they start run. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("McpServerBudget", () => {
  it("defaults every server the host said nothing about, and refuses nonsense limits", async () => {
    expect(DEFAULT_MCP_SERVER_LIMITS).toEqual({ maxConcurrent: 8, maxStarts: 32, windowMs: 1_000 });
    const port = manualPort();
    const bound = new McpServerBudget().bind(port);
    void bound.call(mcpCall("anything", "one"), never);
    await flush();
    expect(port.calls).toHaveLength(1);

    for (const [limits, message] of [
      [{ maxConcurrent: 0, maxStarts: 1, windowMs: 1 }, /maxConcurrent/],
      [{ maxConcurrent: 1.5, maxStarts: 1, windowMs: 1 }, /maxConcurrent/],
      [{ maxConcurrent: 1, maxStarts: 0, windowMs: 1 }, /maxStarts/],
      [{ maxConcurrent: 1, maxStarts: 2.5, windowMs: 1 }, /maxStarts/],
      [{ maxConcurrent: 1, maxStarts: 1, windowMs: 0 }, /windowMs/],
      [{ maxConcurrent: 1, maxStarts: 1, windowMs: Number.NaN }, /windowMs/],
    ] as const) {
      const bad = budget({ bad: limits }).bind(manualPort());
      await expect(bad.call(mcpCall("bad", "one"), never)).rejects.toThrow(message);
    }
  });

  it("queues calls over the in-flight cap in order instead of failing them", async () => {
    const port = manualPort();
    const limits = budget({ s: { maxConcurrent: 2, maxStarts: Infinity, windowMs: 100 } });
    const bound = limits.bind(port);
    const results = ["a", "b", "c", "d", "e"].map((id) => bound.call(mcpCall("s", id), never));
    await flush();

    expect(port.calls.map((call) => call.toolCallId)).toEqual(["a", "b"]);
    expect(limits.load("s")).toEqual({ active: 2, queued: 3, peakActive: 2, admitted: 2 });
    port.pending[1]!.finish();
    await vi.waitFor(() => expect(port.calls).toHaveLength(3));
    expect(port.calls[2]!.toolCallId).toBe("c");
    while (port.pending.length > 0) {
      port.pending[0]!.finish();
      await flush();
    }
    await expect(Promise.all(results)).resolves.toHaveLength(5);
    expect(port.calls.map((call) => call.toolCallId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(limits.load("s")).toEqual({ active: 0, queued: 0, peakActive: 2, admitted: 5 });
  });

  it("holds starts to the rolling window and wakes the queue at its edge", async () => {
    const port = manualPort();
    const limits = budget({ s: { maxConcurrent: 10, maxStarts: 3, windowMs: 100 } });
    const bound = limits.bind(port);
    const t0 = Date.now();
    const results = Array.from({ length: 7 }, (_, index) =>
      bound.call(mcpCall("s", `c${index}`), never),
    );
    await flush();
    // Finishing a call frees a slot but not the window.
    finishAll(port);
    await flush();
    expect(port.calls).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(99);
    expect(port.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.calls).toHaveLength(6);
    finishAll(port);
    await vi.advanceTimersByTimeAsync(100);
    expect(port.calls).toHaveLength(7);
    port.pending[0]!.finish();
    await Promise.all(results);

    expect(port.startedAt.map((at) => at - t0)).toEqual([0, 0, 0, 100, 100, 100, 200]);
    expect(limits.load("s")).toEqual({ active: 0, queued: 0, peakActive: 3, admitted: 7 });
  });

  it("shares one server's budget across every Session bound to it, and keeps servers apart", async () => {
    const first = manualPort();
    const second = manualPort();
    const limits = budget({
      shared: { maxConcurrent: 2, maxStarts: Infinity, windowMs: 100 },
      other: { maxConcurrent: 1, maxStarts: Infinity, windowMs: 100 },
    });
    const sessionA = limits.bind(first);
    const sessionB = limits.bind(second);

    const a = [
      sessionA.call(mcpCall("shared", "a1"), never),
      sessionA.call(mcpCall("shared", "a2"), never),
    ];
    const b = sessionB.call(mcpCall("shared", "b1"), never);
    const other = sessionB.call(mcpCall("other", "o1"), never);
    await flush();

    expect(first.calls).toHaveLength(2);
    expect(second.calls.map((call) => call.toolCallId)).toEqual(["o1"]);
    expect(limits.load("shared")).toMatchObject({ active: 2, queued: 1 });
    first.pending[0]!.finish();
    await vi.waitFor(() =>
      expect(second.calls.map((call) => call.toolCallId)).toEqual(["o1", "b1"]),
    );
    for (const port of [first, second]) finishAll(port);
    await Promise.all([...a, b, other]);
    expect(limits.load("shared").peakActive).toBe(2);
    expect(limits.load("other").peakActive).toBe(1);
  });

  it("lets a queued call be withdrawn before it ever reaches the server", async () => {
    const port = manualPort();
    const limits = budget({ s: { maxConcurrent: 1, maxStarts: Infinity, windowMs: 100 } });
    const bound = limits.bind(port);
    const running = bound.call(mcpCall("s", "running"), never);
    const withdrawn = new AbortController();
    const queued = bound.call(mcpCall("s", "queued"), withdrawn.signal);
    const after = bound.call(mcpCall("s", "after"), never);
    await flush();
    expect(limits.load("s").queued).toBe(2);

    withdrawn.abort(new Error("stopped while queued"));
    await expect(queued).rejects.toThrow("stopped while queued");
    expect(limits.load("s").queued).toBe(1);
    port.pending[0]!.finish();
    await vi.waitFor(() =>
      expect(port.calls.map((call) => call.toolCallId)).toEqual(["running", "after"]),
    );
    port.pending[0]!.finish();
    await Promise.all([running, after]);
    expect(limits.load("s")).toMatchObject({ active: 0, queued: 0, admitted: 2 });
  });

  it("drops the window timer when its last waiter is withdrawn", async () => {
    const port = manualPort();
    const limits = budget({ s: { maxConcurrent: 5, maxStarts: 1, windowMs: 100 } });
    const bound = limits.bind(port);
    const first = bound.call(mcpCall("s", "first"), never);
    const withdrawn = new AbortController();
    const queued = bound.call(mcpCall("s", "queued"), withdrawn.signal);
    await flush();
    port.pending[0]!.finish();
    await first;
    expect(vi.getTimerCount()).toBe(1);

    withdrawn.abort(new Error("gone"));
    await expect(queued).rejects.toThrow("gone");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a start until its call settles plus the window, so a slow call holds its slot", async () => {
    const port = manualPort();
    const limits = budget({ s: { maxConcurrent: 5, maxStarts: 1, windowMs: 100 } });
    const bound = limits.bind(port);
    const t0 = Date.now();
    const slow = bound.call(mcpCall("s", "slow"), never);
    const next = bound.call(mcpCall("s", "next"), never);
    await flush();
    // Held by a call still running: its release, not a timer, wakes the queue.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(50);
    port.pending[0]!.finish();
    await slow;
    await vi.advanceTimersByTimeAsync(99);
    expect(port.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.startedAt.map((at) => at - t0)).toEqual([0, 150]);
    port.pending[0]!.finish();
    await next;
  });

  it("never lets a server see more than maxStarts arrivals in any window, however late requests land", async () => {
    // A server that counts arrivals, reached over a network that delays each
    // request by a different amount. Counting from settle is what keeps a
    // late first request and an early later one out of the same window.
    const arrivals: number[] = [];
    let seed = 7;
    const jitter = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % 15;
    };
    const port: RuntimeMcpPort = {
      call: (call) =>
        new Promise((resolve) => {
          const delay = jitter();
          setTimeout(() => {
            arrivals.push(Date.now());
            setTimeout(
              () => resolve({ content: [{ type: "text", text: call.toolCallId }], isError: false }),
              5 + jitter(),
            );
          }, delay);
        }),
    };
    const limits = budget({ s: { maxConcurrent: 4, maxStarts: 6, windowMs: 100 } });
    const bound = limits.bind(port);
    const all = Promise.all(
      Array.from({ length: 40 }, (_, index) => bound.call(mcpCall("s", `c${index}`), never)),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await all;

    expect(arrivals).toHaveLength(40);
    for (const start of arrivals) {
      const inWindow = arrivals.filter((at) => at >= start && at < start + 100).length;
      expect(inWindow).toBeLessThanOrEqual(6);
    }
    expect(limits.load("s")).toMatchObject({ active: 0, queued: 0, admitted: 40 });
  });

  it("refuses a call whose signal is already aborted without queuing it", async () => {
    const port = manualPort();
    const limits = budget({});
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await expect(limits.bind(port).call(mcpCall("s", "x"), controller.signal)).rejects.toThrow(
      "already stopped",
    );
    expect(port.calls).toHaveLength(0);
    expect(limits.load("s")).toEqual({ active: 0, queued: 0, peakActive: 0, admitted: 0 });
  });

  it("withdraws a closed binding's queued and in-flight calls and leaves other Sessions running", async () => {
    const closing = manualPort();
    const staying = manualPort();
    const limits = budget({ s: { maxConcurrent: 2, maxStarts: Infinity, windowMs: 100 } });
    const sessionA = limits.bind(closing);
    const sessionB = limits.bind(staying);
    const inFlight = sessionA.call(mcpCall("s", "a-running"), never);
    const other = sessionB.call(mcpCall("s", "b-running"), never);
    const queued = sessionA.call(mcpCall("s", "a-queued"), never);
    const bQueued = sessionB.call(mcpCall("s", "b-queued"), never);
    await flush();

    sessionA.close();

    await expect(inFlight).rejects.toThrow("MCP attachment closed");
    await expect(queued).rejects.toThrow("MCP attachment closed");
    await expect(sessionA.call(mcpCall("s", "late"), never)).rejects.toThrow(
      "MCP attachment closed",
    );
    await vi.waitFor(() =>
      expect(staying.calls.map((call) => call.toolCallId)).toEqual(["b-running", "b-queued"]),
    );
    expect(closing.calls.map((call) => call.toolCallId)).toEqual(["a-running"]);
    finishAll(staying);
    await Promise.all([other, bQueued]);
    expect(limits.load("s")).toMatchObject({ active: 0, queued: 0 });

    const custom = limits.bind(manualPort());
    custom.close(new Error("custom reason"));
    await expect(custom.call(mcpCall("s", "x"), never)).rejects.toThrow("custom reason");
  });

  it("hands each call to the port exactly once and releases its slot when it fails", async () => {
    const port = manualPort();
    const limits = budget({ s: { maxConcurrent: 1, maxStarts: Infinity, windowMs: 100 } });
    const bound = limits.bind(port);
    const failing = bound.call(mcpCall("s", "fails"), never);
    const next = bound.call(mcpCall("s", "next"), never);
    await flush();

    port.pending[0]!.fail(new Error("server down"));
    await expect(failing).rejects.toThrow("server down");
    await vi.waitFor(() => expect(port.calls).toHaveLength(2));
    port.pending[0]!.finish();
    await next;

    expect(port.calls.map((call) => call.toolCallId)).toEqual(["fails", "next"]);
    expect(limits.load("s")).toMatchObject({ active: 0, admitted: 2 });
  });

  it("uses a monotonic clock when the host supplies none", () => {
    const now = vi.spyOn(performance, "now");
    const bound = new McpServerBudget({
      limitsFor: () => ({ maxConcurrent: 1, maxStarts: 1, windowMs: 100 }),
    }).bind(manualPort());
    void bound.call(mcpCall("s", "x"), never);
    expect(now).toHaveBeenCalled();
  });
});

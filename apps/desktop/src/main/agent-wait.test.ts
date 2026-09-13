import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { optionalPositiveNumber, parkForWake, waitRefusal } from "./agent-wait";

afterEach(() => vi.useRealTimers());

describe("Agent wait fields", () => {
  it("builds a readable refusal and accepts only positive finite numbers", () => {
    expect(waitRefusal("No.")).toEqual({ text: "No." });
    expect(optionalPositiveNumber({}, "timeoutSeconds")).toEqual({ ok: true, value: undefined });
    expect(optionalPositiveNumber({ timeoutSeconds: null }, "timeoutSeconds")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(optionalPositiveNumber({ timeoutSeconds: 2 }, "timeoutSeconds")).toEqual({
      ok: true,
      value: 2,
    });
    for (const value of [0, -1, Number.POSITIVE_INFINITY, "2"]) {
      expect(optionalPositiveNumber({ timeoutSeconds: value }, "timeoutSeconds")).toEqual({
        ok: false,
        text: "`timeoutSeconds` must be a positive number when given.",
      });
    }
  });
});

describe("parkForWake", () => {
  it("ignores unrelated wakes, answers once, and unsubscribes", async () => {
    let listener: ((wake: number) => void) | undefined;
    const unsubscribe = vi.fn();
    const pending = parkForWake<number>({
      signal: new AbortController().signal,
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
      onWake: (wake) => (wake === 2 ? { text: "matched" } : undefined),
    });

    listener?.(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    listener?.(2);
    await expect(pending).resolves.toEqual({ text: "matched" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    listener?.(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("opens the live subscription before a durable replay and cleans it up", async () => {
    const order: string[] = [];
    const unsubscribe = vi.fn();
    const result = await parkForWake<number>({
      signal: new AbortController().signal,
      subscribe: () => {
        order.push("subscribe");
        return unsubscribe;
      },
      onWake: () => undefined,
      replay: () => {
        order.push("replay");
        return { text: "durable" };
      },
    });

    expect(result).toEqual({ text: "durable" });
    expect(order).toEqual(["subscribe", "replay"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("also cleans up a subscriber that answers synchronously while opening", async () => {
    const unsubscribe = vi.fn();
    const result = await parkForWake<number>({
      signal: new AbortController().signal,
      subscribe: (listener) => {
        listener(1);
        return unsubscribe;
      },
      onWake: () => ({ text: "synchronous" }),
    });

    expect(result).toEqual({ text: "synchronous" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("times out and withdraws through the caller's abort signal", async () => {
    vi.useFakeTimers();
    const timedOut = parkForWake<number>({
      signal: new AbortController().signal,
      subscribe: () => () => undefined,
      onWake: () => undefined,
      timeoutMs: 1000,
      onTimeout: () => ({ text: "timeout" }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(timedOut).resolves.toEqual({ text: "timeout" });

    const controller = new AbortController();
    const withdrawn = parkForWake<number>({
      signal: controller.signal,
      subscribe: () => () => undefined,
      onWake: () => undefined,
    });
    controller.abort();
    await expect(withdrawn).rejects.toThrow("withdrawn");

    const already = new AbortController();
    already.abort();
    await expect(
      parkForWake<number>({
        signal: already.signal,
        subscribe: () => () => undefined,
        onWake: () => undefined,
      }),
    ).rejects.toThrow("withdrawn");
  });

  it("rejects and cleans up when live, replay, or timeout rendering fails", async () => {
    let listener: ((wake: number) => void) | undefined;
    const live = parkForWake<number>({
      signal: new AbortController().signal,
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      onWake: () => {
        throw new Error("live failed");
      },
    });
    listener?.(1);
    await expect(live).rejects.toThrow("live failed");

    await expect(
      parkForWake<number>({
        signal: new AbortController().signal,
        subscribe: () => () => undefined,
        onWake: () => undefined,
        replay: () => {
          throw new Error("replay failed");
        },
      }),
    ).rejects.toThrow("replay failed");

    vi.useFakeTimers();
    const timeout = parkForWake<number>({
      signal: new AbortController().signal,
      subscribe: () => () => undefined,
      onWake: () => undefined,
      timeoutMs: 1,
      onTimeout: () => {
        throw new Error("timeout failed");
      },
    });
    const rejectedTimeout = expect(timeout).rejects.toThrow("timeout failed");
    await vi.advanceTimersByTimeAsync(1);
    await rejectedTimeout;
  });
});

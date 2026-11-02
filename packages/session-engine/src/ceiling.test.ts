import { describe, expect, it } from "vite-plus/test";
import {
  attachCancelledError,
  isAttachWaitTimeout,
  isAttachWaitTimeoutDetail,
  withCeiling,
} from "./ceiling";

describe("withCeiling (VC-1072)", () => {
  it("abandons at once a wait whose stop came before it began", async () => {
    const stop = new AbortController();
    stop.abort(attachCancelledError());
    let abandoned = 0;

    const waiting = withCeiling(new Promise<never>(() => undefined), {
      ms: 60_000,
      timeout: () => new Error("never"),
      abandon: () => (abandoned += 1),
      signal: stop.signal,
    });

    await expect(waiting).rejects.toThrow("attach_cancelled");
    expect(abandoned).toBe(1);
  });

  it("never gives up once the operation has settled, and gives up at most once", async () => {
    const stop = new AbortController();
    let abandoned = 0;
    let finish!: (value: string) => void;
    const operation = new Promise<string>((resolve) => (finish = resolve));
    const waiting = withCeiling(operation, {
      ms: 60_000,
      timeout: () => new Error("never"),
      abandon: () => (abandoned += 1),
      signal: stop.signal,
    });

    finish("opened");
    await operation;
    // A stop that lands after the operation won must not take back its result.
    stop.abort(attachCancelledError());

    await expect(waiting).resolves.toBe("opened");
    expect(abandoned).toBe(0);
  });

  it("does not give up on an operation that failed on its own", async () => {
    const stop = new AbortController();
    let abandoned = 0;
    const waiting = withCeiling(Promise.reject(new Error("late failure")), {
      ms: 0,
      timeout: () => new Error("ran out"),
      abandon: () => (abandoned += 1),
      signal: stop.signal,
    });

    await expect(waiting).rejects.toThrow("late failure");
    stop.abort(attachCancelledError());
    expect(abandoned).toBe(0);
  });

  it("abandons once when the ceiling runs out and a stop follows", async () => {
    const stop = new AbortController();
    let abandoned = 0;
    const waiting = withCeiling(new Promise<never>(() => undefined), {
      ms: 0,
      timeout: () => new Error("ran out"),
      abandon: () => (abandoned += 1),
      signal: stop.signal,
    });

    await expect(waiting).rejects.toThrow("ran out");
    stop.abort(attachCancelledError());
    expect(abandoned).toBe(1);
  });

  it("answers with the operation when it finishes first", async () => {
    await expect(
      withCeiling(Promise.resolve("opened"), { ms: 60_000, timeout: () => new Error("never") }),
    ).resolves.toBe("opened");
  });
});

describe("attach wait timeouts (VC-1072)", () => {
  it("are told apart from every other failure by code and by recorded detail", () => {
    expect(isAttachWaitTimeout(new Error("attach_timeout"))).toBe(false);
    expect(isAttachWaitTimeoutDetail("attach_timeout: binding recovery did not finish")).toBe(true);
    expect(isAttachWaitTimeoutDetail("queue_admission_timeout: executor attach")).toBe(true);
    expect(isAttachWaitTimeoutDetail("Pi exited.")).toBe(false);
    expect(isAttachWaitTimeoutDetail(null)).toBe(false);
    expect(isAttachWaitTimeoutDetail(undefined)).toBe(false);
  });
});

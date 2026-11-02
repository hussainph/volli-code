import { describe, expect, it } from "vite-plus/test";
import {
  attachCancelledError,
  isAttachCancelled,
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

    await expect(waiting).rejects.toSatisfy(isAttachCancelled);
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

import { describe, expect, it } from "vite-plus/test";
import { ATTACH_TIMEOUT_CODE, isAttachTimeoutAttention } from "./attach-timeout";

describe("isAttachTimeoutAttention (VC-1072)", () => {
  const timedOut = `${ATTACH_TIMEOUT_CODE}: executor attach did not finish within 180 s.`;

  it("reads an attach failure whose detail is a timeout", () => {
    expect(isAttachTimeoutAttention({ kind: "adapter_unrecoverable", detail: timedOut })).toBe(
      true,
    );
  });

  it("reads the queue's report of a message held behind that timeout", () => {
    expect(
      isAttachTimeoutAttention({
        kind: "adapter_unrecoverable",
        detail: `Queued message is waiting: adapter_unrecoverable: ${timedOut}`,
      }),
    ).toBe(true);
  });

  it("does not read a timeout quoted by a recovery wrapper, a multi-blocker report or prose", () => {
    for (const detail of [
      `Recovery failed: ${timedOut}`,
      `Retry recovery failed: ${timedOut}`,
      `Attachment recovery failed: ${timedOut}`,
      `Queued message is waiting: adapter_unrecoverable: ${timedOut}; configuration_invalid: no model`,
      `Queued message is waiting: configuration_invalid: x; adapter_unrecoverable: ${timedOut}`,
      `The provider said: ${timedOut}`,
    ]) {
      expect(isAttachTimeoutAttention({ kind: "adapter_unrecoverable", detail })).toBe(false);
    }
  });

  it("leaves every other stop, and every other kind, as it was", () => {
    expect(isAttachTimeoutAttention({ kind: "adapter_unrecoverable", detail: "Pi exited." })).toBe(
      false,
    );
    expect(isAttachTimeoutAttention({ kind: "adapter_unrecoverable", detail: null })).toBe(false);
    expect(isAttachTimeoutAttention({ kind: "configuration_invalid", detail: timedOut })).toBe(
      false,
    );
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import { credentialsBusy, CREDENTIALS_READY } from "./credential-state";
import { waitForCredentialRead } from "./credential-wait";

describe("bounded credential reads", () => {
  it("retries busy snapshots and returns the successful read, not a stale snapshot", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce({ status: credentialsBusy(), records: [] })
      .mockReturnValue({ status: CREDENTIALS_READY, records: ["record"] });
    expect(await waitForCredentialRead(read, (result) => result.status, 1000)).toEqual({
      status: CREDENTIALS_READY,
      records: ["record"],
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns the last busy snapshot at the bound, and propagates other failures", async () => {
    const busy = { status: credentialsBusy(), records: [] };
    expect(
      await waitForCredentialRead(
        () => busy,
        (result) => result.status,
        0,
      ),
    ).toBe(busy);
    await expect(
      waitForCredentialRead(
        () => {
          throw new Error("failure");
        },
        () => CREDENTIALS_READY,
        1000,
      ),
    ).rejects.toThrow("failure");
  });
});

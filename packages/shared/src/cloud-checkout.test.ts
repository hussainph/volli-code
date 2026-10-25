import { describe, expect, it } from "vite-plus/test";

import { CLOUD_CHECKOUT_STATES } from "./cloud-checkout";
import { DESKTOP_ENTRIES } from "./desktop-entries";

describe("a cloud project's folder on this Mac: wire vocabulary", () => {
  it("names each state once", () => {
    expect(CLOUD_CHECKOUT_STATES).toEqual(["located", "missing", "no_runner"]);
  });

  it("declares every checkouts entry host-placed and client-local, its read as a read", () => {
    const checkouts = DESKTOP_ENTRIES.filter(({ key }) => key.startsWith("checkouts."));
    expect(checkouts.map(({ key, idempotency }) => [key, idempotency])).toEqual([
      ["checkouts.status", "read"],
      ["checkouts.chooseFolder", "natural"],
    ]);
    for (const entry of checkouts) {
      expect(entry.placement, entry.key).toBe("host");
      expect(entry.compatibility, entry.key).toBe("client-local");
    }
  });
});

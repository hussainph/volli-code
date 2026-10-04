import { describe, expect, it } from "vite-plus/test";

import { HOST_RECEIPT_STATUSES } from "./commands";

describe("the receipt vocabulary", () => {
  // `@volli/session-rpc` pins this list to `CommandReceipt["status"]` by type.
  it("is the Session engine's, with no invented 'applied'", () => {
    expect(HOST_RECEIPT_STATUSES).toStrictEqual(["accepted", "rejected", "completed", "unreconciled"]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { ACCOUNT_CONNECTIONS, UNCONFIGURED_ACCOUNT, isAccountConnection } from "./account";
import { DESKTOP_ENTRIES } from "./desktop-entries";

describe("the account wire vocabulary", () => {
  it("knows exactly the two sign-in buttons", () => {
    expect(ACCOUNT_CONNECTIONS).toEqual(["github", "google"]);
    expect(isAccountConnection("github")).toBe(true);
    expect(isAccountConnection("google")).toBe(true);
    for (const other of ["GitHub", "apple", "", null, undefined, 1, {}]) {
      expect(isAccountConnection(other)).toBe(false);
    }
  });

  it("answers an unconfigured build with no provider, account or failure", () => {
    expect(UNCONFIGURED_ACCOUNT).toEqual({
      state: "unconfigured",
      provider: null,
      signingInWith: null,
      account: null,
      failure: null,
    });
    expect(Object.isFrozen(UNCONFIGURED_ACCOUNT)).toBe(true);
  });

  it("declares every account entry host-placed and client-local, its reads as reads", () => {
    const account = DESKTOP_ENTRIES.filter(({ key }) => key.startsWith("account."));
    expect(account.map(({ key }) => key)).toEqual([
      "account.snapshot",
      "account.subscribe",
      "account.signIn",
      "account.cancelSignIn",
      "account.signOut",
      "account.requestDeletion",
      "account.cancelDeletion",
    ]);
    for (const entry of account) {
      expect(entry.placement, entry.key).toBe("host");
      expect(entry.compatibility, entry.key).toBe("client-local");
    }
    expect(
      account.filter(({ idempotency }) => idempotency === "read").map(({ key }) => key),
    ).toEqual(["account.snapshot", "account.subscribe"]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  ACCOUNT_CONNECTIONS,
  ACCOUNT_TOKEN_MAX,
  ACCOUNT_TOKEN_RETRY_MS,
  LOCAL_LAUNCH,
  UNCONFIGURED_ACCOUNT,
  isAccountConnection,
} from "./account";
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
      "account.accessToken",
    ]);
    for (const entry of account) {
      expect(entry.placement, entry.key).toBe("host");
      expect(entry.compatibility, entry.key).toBe("client-local");
    }
    expect(
      account.filter(({ idempotency }) => idempotency === "read").map(({ key }) => key),
    ).toEqual(["account.snapshot", "account.subscribe", "account.accessToken"]);
  });

  it("declares the launch entries host-placed and client-local", () => {
    const cloud = DESKTOP_ENTRIES.filter(({ key }) => key.startsWith("cloud."));
    expect(cloud.map(({ key, idempotency }) => [key, idempotency])).toEqual([
      ["cloud.launch", "read"],
      ["cloud.relaunch", "natural"],
      ["cloud.reportUnsavedWrites", "natural"],
      ["cloud.saveSnapshot", "natural"],
      ["cloud.readSnapshot", "read"],
    ]);
    for (const entry of cloud) {
      expect(entry.placement, entry.key).toBe("host");
      expect(entry.compatibility, entry.key).toBe("client-local");
    }
  });

  it("launches local by default", () => {
    expect(LOCAL_LAUNCH).toEqual({ store: "local" });
    expect(Object.isFrozen(LOCAL_LAUNCH)).toBe(true);
    expect(ACCOUNT_TOKEN_RETRY_MS).toBeGreaterThan(0);
    expect(ACCOUNT_TOKEN_MAX).toBeGreaterThan(1024);
  });
});

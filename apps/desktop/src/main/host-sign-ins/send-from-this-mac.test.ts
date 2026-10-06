// @vitest-environment node
/**
 * "Send from this Mac" against a fake credential store: no real `auth.json`
 * is ever read, and no keychain is asked.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import {
  macKeyAvailability,
  sendApiKeyFromThisMac,
  type MacCredentialReader,
  type MacStoredCredential,
} from "./send-from-this-mac";

const KEY = "sk-or-v1-THIS-MACS-KEY-0123456789";

function fakeStore(entries: Record<string, MacStoredCredential>): MacCredentialReader & {
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    read: async (providerId) => {
      reads.push(providerId);
      return entries[providerId];
    },
  };
}

const store = () =>
  fakeStore({
    openrouter: { type: "api_key", key: KEY },
    anthropic: { type: "oauth" },
    ambient: { type: "api_key" },
  });

describe("macKeyAvailability", () => {
  it("says whether this Mac holds a key to send, never the key", async () => {
    const credentials = store();
    expect(await macKeyAvailability(credentials, "openrouter")).toEqual({ kind: "key" });
    expect(await macKeyAvailability(credentials, "anthropic")).toEqual({ kind: "subscription" });
    expect(await macKeyAvailability(credentials, "ambient")).toEqual({ kind: "none" });
    expect(await macKeyAvailability(credentials, "absent")).toEqual({ kind: "none" });
  });
});

describe("sendApiKeyFromThisMac", () => {
  it("sends this Mac's key to the host and answers the host's status, never the key", async () => {
    const credentials = store();
    const setApiKey = vi.fn(async () => ({ providers: [], git: [] }));
    const sent = await sendApiKeyFromThisMac({
      providerId: "openrouter",
      confirmed: true,
      store: credentials,
      setApiKey,
    });
    expect(setApiKey).toHaveBeenCalledExactlyOnceWith({ providerId: "openrouter", key: KEY });
    expect(sent).toEqual({ ok: true, status: { providers: [], git: [] } });
    expect(JSON.stringify(sent)).not.toContain(KEY);
  });

  it("never sends a subscription login, and has nothing to send without a stored key", async () => {
    const setApiKey = vi.fn(async () => "status");
    const send = (providerId: string) =>
      sendApiKeyFromThisMac({ providerId, confirmed: true, store: store(), setApiKey });
    expect(await send("anthropic")).toEqual({ ok: false, reason: "subscription" });
    expect(await send("ambient")).toEqual({ ok: false, reason: "no-key" });
    expect(await send("absent")).toEqual({ ok: false, reason: "no-key" });
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it("reads nothing without the person's confirm", async () => {
    const credentials = store();
    const setApiKey = vi.fn(async () => "status");
    expect(
      await sendApiKeyFromThisMac({
        providerId: "openrouter",
        confirmed: false as unknown as true,
        store: credentials,
        setApiKey,
      }),
    ).toEqual({ ok: false, reason: "no-key" });
    expect(credentials.reads).toEqual([]);
    expect(setApiKey).not.toHaveBeenCalled();
  });

  it("reports a failed send without repeating the link's words", async () => {
    const sent = await sendApiKeyFromThisMac({
      providerId: "openrouter",
      confirmed: true,
      store: store(),
      setApiKey: async () => {
        throw new Error(`refused ${KEY}`);
      },
    });
    expect(sent).toEqual({ ok: false, reason: "send-failed" });
  });
});

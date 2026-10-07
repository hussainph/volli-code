import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { piHostCredentials } from "./host-credentials";

const KEY = "sk-or-v1-THE-KEY-A-CLIENT-SENT";
const REFRESH = "rt-THE-REFRESH-TOKEN-ON-THE-HOST";

describe("piHostCredentials", () => {
  it("writes a sent key into Pi's store and reads back availability, never a value", async () => {
    const store = new InMemoryCredentialStore();
    await store.modify("anthropic", async () => ({
      type: "oauth",
      access: "at",
      refresh: REFRESH,
      expires: 1_234,
    }));
    const credentials = piHostCredentials(store);
    await credentials.setApiKey("openrouter", KEY);
    expect(await store.read("openrouter")).toEqual({ type: "api_key", key: KEY });
    const stored = await credentials.stored();
    expect(stored.toSorted((a, b) => a.providerId.localeCompare(b.providerId))).toEqual([
      { providerId: "anthropic", type: "oauth", expiresAt: 1_234 },
      { providerId: "openrouter", type: "api-key", expiresAt: null },
    ]);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(JSON.stringify(stored)).not.toContain(REFRESH);
  });

  it("reads an OAuth entry that vanished between list and read as no expiry", async () => {
    const credentials = piHostCredentials({
      list: async () => [{ providerId: "anthropic", type: "oauth" }],
      read: async () => undefined,
      modify: async () => undefined,
    });
    expect(await credentials.stored()).toEqual([
      { providerId: "anthropic", type: "oauth", expiresAt: null },
    ]);
  });
});

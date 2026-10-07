// @vitest-environment node
/**
 * The main-side sign-in service over fake host links and a fake Mac
 * credential store: no real `auth.json`, keychain or host is touched.
 */
import type { HostSignInStatus } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createHostSignInService,
  HostUnreachableError,
  MAX_MAC_KEYS,
  MAX_PROVIDER_ID_LENGTH,
  UNCONNECTED_HOST_SIGN_IN_LINKS,
  type HostSignInHostLink,
  type MacCredentialStore,
} from "./service";

const KEY = "sk-or-v1-THIS-MACS-KEY-0123456789";
const STATUS: HostSignInStatus = { providers: [], git: [] };

function fakeMac(): MacCredentialStore {
  const entries = {
    openrouter: { type: "api_key" as const, key: KEY },
    ambient: { type: "api_key" as const },
    anthropic: { type: "oauth" as const },
  };
  return {
    list: async () =>
      Object.entries(entries).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    read: async (providerId) => entries[providerId as keyof typeof entries],
  };
}

function fakeHost(): HostSignInHostLink {
  return {
    status: vi.fn(async () => STATUS),
    setApiKey: vi.fn(async () => STATUS),
    setGitCredential: vi.fn(async () => STATUS),
    start: vi.fn(async () => ({ flowId: "flow-1" })),
    subscribe: vi.fn(() => ({ unsubscribe: () => {} })),
    deliver: vi.fn(async () => ({ status: 200 })),
    answer: vi.fn(async () => null),
    cancel: vi.fn(async () => null),
    watchLoss: vi.fn(() => () => {}),
  };
}

describe("createHostSignInService", () => {
  it("answers each host over its own link, and this Mac's keys as provider ids only", async () => {
    const host = fakeHost();
    const service = createHostSignInService({
      links: { linkFor: (hostId) => (hostId === "host-1" ? host : null) },
      mac: fakeMac(),
      openExternal: vi.fn(),
    });
    expect(await service.status("host-1")).toBe(STATUS);
    expect(await service.macKeys()).toEqual(["openrouter"]);
    await service.setApiKey("host-1", "openrouter", "sk-pasted");
    expect(host.setApiKey).toHaveBeenCalledWith({ providerId: "openrouter", key: "sk-pasted" });
    await service.setGitCredential("host-1", { host: "github.com", username: "x", password: "t" });
    expect(host.setGitCredential).toHaveBeenCalledOnce();
    const sent = await service.sendFromThisMac("host-1", "openrouter", true);
    expect(host.setApiKey).toHaveBeenLastCalledWith({ providerId: "openrouter", key: KEY });
    expect(JSON.stringify(sent)).not.toContain(KEY);
    const run = service.signInOnHost("host-1", "xai", () => {});
    expect(await run.flowId).toBe("flow-1");
    expect(host.start).toHaveBeenCalledWith({ providerId: "xai" });
  });

  it("refuses a host this Mac has no link to, and has none until the registry lands", async () => {
    const service = createHostSignInService({
      links: UNCONNECTED_HOST_SIGN_IN_LINKS,
      mac: fakeMac(),
      openExternal: vi.fn(),
      bind: vi.fn(),
    });
    await expect(service.status("host-1")).rejects.toBeInstanceOf(HostUnreachableError);
    await expect(service.sendFromThisMac("host-1", "openrouter", true)).rejects.toThrow(
      "no connection",
    );
    expect(() => service.signInOnHost("host-1", "xai", () => {})).toThrow(HostUnreachableError);
  });

  it("offers a bounded list of this Mac's keys, each a provider id a row can name", async () => {
    const many = Array.from({ length: MAX_MAC_KEYS + 5 }, (_, index) => ({
      providerId: `p${index}`,
      type: "api_key" as const,
    }));
    const service = createHostSignInService({
      links: UNCONNECTED_HOST_SIGN_IN_LINKS,
      mac: {
        list: async () => [
          { providerId: "x".repeat(MAX_PROVIDER_ID_LENGTH + 1), type: "api_key" as const },
          ...many,
        ],
        read: async () => ({ type: "api_key", key: KEY }),
      },
      openExternal: vi.fn(),
    });
    const keys = await service.macKeys();
    expect(keys).toHaveLength(MAX_MAC_KEYS);
    expect(keys[0]).toBe("p0");
  });
});

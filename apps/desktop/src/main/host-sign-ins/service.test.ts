// @vitest-environment node
/**
 * The main-side sign-in service over fake host links and a fake Mac
 * credential store: no real `auth.json`, keychain or host is touched.
 */
import type { HostSignInStatus } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

// Main-test cleanup imports broadcast; never load a real Electron binary.
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { HostSignInController } from "../../renderer/src/components/hosts/sign-ins/host-sign-in-controller";
import { remoteSignInsPort } from "./port";
import {
  createHostSignInService,
  HostUnreachableError,
  MAX_MAC_KEYS,
  MAX_PROVIDER_ID_LENGTH,
  UNCONNECTED_HOST_SIGN_IN_LINKS,
  type HostSignInHostLink,
  type MacCredentialStore,
} from "./service";

const sendConfirmation = {
  resolve: () => ({ providerLabel: "OpenRouter", hostName: "Build box", hostTarget: "me@box" }),
  confirm: async () => ({ isCurrent: () => true, dispose: vi.fn() }),
};

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
      sendConfirmation,
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
      sendConfirmation,
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
      sendConfirmation,
    });
    const keys = await service.macKeys();
    expect(keys).toHaveLength(MAX_MAC_KEYS);
    expect(keys[0]).toBe("p0");
  });
});

function sendFixture() {
  const host = fakeHost();
  let lost!: () => void;
  const stop = vi.fn();
  host.watchLoss = vi.fn((listener) => {
    lost = listener;
    return stop;
  });
  const labels = {
    providerLabel: "Local OpenRouter",
    hostName: "My host",
    hostTarget: "me@my-box",
  };
  const confirmation = {
    resolve: vi.fn((_hostId: string, _providerId: string) => labels as typeof labels | null),
    confirm: vi.fn(
      async () =>
        ({ isCurrent: () => true, dispose: vi.fn() }) as
          | {
              isCurrent(): boolean;
              dispose(): void;
            }
          | "cancelled"
          | null,
    ),
  };
  const mac = {
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({ type: "api_key" as const, key: KEY })),
  };
  const links = { linkFor: vi.fn((_hostId: string) => host as HostSignInHostLink | null) };
  const service = createHostSignInService({
    links,
    mac,
    openExternal: vi.fn(),
    sendConfirmation: confirmation,
  });
  return { host, labels, confirmation, mac, links, service, lose: () => lost(), stop };
}
function pendingValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Send from this Mac requires main-owned native confirmation", () => {
  it("resolves ids through main, then passes only trusted labels to the native dialog", async () => {
    const f = sendFixture();
    expect(await f.service.sendFromThisMac("host-1", "openrouter", true)).toEqual({
      ok: true,
      status: STATUS,
    });
    expect(f.confirmation.resolve).toHaveBeenCalledWith("host-1", "openrouter");
    expect(f.confirmation.confirm).toHaveBeenCalledExactlyOnceWith(f.labels);
    expect(f.mac.read).toHaveBeenCalledExactlyOnceWith("openrouter");
    expect(f.host.status).not.toHaveBeenCalled(); // Never trust the host's provider label.
    expect(f.host.setApiKey).toHaveBeenCalledExactlyOnceWith({
      providerId: "openrouter",
      key: KEY,
    });
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "missing-seam",
    "unknown-labels",
    "resolver-error",
    "cancel",
    "dialog-error",
    "renderer-false",
  ])("reads/sends nothing for %s", async (state) => {
    const f = sendFixture();
    if (state === "unknown-labels") f.confirmation.resolve.mockReturnValue(null);
    if (state === "resolver-error")
      f.confirmation.resolve.mockImplementation(() => {
        throw new Error(KEY);
      });
    if (state === "cancel") f.confirmation.confirm.mockResolvedValue("cancelled");
    if (state === "dialog-error") f.confirmation.confirm.mockRejectedValue(new Error(KEY));
    const service =
      state === "missing-seam"
        ? createHostSignInService({
            links: f.links,
            mac: f.mac,
            openExternal: vi.fn(),
            sendConfirmation: undefined as unknown as typeof sendConfirmation,
          })
        : f.service;
    const result = await service.sendFromThisMac(
      "host-1",
      "openrouter",
      (state !== "renderer-false") as true,
    );
    expect(result).toEqual(
      state === "cancel"
        ? { ok: true, status: STATUS }
        : { ok: false, reason: state === "renderer-false" ? "no-key" : "send-failed" },
    );
    if (state === "cancel") expect(f.host.status).toHaveBeenCalledOnce();
    expect(f.mac.read).not.toHaveBeenCalled();
    expect(f.host.setApiKey).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "lost-and-reconnected",
    "removed",
    "missing-labels",
    "provider-renamed",
    "host-renamed",
    "target-changed",
  ])("does not read/send after %s while awaiting native approval", async (change) => {
    const f = sendFixture();
    const dialog = pendingValue<Awaited<ReturnType<typeof f.confirmation.confirm>>>();
    const dispose = vi.fn();
    f.confirmation.confirm.mockReturnValue(dialog.promise);
    const pending = f.service.sendFromThisMac("host-1", "openrouter", true);
    expect(f.mac.read).not.toHaveBeenCalled();
    if (change === "lost-and-reconnected") f.lose(); // Ready again does not undo loss.
    if (change === "removed") f.links.linkFor.mockReturnValue(null);
    if (change === "missing-labels") f.confirmation.resolve.mockReturnValue(null);
    if (change === "provider-renamed")
      f.confirmation.resolve.mockReturnValue({ ...f.labels, providerLabel: "New provider" });
    if (change === "host-renamed")
      f.confirmation.resolve.mockReturnValue({ ...f.labels, hostName: "New host" });
    if (change === "target-changed")
      f.confirmation.resolve.mockReturnValue({ ...f.labels, hostTarget: "me@another-box" });
    dialog.resolve({ isCurrent: () => true, dispose });
    expect(await pending).toEqual({ ok: false, reason: "send-failed" });
    expect(f.mac.read).not.toHaveBeenCalled();
    expect(f.host.setApiKey).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each([
    "lost-and-reconnected",
    "removed",
    "missing-labels",
    "provider-renamed",
    "host-renamed",
    "target-changed",
  ])("does not send after %s during the credential read", async (change) => {
    const f = sendFixture();
    const credential = pendingValue<{ type: "api_key"; key: string }>();
    f.mac.read.mockReturnValue(credential.promise);
    const pending = f.service.sendFromThisMac("host-1", "openrouter", true);
    await Promise.resolve();
    expect(f.mac.read).toHaveBeenCalledOnce();
    if (change === "lost-and-reconnected") f.lose();
    if (change === "removed") f.links.linkFor.mockReturnValue(null);
    if (change === "missing-labels") f.confirmation.resolve.mockReturnValue(null);
    if (change === "provider-renamed")
      f.confirmation.resolve.mockReturnValue({ ...f.labels, providerLabel: "New provider" });
    if (change === "host-renamed")
      f.confirmation.resolve.mockReturnValue({ ...f.labels, hostName: "New host" });
    if (change === "target-changed")
      f.confirmation.resolve.mockReturnValue({ ...f.labels, hostTarget: "me@another-box" });
    credential.resolve({ type: "api_key", key: KEY });
    expect(await pending).toEqual({ ok: false, reason: "send-failed" });
    expect(f.host.setApiKey).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("projects native Cancel through the real service/port/controller without a false signed-in row", async () => {
    const f = sendFixture();
    const unchanged: HostSignInStatus = {
      providers: [
        {
          providerId: "openrouter",
          label: "OpenRouter",
          state: "missing",
          kind: null,
          methods: [{ type: "api-key", label: "API key", isSubscription: false }],
        },
      ],
      git: [{ host: "github.com", state: "signed-in", kind: "git" }],
    };
    vi.mocked(f.host.status).mockResolvedValue(unchanged);
    f.confirmation.confirm.mockResolvedValue("cancelled");
    const port = remoteSignInsPort(f.service);
    const controller = new HostSignInController(
      {
        status: async (hostId) => port.status(hostId),
        macKeys: async () => port.macKeys(),
        sendFromThisMac: async (hostId, providerId) => port.sendFromThisMac(hostId, providerId),
        setApiKey: async (hostId, providerId, key) => port.setApiKey(hostId, providerId, key),
        setGitCredential: async (hostId, input) => port.setGitCredential(hostId, input),
        signInOnHost: () => {
          throw new Error("No subscription requested");
        },
        openExternal: vi.fn(),
      },
      "host-1",
    );
    await controller.refresh();
    const rows = controller.getSnapshot().rows;
    controller.requestSend("openrouter");
    await controller.confirmSend("openrouter");
    expect(controller.getSnapshot().rows).toEqual(rows);
    expect(controller.getSnapshot().flows["provider:openrouter"]).toEqual({ kind: "idle" });
    expect(controller.getSnapshot().rows?.find((row) => row.id === "openrouter")?.state).toBe(
      "missing",
    );
    expect(f.mac.read).not.toHaveBeenCalled();
    expect(f.host.setApiKey).not.toHaveBeenCalled();
    controller.dispose();
  });
});

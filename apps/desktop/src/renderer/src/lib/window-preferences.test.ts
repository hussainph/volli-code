import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const spies = vi.hoisted(() => ({
  accept: vi.fn(() => true),
  ui: vi.fn(),
  style: vi.fn(),
  hydrate: vi.fn(),
  retention: vi.fn(),
  accepted: null as ((key: string) => void) | null,
  stopAccepted: vi.fn(),
}));
vi.mock("./app-state-storage", () => ({
  acceptAppStateValue: spies.accept,
  onPreferenceValueAccepted: (listener: (key: string) => void) => {
    spies.accepted = listener;
    return spies.stopAccepted;
  },
}));
vi.mock("@renderer/stores/ui", () => ({
  UI_APP_STATE_KEY: "volli:ui",
  useUiStore: { persist: { rehydrate: spies.ui } },
}));
vi.mock("@renderer/stores/style", () => ({
  useStyleStore: { persist: { rehydrate: spies.style } },
}));
vi.mock("@renderer/stores/theme", () => ({
  useThemeStore: {
    getState: () => ({
      globalCanvas: { stops: [] },
      globalAppearance: "dark",
      hydrateGlobal: spies.hydrate,
    }),
  },
}));
vi.mock("@renderer/stores/retention-ttl", () => ({
  useRetentionTtlStore: { getState: () => ({ adopt: spies.retention }) },
}));
import { startWindowPreferenceSync } from "./window-preferences";
let event: (change: { key: string; value: string }) => void;
const unsubscribe = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  spies.accept.mockReturnValue(true);
  vi.stubGlobal("window", {
    api: {
      appState: {
        onChanged: (listener: typeof event) => {
          event = listener;
          return unsubscribe;
        },
      },
    },
  });
});
describe("window preference synchronization", () => {
  it("buffers changes during bootstrap, replaying the latest accepted value after hydration", () => {
    const sync = startWindowPreferenceSync();
    event({ key: "appearance", value: "dark" });
    event({ key: "appearance", value: "light" });
    event({ key: "volli:ui", value: '{"state":{"costVisible":false}}' });
    expect(spies.hydrate).not.toHaveBeenCalled();
    expect(spies.ui).not.toHaveBeenCalled();
    sync.activate();
    expect(spies.hydrate).toHaveBeenCalledExactlyOnceWith(
      { theme: '{"stops":[]}', appearance: "light" },
      { live: true },
    );
    expect(spies.ui).toHaveBeenCalledOnce();
    sync.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(spies.stopAccepted).toHaveBeenCalledOnce();
  });
  it("adopts accepted retention policy in a peer without another read", () => {
    const sync = startWindowPreferenceSync();
    event({ key: "volli:retention", value: '{"ttlDays":3}' });
    expect(spies.retention).not.toHaveBeenCalled();
    sync.activate();
    expect(spies.retention).toHaveBeenCalledExactlyOnceWith(3);
    sync.stop();
  });
  it("rehydrates only shared preferences, never workspace navigation or drafts", () => {
    const sync = startWindowPreferenceSync();
    sync.activate();
    event({ key: "volli:workspace", value: "workspace" });
    event({ key: "volli:chat-drafts", value: "drafts" });
    event({ key: "volli:style", value: "style" });
    expect(spies.accept).toHaveBeenCalledExactlyOnceWith("volli:style", "style");
    expect(spies.style).toHaveBeenCalledOnce();
    expect(spies.ui).not.toHaveBeenCalled();
    sync.stop();
  });
  it("retains pending local intent and adopts its eventual authoritative merge", () => {
    const sync = startWindowPreferenceSync();
    sync.activate();
    spies.accept.mockReturnValue(false);
    event({ key: "volli:ui", value: "peer" });
    expect(spies.ui).not.toHaveBeenCalled();
    spies.accepted?.("volli:ui");
    expect(spies.ui).toHaveBeenCalledOnce();
    sync.stop();
  });
});

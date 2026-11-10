import { deserialize, serialize } from "node:v8";
import { expect, it, vi } from "vite-plus/test";
import type { Api } from "../../preload";

const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  contextBridge: {},
  webUtils: {},
  ipcRenderer: {
    on(channel: string, listener: (event: unknown, payload: unknown) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(listener);
    },
    removeListener(channel: string, listener: (event: unknown, payload: unknown) => void) {
      listeners.get(channel)?.delete(listener);
    },
  },
}));

it("preload's accepted-change subscription is payload-free and releases only its listener", async () => {
  vi.stubGlobal("window", {});
  try {
    await import("../../preload");
    const api = (window as unknown as { api: Api }).api;
    const changed = vi.fn();
    const other = vi.fn();
    const release = api.modelAccess.onChanged(changed);
    const releaseOther = api.modelAccess.onChanged(other);
    const deliver = () => {
      for (const listener of listeners.get("volli:model-access-changed") ?? []) {
        listener({ sender: "never crosses preload" }, deserialize(serialize(undefined)));
      }
    };
    deliver();
    expect(changed).toHaveBeenCalledExactlyOnceWith();
    release();
    deliver();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    releaseOther();
    expect(listeners.get("volli:model-access-changed")?.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

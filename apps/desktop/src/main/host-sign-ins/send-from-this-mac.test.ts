// @vitest-environment node
/**
 * "Send from this Mac" against a fake credential store: no real `auth.json`
 * is ever read, and no keychain is asked.
 */
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

// Main-test cleanup imports broadcast; never load a real Electron binary.
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  createNativeSendConfirmation,
  macKeyAvailability,
  sendApiKeyFromThisMac,
  type MacCredentialReader,
  type MacStoredCredential,
} from "./send-from-this-mac";

const approved = {
  confirm: async () => ({ isCurrent: () => true, dispose: vi.fn() }),
  isCurrent: () => true,
};

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
      ...approved,
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
      sendApiKeyFromThisMac({
        providerId,
        confirmed: true,
        ...approved,
        store: store(),
        setApiKey,
      });
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
        ...approved,
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
      ...approved,
      store: store(),
      setApiKey: async () => {
        throw new Error(`refused ${KEY}`);
      },
    });
    expect(sent).toEqual({ ok: false, reason: "send-failed" });
  });
});

function fakeWindow() {
  const window = new EventEmitter();
  const webContents = new EventEmitter();
  return Object.assign(window, {
    isDestroyed: vi.fn(() => false),
    webContents: Object.assign(webContents, { isDestroyed: vi.fn(() => false) }),
  });
}
const labels = { providerLabel: "OpenRouter", hostName: "Build box", hostTarget: "me@box" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("main's native Send confirmation", () => {
  it("parents the dialog to the window, uses local names/target, and defaults to Cancel", async () => {
    const window = fakeWindow();
    const showMessageBox = vi.fn(async () => ({ response: 0 }));
    const confirm = createNativeSendConfirmation({
      getWindow: () => window as unknown as BrowserWindow,
      showMessageBox,
    });
    const approval = await confirm(labels);
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(window, {
      type: "warning",
      message: "Send your OpenRouter key to Build box?",
      detail: "me@box\nBuild box keeps a copy of what this Mac sends.",
      buttons: ["Send", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    expect(approval).not.toBeNull();
    expect(approval).not.toBe("cancelled");
    if (typeof approval === "object" && approval !== null) {
      expect(approval.isCurrent()).toBe(true);
      approval.dispose();
    }
    expect(window.listenerCount("closed")).toBe(0);
    expect(window.webContents.eventNames()).toEqual([]);
  });

  it.each(["missing", "destroyed", "contents-destroyed"])(
    "fails closed for a %s window",
    async (state) => {
      const window = fakeWindow();
      window.isDestroyed.mockReturnValue(state === "destroyed");
      window.webContents.isDestroyed.mockReturnValue(state === "contents-destroyed");
      const showMessageBox = vi.fn();
      const confirm = createNativeSendConfirmation({
        getWindow: () => (state === "missing" ? null : (window as unknown as BrowserWindow)),
        showMessageBox,
      });
      expect(await confirm(labels)).toBeNull();
      expect(showMessageBox).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, -1, undefined, "failure"])(
    "never treats response %s as Send",
    async (response) => {
      const window = fakeWindow();
      const confirm = createNativeSendConfirmation({
        getWindow: () => window as unknown as BrowserWindow,
        showMessageBox: async () => {
          if (response === "failure") throw new Error(KEY);
          return { response: response as number };
        },
      });
      expect(await confirm(labels)).toBe(response === 1 ? "cancelled" : null);
      expect(window.eventNames()).toEqual([]);
      expect(window.webContents.eventNames()).toEqual([]);
    },
  );

  it.each(["closed", "navigation", "crashed", "replaced", "destroyed", "contents-destroyed"])(
    "invalidates an approval when the window is %s while the dialog waits",
    async (event) => {
      const window = fakeWindow();
      let current: BrowserWindow | null = window as unknown as BrowserWindow;
      const answer = deferred<{ response: number }>();
      const confirm = createNativeSendConfirmation({
        getWindow: () => current,
        showMessageBox: () => answer.promise,
      });
      const pending = confirm(labels);
      if (event === "closed") window.emit("closed");
      if (event === "navigation") window.webContents.emit("did-start-navigation");
      if (event === "crashed") window.webContents.emit("render-process-gone");
      if (event === "replaced") current = null;
      if (event === "destroyed") window.isDestroyed.mockReturnValue(true);
      if (event === "contents-destroyed") window.webContents.isDestroyed.mockReturnValue(true);
      answer.resolve({ response: 0 });
      expect(await pending).toBeNull();
      expect(window.eventNames()).toEqual([]);
      expect(window.webContents.eventNames()).toEqual([]);
    },
  );
});

describe("native approval fences the key read and send", () => {
  it.each(["absent", "cancelled", "failed", "stale-window", "stale-link"])(
    "reads nothing for %s native confirmation, even with renderer confirmed true",
    async (state) => {
      const credentials = store();
      const dispose = vi.fn();
      const setApiKey = vi.fn();
      const sent = await sendApiKeyFromThisMac({
        providerId: "openrouter",
        confirmed: true,
        store: credentials,
        setApiKey,
        isCurrent: () => state !== "stale-link",
        confirm:
          state === "absent"
            ? (undefined as unknown as typeof approved.confirm)
            : async () => {
                if (state === "failed") throw new Error(KEY);
                if (state === "cancelled") return "cancelled";
                return { isCurrent: () => state !== "stale-window", dispose };
              },
      });
      expect(sent).toEqual({
        ok: false,
        reason: state === "cancelled" ? "cancelled" : "send-failed",
      });
      expect(credentials.reads).toEqual([]);
      expect(setApiKey).not.toHaveBeenCalled();
      if (state === "stale-window" || state === "stale-link")
        expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("does not read a key while the native dialog is pending", async () => {
    const credentials = store();
    const dialog = deferred<null>();
    const pending = sendApiKeyFromThisMac({
      providerId: "openrouter",
      confirmed: true,
      store: credentials,
      setApiKey: vi.fn(),
      ...approved,
      confirm: () => dialog.promise,
    });
    expect(credentials.reads).toEqual([]);
    dialog.resolve(null);
    expect(await pending).toEqual({ ok: false, reason: "send-failed" });
  });

  it.each(["window", "link"])(
    "does not send when the %s changes during the key read",
    async (changed) => {
      const credential = deferred<MacStoredCredential>();
      const dispose = vi.fn();
      let valid = true;
      const setApiKey = vi.fn();
      const read = vi.fn(() => credential.promise);
      const pending = sendApiKeyFromThisMac({
        providerId: "openrouter",
        confirmed: true,
        store: { read },
        setApiKey,
        confirm: async () => ({ isCurrent: () => changed !== "window" || valid, dispose }),
        isCurrent: () => changed !== "link" || valid,
      });
      await Promise.resolve();
      expect(read).toHaveBeenCalledOnce();
      valid = false;
      credential.resolve({ type: "api_key", key: KEY });
      expect(await pending).toEqual({ ok: false, reason: "send-failed" });
      expect(setApiKey).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("sanitizes credential-store errors and releases native approval", async () => {
    const dispose = vi.fn();
    const setApiKey = vi.fn();
    expect(
      await sendApiKeyFromThisMac({
        providerId: "openrouter",
        confirmed: true,
        ...approved,
        confirm: async () => ({ isCurrent: () => true, dispose }),
        store: {
          read: async () => {
            throw new Error(KEY);
          },
        },
        setApiKey,
      }),
    ).toEqual({ ok: false, reason: "send-failed" });
    expect(setApiKey).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("native window ownership lasts through the credential read", () => {
  it.each(["closed", "did-start-navigation", "render-process-gone"])(
    "never sends after %s during the key read",
    async (event) => {
      const window = fakeWindow();
      const credential = deferred<MacStoredCredential>();
      const started = deferred<void>();
      const setApiKey = vi.fn();
      const confirm = createNativeSendConfirmation({
        getWindow: () => window as unknown as BrowserWindow,
        showMessageBox: async () => ({ response: 0 }),
      });
      const pending = sendApiKeyFromThisMac({
        providerId: "openrouter",
        confirmed: true,
        isCurrent: () => true,
        confirm: () => confirm(labels),
        setApiKey,
        store: {
          read: () => {
            started.resolve();
            return credential.promise;
          },
        },
      });
      await started.promise;
      if (event === "closed") window.emit(event);
      else window.webContents.emit(event);
      credential.resolve({ type: "api_key", key: KEY });
      expect(await pending).toEqual({ ok: false, reason: "send-failed" });
      expect(setApiKey).not.toHaveBeenCalled();
      expect(window.eventNames()).toEqual([]);
      expect(window.webContents.eventNames()).toEqual([]);
    },
  );
});

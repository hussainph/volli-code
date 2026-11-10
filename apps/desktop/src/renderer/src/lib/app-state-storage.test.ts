import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CHAT_DRAFTS_APP_STATE_KEY } from "@volli/shared";
import { toast } from "sonner";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { mergePreferenceSnapshot } from "../../../preference-patch";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// A fresh module instance per test file run gets a fresh `cache` Map — reset
// it explicitly between tests instead, since the module is only imported once.
import {
  appStateStorage,
  acceptAppStateValue,
  onPreferenceValueAccepted,
  flushAllPendingAppState,
  flushPendingAppState,
  flushPendingAppStateKey,
  installAppStateFlushResponder,
  seedAppStateCache,
} from "./app-state-storage";
import {
  createClientStateFlush,
  MENU_BAR_FLUSH_OVERDUE_MS,
} from "../../../main/client-state-flush";

const setMock =
  vi.fn<
    (
      key: string,
      value: string,
      baseValue?: string,
    ) => Promise<{ ok: boolean; error?: string; value?: string }>
  >();

// setItem/removeItem debounce the write-through (~200ms) before touching the
// bridge, so tests run on fake timers and advance past the debounce window to
// observe the write; `advanceTimersByTimeAsync` also flushes the fire-and-forget
// `.then/.catch` microtasks the write's result runs through.
const DEBOUNCE_MS = 200;
const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
const TEST_KEYS = [
  "volli:ui",
  "volli:style",
  "volli:workspace",
  "volli:projects-ui",
  "volli:chat-drafts",
];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { api: { appState: { set: setMock } } });
  // Clear anything a previous test seeded/wrote into the shared module-level
  // cache, then drain the debounced writes that cleanup just scheduled (flush
  // empties the pending map so none linger into the test) and reset their mock
  // calls, so each test starts from a clean slate.
  for (const key of TEST_KEYS) {
    appStateStorage.removeItem(key);
  }
  flushPendingAppState();
  await Promise.all(TEST_KEYS.map((key) => flushPendingAppStateKey(key)));
  vi.clearAllTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("seedAppStateCache", () => {
  it("fills the cache so getItem reads it back synchronously", () => {
    seedAppStateCache({ "volli:ui": '{"a":1}', "volli:workspace": '{"b":2}' });

    expect(appStateStorage.getItem("volli:ui")).toBe('{"a":1}');
    expect(appStateStorage.getItem("volli:workspace")).toBe('{"b":2}');
  });

  it("leaves unseeded keys reading null", () => {
    expect(appStateStorage.getItem("volli:projects-ui")).toBeNull();
  });
});

describe("main-window draft ownership", () => {
  it("makes Settings draft reads, writes, and removals no-ops without changing authoritative cached drafts", async () => {
    const authoritative = '{"drafts":{"session":{"text":"keep this draft"}}}';
    seedAppStateCache({ [CHAT_DRAFTS_APP_STATE_KEY]: authoritative });
    const location = { hash: "#settings" };
    vi.stubGlobal("window", { location, api: { appState: { set: setMock } } });

    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBeNull();
    appStateStorage.setItem(CHAT_DRAFTS_APP_STATE_KEY, '{"drafts":{}}');
    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBeNull();
    appStateStorage.removeItem(CHAT_DRAFTS_APP_STATE_KEY);
    await expect(flushAllPendingAppState()).resolves.toBe(true);
    await settle();
    expect(setMock).not.toHaveBeenCalled();

    location.hash = "";
    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBe(authoritative);
  });

  it("keeps main-window draft reads, writes, and removals durable", async () => {
    vi.stubGlobal("window", {
      location: { hash: "" },
      api: { appState: { set: setMock } },
    });
    const draft = '{"drafts":{"session":{"text":"new draft"}}}';
    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBeNull();
    appStateStorage.setItem(CHAT_DRAFTS_APP_STATE_KEY, draft);
    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBe(draft);
    await expect(flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY)).resolves.toBe(true);
    expect(setMock).toHaveBeenNthCalledWith(1, CHAT_DRAFTS_APP_STATE_KEY, draft);

    appStateStorage.removeItem(CHAT_DRAFTS_APP_STATE_KEY);
    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBeNull();
    await expect(flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY)).resolves.toBe(true);
    expect(setMock).toHaveBeenNthCalledWith(2, CHAT_DRAFTS_APP_STATE_KEY, "");
    expect(setMock).toHaveBeenCalledTimes(2);
  });

  it("keeps non-draft preferences writable in Settings", async () => {
    vi.stubGlobal("window", {
      location: { hash: "#settings" },
      api: { appState: { set: setMock } },
    });
    appStateStorage.setItem("volli:ui", '{"sidebarWidth":420}');
    expect(appStateStorage.getItem("volli:ui")).toBe('{"sidebarWidth":420}');
    await expect(flushPendingAppStateKey("volli:ui")).resolves.toBe(true);
    expect(setMock).toHaveBeenCalledExactlyOnceWith("volli:ui", '{"sidebarWidth":420}');
  });

  it("can read cached drafts without a browser window", () => {
    const draft = '{"drafts":{"session":{"text":"cached draft"}}}';
    seedAppStateCache({ [CHAT_DRAFTS_APP_STATE_KEY]: draft });
    vi.stubGlobal("window", undefined);
    expect(appStateStorage.getItem(CHAT_DRAFTS_APP_STATE_KEY)).toBe(draft);
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe("setItem", () => {
  it("updates the cache synchronously and writes through to the bridge after the debounce", async () => {
    appStateStorage.setItem("volli:ui", '{"sidebarWidth":420}');

    // Cache is updated synchronously (read-after-write stays correct)...
    expect(appStateStorage.getItem("volli:ui")).toBe('{"sidebarWidth":420}');
    // ...but the bridge write only fires once the debounce window elapses.
    expect(setMock).not.toHaveBeenCalled();
    await settle();
    expect(setMock).toHaveBeenCalledWith("volli:ui", '{"sidebarWidth":420}');
  });

  it("collapses a burst of writes to the same key into a single trailing write", async () => {
    appStateStorage.setItem("volli:ui", '{"sidebarWidth":300}');
    appStateStorage.setItem("volli:ui", '{"sidebarWidth":301}');
    appStateStorage.setItem("volli:ui", '{"sidebarWidth":302}');
    await settle();

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith("volli:ui", '{"sidebarWidth":302}');
  });

  it("returns false and toasts on a typed write failure", async () => {
    setMock.mockResolvedValue({ ok: false, error: "disk full" });

    appStateStorage.setItem("volli:ui", "{}");
    await expect(flushPendingAppStateKey("volli:ui")).resolves.toBe(false);

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(`Couldn't save "volli:ui": disk full`, {
      duration: 8000,
      closeButton: true,
    });
  });

  it("returns false and toasts when the bridge call rejects outright", async () => {
    setMock.mockRejectedValue(new Error("ipc gone"));

    appStateStorage.setItem("volli:ui", "{}");
    await expect(flushPendingAppStateKey("volli:ui")).resolves.toBe(false);

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(`Couldn't save "volli:ui": ipc gone`, {
      duration: 8000,
      closeButton: true,
    });
  });
});

describe("flushPendingAppState", () => {
  it("ignores a queued debounce callback after an explicit flush consumed its write", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    appStateStorage.setItem("volli:workspace", "latest");
    const callback = timers.mock.calls.at(-1)![0] as () => void;
    await expect(flushPendingAppStateKey("volli:workspace")).resolves.toBe(true);
    // A callback already handed to the task queue can outlive timer cancellation.
    callback();
    await settle();
    expect(setMock).toHaveBeenCalledExactlyOnceWith("volli:workspace", "latest");
    timers.mockRestore();
  });

  it("writes all pending values immediately (before the debounce) and doesn't re-fire them later", async () => {
    appStateStorage.setItem("volli:ui", '{"a":1}');
    appStateStorage.setItem("volli:workspace", '{"b":2}');
    expect(setMock).not.toHaveBeenCalled(); // still inside the debounce window

    flushPendingAppState();

    expect(setMock).toHaveBeenCalledWith("volli:ui", '{"a":1}');
    expect(setMock).toHaveBeenCalledWith("volli:workspace", '{"b":2}');
    // Advancing past the debounce must NOT re-send the already-flushed writes.
    await settle();
    expect(setMock).toHaveBeenCalledTimes(2);
  });
});

describe("flushPendingAppStateKey", () => {
  it("does not claim durability when the key has no scheduled write", async () => {
    await expect(flushPendingAppStateKey("volli:not-scheduled")).resolves.toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("remembers a completed acknowledgement for the unchanged current value", async () => {
    appStateStorage.setItem("volli:chat-drafts", '{"held":["q1"]}');
    await settle();
    expect(setMock).toHaveBeenCalledOnce();
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(true);
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(true);
    expect(setMock).toHaveBeenCalledOnce();
  });

  it("never reuses an old acknowledgement for newer intent, even identical bytes that fail", async () => {
    appStateStorage.setItem("volli:chat-drafts", '{"held":["q1"]}');
    await settle();
    setMock.mockResolvedValue({ ok: false, error: "disk full" });
    appStateStorage.setItem("volli:chat-drafts", '{"held":["q1"]}');
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(false);
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(false);
  });

  it("a seeded cache value is not a bridge acknowledgement", async () => {
    appStateStorage.setItem("volli:chat-drafts", '{"held":["q1"]}');
    await settle();
    seedAppStateCache({ "volli:chat-drafts": '{"held":["q1"]}' });
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(false);
  });

  it("remembers an acknowledged removal, but not a failed removal", async () => {
    appStateStorage.removeItem("volli:chat-drafts");
    await settle();
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(true);
    setMock.mockResolvedValue({ ok: false, error: "locked" });
    appStateStorage.removeItem("volli:chat-drafts");
    await settle();
    await expect(flushPendingAppStateKey("volli:chat-drafts")).resolves.toBe(false);
  });

  it("acknowledges the latest value only after main has durably accepted it", async () => {
    let acknowledge!: (result: { ok: true }) => void;
    setMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    appStateStorage.setItem("volli:chat-drafts", '{"held":["q1"]}');

    const durable = flushPendingAppStateKey("volli:chat-drafts");
    let settled = false;
    void durable.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(setMock).toHaveBeenCalledTimes(1));

    expect(setMock).toHaveBeenCalledWith("volli:chat-drafts", '{"held":["q1"]}');
    expect(settled).toBe(false);
    acknowledge({ ok: true });
    await expect(durable).resolves.toBe(true);
  });
});

describe("removeItem", () => {
  it("clears the cache synchronously and persists an empty value after the debounce", async () => {
    seedAppStateCache({ "volli:ui": "stale" });

    appStateStorage.removeItem("volli:ui");

    expect(appStateStorage.getItem("volli:ui")).toBeNull();
    await settle();
    expect(setMock).toHaveBeenCalledWith("volli:ui", "");
  });

  it("toasts on a typed clear failure", async () => {
    setMock.mockResolvedValue({ ok: false, error: "locked" });

    appStateStorage.removeItem("volli:ui");
    await settle();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(`Couldn't clear "volli:ui": locked`, {
      duration: 8000,
      closeButton: true,
    });
  });
});

// BrowserWindow.destroy() contract (Electron 44 electron.d.ts:2764): no
// beforeunload/unload is emitted, and the renderer/timers go away. Menu-bar
// entry (VC-577) therefore asks the renderer to flush first and waits for the
// ack; this models main's request and then the destruction itself.
describe("VC577 forced-destroy draft durability", () => {
  it("menu-bar entry sends the last chat draft, acknowledged, before destroying its renderer", async () => {
    let requestFlush!: () => Promise<unknown>;
    const unsubscribe = vi.fn();
    installAppStateFlushResponder({
      onFlushRequest: (flush) => {
        requestFlush = flush;
        return unsubscribe;
      },
    });
    let acknowledge!: (result: { ok: true }) => void;
    setMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    appStateStorage.setItem("volli:chat-drafts", '{"drafts":{"session":{"text":"last words"}}}');
    expect(appStateStorage.getItem("volli:chat-drafts")).toContain("last words");
    // Main asks (menu-bar entry), inside the 200ms debounce.
    const flushed = requestFlush();
    let acked = false;
    void flushed.then(() => {
      acked = true;
    });
    await vi.waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "volli:chat-drafts",
        expect.stringContaining("last words"),
      ),
    );
    // No ack until main has durably accepted the write: main keeps waiting.
    expect(acked).toBe(false);
    acknowledge({ ok: true });
    await expect(flushed).resolves.toBe(true);
    // Only now does main destroy the window: timers die, nothing re-sends.
    vi.clearAllTimers();
    await settle();
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      "volli:chat-drafts",
      expect.stringContaining("last words"),
    );
  });

  it("acks with false when a write failed, and with true when nothing was pending", async () => {
    await expect(flushAllPendingAppState()).resolves.toBe(true);
    setMock.mockResolvedValue({ ok: false, error: "disk full" });
    appStateStorage.setItem("volli:ui", "{}");
    await expect(flushAllPendingAppState()).resolves.toBe(false);
  });

  it("installs no responder without a bridge", () => {
    expect(() => installAppStateFlushResponder(undefined)).not.toThrow();
    expect(() => installAppStateFlushResponder({})).not.toThrow();
  });

  it("waits out an older write's slow ack and sends the newest draft before its window is destroyed", async () => {
    // VC-577's slow-write probe: the real renderer storage and
    // the real main-side barrier, with index.ts's rule that a menu-bar window
    // is destroyed only from its own ack, never at a timeout.
    let finishOlder!: (value: { ok: true }) => void;
    setMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOlder = resolve;
        }),
    );
    appStateStorage.setItem("volli:chat-drafts", '{"text":"older"}');
    // The previous write has crossed IPC, but its acknowledgement is delayed.
    const older = flushPendingAppStateKey("volli:chat-drafts");
    appStateStorage.setItem("volli:chat-drafts", '{"text":"latest"}');
    const log = vi.fn();
    const flusher = createClientStateFlush({ newRequestId: () => "menu-entry", log });
    let destroyed = false;
    let sentAtDestroy = false;
    const overdue = flusher.flush(
      [
        {
          isDestroyed: () => destroyed,
          requestFlush: (id) => {
            void flushAllPendingAppState().then(() => flusher.acknowledge(id));
          },
          onAcked: () => {
            sentAtDestroy = setMock.mock.calls.some(([, value]) => value.includes("latest"));
            destroyed = true;
          },
        },
      ],
      MENU_BAR_FLUSH_OVERDUE_MS,
    );
    // Well past the old 1s bound, and past the overdue mark: logged, kept.
    await vi.advanceTimersByTimeAsync(MENU_BAR_FLUSH_OVERDUE_MS);
    await expect(overdue).resolves.toEqual({ acked: 0, unanswered: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("had not confirmed"));
    expect(destroyed).toBe(false);
    // The older ack lands; the latest value goes out behind it, then the ack.
    finishOlder({ ok: true });
    await older;
    await vi.waitFor(() => expect(destroyed).toBe(true));
    expect(sentAtDestroy).toBe(true);
    expect(setMock).toHaveBeenLastCalledWith("volli:chat-drafts", '{"text":"latest"}');
  });

  it("also answers for a write scheduled while it was waiting", async () => {
    let finishFirst!: (value: { ok: true }) => void;
    setMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    appStateStorage.setItem("volli:ui", '{"a":1}');
    const flushed = flushAllPendingAppState();
    appStateStorage.setItem("volli:workspace", '{"b":2}');
    finishFirst({ ok: true });
    await expect(flushed).resolves.toBe(true);
    expect(setMock).toHaveBeenCalledWith("volli:workspace", '{"b":2}');
  });
});

it("boot ignores empty rows and does not turn seeded values into acknowledgements", async () => {
  seedAppStateCache({ "volli:ui": "" });
  expect(appStateStorage.getItem("volli:ui")).toBeNull();
  await expect(flushPendingAppStateKey("volli:not-scheduled")).resolves.toBe(false);
});

it("the storage adapter's flush sends pending intent immediately", async () => {
  appStateStorage.setItem("volli:ui", '{"sidebarWidth":400}');
  appStateStorage.flush?.("volli:ui");
  await expect(flushPendingAppStateKey("volli:ui")).resolves.toBe(true);
  expect(setMock).toHaveBeenCalledOnce();
});

it("a browser module owns its unload flush and main's acknowledged flush responder", async () => {
  vi.resetModules();
  const addEventListener = vi.fn();
  const onFlushRequest = vi.fn();
  vi.stubGlobal("window", {
    addEventListener,
    api: { appState: { set: setMock, onFlushRequest } },
  });
  const browser = await import("./app-state-storage");
  expect(addEventListener).toHaveBeenCalledWith("beforeunload", browser.flushPendingAppState);
  expect(onFlushRequest).toHaveBeenCalledWith(browser.flushAllPendingAppState);
});

describe("shared preference defaults before the first row exists", () => {
  const defaults = { sidebarWidth: 300, costVisible: true };
  const base = JSON.stringify({ state: defaults, version: 1 });
  let windowModule = 0;

  async function freshWindow() {
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      api: { appState: { set: setMock } },
    });
    // Each renderer owns a module instance. Distinct module URLs preserve that
    // isolation without resetting unrelated modules.
    const path = `./app-state-storage?preference-window=${++windowModule}`;
    const storage: typeof import("./app-state-storage") = await import(/* @vite-ignore */ path);
    const store = createStore(
      persist(() => ({ ...defaults, transient: false }), {
        name: "volli:ui",
        version: 1,
        storage: createJSONStorage(() => storage.appStateStorage),
        skipHydration: true,
        partialize: ({ sidebarWidth, costVisible }) => ({ sidebarWidth, costVisible }),
      }),
    );
    storage.registerSharedPreferenceDefaults(store);
    await store.persist.rehydrate();
    return { storage, store };
  }

  it("records the actual partialized defaults without creating a row for transient navigation", async () => {
    const { storage, store } = await freshWindow();
    expect(storage.appStateStorage.getItem("volli:ui")).toBeNull();
    store.setState({ transient: true });
    await settle();
    expect(setMock).not.toHaveBeenCalled();
    expect(storage.appStateStorage.getItem("volli:ui")).toBe(base);
  });

  it.each([false, true])(
    "retains independent first edits from two absent-row writers (Settings first: %s)",
    async (settingsFirst) => {
      const main = await freshWindow();
      const settings = await freshWindow();
      let stored: string | undefined;
      setMock.mockImplementation(async (_key, value, baseline) => {
        stored = mergePreferenceSnapshot(stored, baseline, value);
        return { ok: true, value: stored };
      });
      main.store.setState({ sidebarWidth: 420 });
      settings.store.setState({ costVisible: false });
      const [first, second] = settingsFirst ? [settings, main] : [main, settings];
      await first.storage.flushPendingAppStateKey("volli:ui");
      await second.storage.flushPendingAppStateKey("volli:ui");
      expect(setMock).toHaveBeenCalledTimes(2);
      expect(setMock.mock.calls.every(([, , baseline]) => baseline === base)).toBe(true);
      expect(JSON.parse(stored!)).toEqual({
        state: { sidebarWidth: 420, costVisible: false },
        version: 1,
      });
      expect(second.storage.appStateStorage.getItem("volli:ui")).toBe(stored);
    },
  );

  it("does not acknowledge a refused first write that used the default baseline", async () => {
    const { storage, store } = await freshWindow();
    setMock.mockResolvedValue({ ok: false, error: "database locked" });
    store.setState({ sidebarWidth: 420 });
    await expect(storage.flushPendingAppStateKey("volli:ui")).resolves.toBe(false);
    await expect(storage.flushPendingAppStateKey("volli:ui")).resolves.toBe(false);
    expect(setMock).toHaveBeenCalledExactlyOnceWith(
      "volli:ui",
      JSON.stringify({ state: { ...defaults, sidebarWidth: 420 }, version: 1 }),
      base,
    );
    expect(store.getState().sidebarWidth).toBe(420);
    expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(
      `Couldn't save "volli:ui": database locked`,
      { duration: 8000, closeButton: true },
    );
  });

  it("never replaces an accepted boot/peer snapshot with the registered defaults", async () => {
    const { storage, store } = await freshWindow();
    const accepted = JSON.stringify({ state: { ...defaults, costVisible: false }, version: 1 });
    storage.seedAppStateCache({ "volli:ui": accepted });
    storage.registerSharedPreferenceDefaults(store);
    await store.persist.rehydrate();
    store.setState({ sidebarWidth: 420 });
    await storage.flushPendingAppStateKey("volli:ui");
    expect(setMock).toHaveBeenCalledExactlyOnceWith(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 420, costVisible: false }, version: 1 }),
      accepted,
    );
  });

  it("supports an unversioned store without partialize", async () => {
    const { storage } = await freshWindow();
    storage.registerSharedPreferenceDefaults({
      getInitialState: () => ({ motion: true }),
      persist: { getOptions: () => ({ name: "volli:style" }) },
    });
    const value = JSON.stringify({ state: { motion: false }, version: 0 });
    storage.appStateStorage.setItem("volli:style", value);
    await storage.flushPendingAppStateKey("volli:style");
    expect(setMock).toHaveBeenCalledExactlyOnceWith(
      "volli:style",
      value,
      JSON.stringify({ state: { motion: true }, version: 0 }),
    );
  });

  it("rejects defaults for non-preference stores instead of changing draft semantics", async () => {
    const { storage } = await freshWindow();
    for (const name of [undefined, "volli:chat-drafts"]) {
      expect(() =>
        storage.registerSharedPreferenceDefaults({
          getInitialState: () => ({}),
          persist: { getOptions: () => ({ name }) },
        }),
      ).toThrow("Only shared presentation stores may register preference defaults.");
    }
  });
});

describe("shared preferences in separate windows", () => {
  const base = '{"state":{"sidebarWidth":300,"costVisible":true}}';
  const local = '{"state":{"sidebarWidth":300,"costVisible":false}}';
  const accepted = '{"state":{"sidebarWidth":420,"costVisible":false}}';
  it("does not write an unchanged boot preference just for transient navigation", async () => {
    seedAppStateCache({ "volli:ui": base });
    appStateStorage.setItem("volli:ui", base);
    await settle();
    expect(setMock).not.toHaveBeenCalled();
  });
  it("sends its original baseline and adopts independent changes accepted by main", async () => {
    seedAppStateCache({ "volli:ui": base });
    setMock.mockResolvedValue({ ok: true, value: accepted });
    const changed = vi.fn();
    const stop = onPreferenceValueAccepted(changed);
    appStateStorage.setItem("volli:ui", local);
    await settle();
    expect(setMock).toHaveBeenCalledExactlyOnceWith("volli:ui", local, base);
    expect(appStateStorage.getItem("volli:ui")).toBe(accepted);
    expect(changed).toHaveBeenCalledWith("volli:ui");
    stop();
  });
  it("retains a newer local edit while an earlier snapshot's merge is acknowledged", async () => {
    seedAppStateCache({ "volli:ui": base });
    let finish!: (value: { ok: true; value: string }) => void;
    setMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    appStateStorage.setItem("volli:ui", local);
    const older = flushPendingAppStateKey("volli:ui");
    const newest = '{"state":{"sidebarWidth":300,"costVisible":false,"uiScale":1.25}}';
    appStateStorage.setItem("volli:ui", newest);
    finish({ ok: true, value: accepted });
    await older;
    expect(JSON.parse((await appStateStorage.getItem("volli:ui"))!)).toEqual({
      state: { sidebarWidth: 420, costVisible: false, uiScale: 1.25 },
    });
    await flushPendingAppStateKey("volli:ui");
    expect(setMock).toHaveBeenLastCalledWith(
      "volli:ui",
      '{"state":{"sidebarWidth":420,"costVisible":false,"uiScale":1.25}}',
      accepted,
    );
  });
  it.each(
    ["volli:ui", "volli:style"].flatMap((key) =>
      [false, true].flatMap((seeded) => [false, true].map((clear) => ({ key, seeded, clear }))),
    ),
  )(
    "never acknowledges a refused shared write ($key, seeded: $seeded, clear: $clear)",
    async ({ key, seeded, clear }) => {
      const previous = '{"state":{"enabled":true},"version":0}';
      const next = '{"state":{"enabled":false},"version":0}';
      if (seeded) seedAppStateCache({ [key]: previous });
      setMock.mockResolvedValue({ ok: false, error: "read-only database" });
      if (clear) appStateStorage.removeItem(key);
      else appStateStorage.setItem(key, next);
      await expect(flushPendingAppStateKey(key)).resolves.toBe(false);
      await expect(flushPendingAppStateKey(key)).resolves.toBe(false);
      expect(appStateStorage.getItem(key)).toBe(clear ? null : next);
      expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(
        `Couldn't ${clear ? "clear" : "save"} "${key}": read-only database`,
        { duration: 8000, closeButton: true },
      );
    },
  );

  it("keeps repeated clears durable when an older accepted write has no remaining local baseline", async () => {
    seedAppStateCache({ "volli:ui": base });
    let finish!: (value: { ok: true; value: string }) => void;
    setMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    appStateStorage.setItem("volli:ui", local);
    const older = flushPendingAppStateKey("volli:ui");
    appStateStorage.removeItem("volli:ui");
    const firstClear = flushPendingAppStateKey("volli:ui");
    // The first clear already consumed its timer, so this clear starts without
    // either a cached value or an existing pending write to supply a baseline.
    appStateStorage.removeItem("volli:ui");
    expect(appStateStorage.getItem("volli:ui")).toBeNull();
    finish({ ok: true, value: accepted });
    await Promise.all([older, firstClear]);
    await expect(flushPendingAppStateKey("volli:ui")).resolves.toBe(true);
    expect(setMock).toHaveBeenNthCalledWith(1, "volli:ui", local, base);
    expect(setMock).toHaveBeenNthCalledWith(2, "volli:ui", "");
    expect(setMock).toHaveBeenNthCalledWith(3, "volli:ui", "");
    expect(setMock).toHaveBeenCalledTimes(3);
  });

  it("adopts accepted preference removals and non-snapshot appearance values without echoing them", () => {
    seedAppStateCache({ "volli:ui": base, appearance: "dark" });
    expect(acceptAppStateValue("volli:ui", "")).toBe(true);
    expect(appStateStorage.getItem("volli:ui")).toBeNull();
    expect(acceptAppStateValue("appearance", "light")).toBe(true);
    expect(appStateStorage.getItem("appearance")).toBe("light");
    expect(acceptAppStateValue("appearance", "")).toBe(true);
    expect(appStateStorage.getItem("appearance")).toBeNull();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("never replaces local pending intent with an event; the accepted merge reconciles it", async () => {
    seedAppStateCache({ "volli:ui": base });
    appStateStorage.setItem("volli:ui", local);
    expect(acceptAppStateValue("volli:ui", accepted)).toBe(false);
    expect(appStateStorage.getItem("volli:ui")).toBe(local);
    await settle();
    expect(acceptAppStateValue("volli:ui", accepted)).toBe(true);
    expect(appStateStorage.getItem("volli:ui")).toBe(accepted);
  });
});

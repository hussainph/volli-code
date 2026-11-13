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
    // Both clears queued behind the first write leave as one, when it settles.
    expect(setMock).toHaveBeenNthCalledWith(1, "volli:ui", local, base);
    expect(setMock).toHaveBeenNthCalledWith(2, "volli:ui", "");
    expect(setMock).toHaveBeenCalledTimes(2);
    expect(appStateStorage.getItem("volli:ui")).toBeNull();
  });

  it("lets a peer's value replace a refused edit it cannot compare field by field", async () => {
    seedAppStateCache({ "volli:ui": base });
    setMock.mockResolvedValue({ ok: false, error: "database locked" });
    appStateStorage.setItem("volli:ui", "legacy");
    await expect(flushPendingAppStateKey("volli:ui")).resolves.toBe(false);
    expect(acceptAppStateValue("volli:ui", accepted)).toBe(true);
    expect(appStateStorage.getItem("volli:ui")).toBe(accepted);
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

/**
 * Two renderer windows, each its own module instance of the real storage
 * path, writing one shared preference through a fake main that mirrors the
 * `volli:app-state-set` handler: requests wait in an ordered inbox until the
 * test delivers them, main merges against its current row, replies to the
 * sender and broadcasts the accepted row to every other window. Replies
 * reach a renderer before any broadcast main sends after them, as on one
 * Electron IPC pipe, so every step drains microtasks before the next.
 */
const tick = () => vi.advanceTimersByTimeAsync(0);
const snapshot = (state: Record<string, unknown>) => JSON.stringify({ state, version: 1 });

describe("two windows racing one shared preference through main", () => {
  const KEY = "volli:ui";
  type Prefs = Record<string, unknown>;
  interface Request {
    from: RaceWindow;
    value: string;
    base: string | undefined;
    reply(result: { ok: boolean; error?: string; value?: string }): void;
  }
  interface RaceWindow {
    name: string;
    storage: typeof import("./app-state-storage");
    store: ReturnType<typeof createRaceStore>;
    /** The renderer's own view: what its store holds after every repaint. */
    prefs(): Prefs;
    edit(change: Prefs): void;
  }
  let windowModule = 0;
  let inbox: Request[];
  let stored: string;
  /**
   * The window whose code is running: requests carry no sender, so each step
   * names the window it drives (its edit, or the acknowledgement it receives).
   */
  let acting: RaceWindow | undefined;
  async function as(window: RaceWindow, step: () => Promise<unknown>): Promise<void> {
    acting = window;
    try {
      await step();
    } finally {
      acting = undefined;
    }
  }
  let windows: RaceWindow[];

  function createRaceStore(storage: typeof import("./app-state-storage"), defaults: Prefs) {
    return createStore<Prefs>()(
      persist(() => ({ ...defaults }), {
        name: KEY,
        version: 1,
        storage: createJSONStorage(() => storage.appStateStorage),
        skipHydration: true,
      }),
    );
  }

  async function openWindow(name: string, defaults: Prefs): Promise<RaceWindow> {
    vi.stubGlobal("window", { addEventListener: vi.fn(), api: { appState: { set: setMock } } });
    const path = `./app-state-storage?race-window=${++windowModule}`;
    const storage: typeof import("./app-state-storage") = await import(/* @vite-ignore */ path);
    storage.seedAppStateCache({ [KEY]: stored });
    const store = createRaceStore(storage, defaults);
    storage.registerSharedPreferenceDefaults(store);
    await store.persist.rehydrate();
    // window-preferences.ts: an accepted merge repaints its writer.
    storage.onPreferenceValueAccepted(() => void store.persist.rehydrate());
    return {
      name,
      storage,
      store,
      prefs: () => ({ ...store.getState() }),
      edit: (change) => store.setState(change),
    };
  }

  /** window-preferences.ts: a peer broadcast repaints only when storage accepts it. */
  function broadcast(sender: RaceWindow, value: string): void {
    for (const window of windows) {
      if (window !== sender && window.storage.acceptAppStateValue(KEY, value)) {
        void window.store.persist.rehydrate();
      }
    }
  }

  /** Main handles `from`'s oldest outstanding request. */
  async function deliver(from: RaceWindow, outcome: "accept" | "refuse" = "accept") {
    const index = inbox.findIndex((request) => request.from === from);
    if (index === -1) throw new Error(`${from.name} has no request at main.`);
    const [request] = inbox.splice(index, 1);
    if (outcome === "refuse") {
      request.reply({ ok: false, error: "database locked" });
    } else {
      stored = mergePreferenceSnapshot(stored, request.base, request.value);
      request.reply(request.base === undefined ? { ok: true } : { ok: true, value: stored });
      broadcast(from, stored);
    }
    await as(from, tick);
    return request;
  }

  /** A window edits and sends now, the way a quit or a Settings close flushes. */
  async function send(window: RaceWindow, change: Prefs): Promise<void> {
    await as(window, async () => {
      window.edit(change);
      void window.storage.flushPendingAppStateKey(KEY);
      await tick();
    });
  }

  /** A peer edit main accepts at once. */
  async function peer(window: RaceWindow, change: Prefs): Promise<void> {
    await send(window, change);
    await deliver(window);
  }

  const authoritative = () => (JSON.parse(stored) as { state: Prefs }).state;
  async function expectConverged(): Promise<void> {
    await tick();
    expect(inbox).toEqual([]);
    for (const window of windows) {
      expect({ [window.name]: window.prefs() }).toEqual({ [window.name]: authoritative() });
      expect(window.storage.appStateStorage.getItem(KEY)).toBe(stored);
    }
  }

  async function open(initial: Prefs) {
    inbox = [];
    stored = snapshot(initial);
    setMock.mockImplementation(
      (_key, value, base) =>
        new Promise((resolve) => {
          if (acting === undefined) throw new Error("A request left no acting window.");
          inbox.push({ from: acting, value, base, reply: resolve });
        }),
    );
    const a = await openWindow("main window", initial);
    const b = await openWindow("Settings", initial);
    windows = [a, b];
    return { a, b };
  }

  it("never restores a peer value that a queued write learnt from an earlier acknowledgement", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true });
    await send(a, { sidebarWidth: 310 });
    await send(a, { sidebarWidth: 320 });
    await peer(b, { costVisible: false });
    await deliver(a); // ACK1 carries costVisible: false; the queued write leaves.
    expect(a.prefs()).toEqual({ sidebarWidth: 320, costVisible: false });
    await peer(b, { costVisible: true });
    await deliver(a);
    expect(authoritative()).toEqual({ sidebarWidth: 320, costVisible: true });
    await expectConverged();
  });

  it("rebases every write of a longer queue onto the acknowledgement before it", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true, uiScale: 1 });
    await send(a, { sidebarWidth: 310 });
    await send(a, { sidebarWidth: 320 });
    await peer(b, { costVisible: false });
    await deliver(a); // the second write leaves, rebased onto this ack
    await send(a, { sidebarWidth: 330 }); // queued behind the second
    await peer(b, { costVisible: true, uiScale: 1.25 });
    await deliver(a);
    await send(a, { sidebarWidth: 340 }); // queued behind the third
    await peer(b, { costVisible: false });
    await deliver(a);
    await peer(b, { uiScale: 1.5 });
    await deliver(a);
    expect(authoritative()).toEqual({ sidebarWidth: 340, costVisible: false, uiScale: 1.5 });
    await expectConverged();
  });

  it("coalesces writes queued behind one acknowledgement into a single rebased write", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true });
    await send(a, { sidebarWidth: 310 });
    await send(a, { sidebarWidth: 320 });
    await send(a, { sidebarWidth: 330 });
    await peer(b, { costVisible: false });
    await deliver(a);
    await peer(b, { costVisible: true });
    const queued = await deliver(a);
    expect(queued.value).toBe(snapshot({ sidebarWidth: 330, costVisible: false }));
    expect(authoritative()).toEqual({ sidebarWidth: 330, costVisible: true });
    await expectConverged();
  });

  it("keeps a debounced burst to its own edits across acknowledgements", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true });
    await send(a, { sidebarWidth: 310 });
    a.edit({ sidebarWidth: 320 }); // debounced, not yet sent
    await peer(b, { costVisible: false });
    await deliver(a);
    a.edit({ sidebarWidth: 330 }); // same burst, after the repaint
    await peer(b, { costVisible: true });
    await as(a, () => vi.advanceTimersByTimeAsync(DEBOUNCE_MS));
    await deliver(a);
    expect(authoritative()).toEqual({ sidebarWidth: 330, costVisible: true });
    await expectConverged();
  });

  it("does not resurrect a key a peer added and then removed while a write was queued", async () => {
    const { a, b } = await open({ sidebarWidth: 300, collapsed: {} });
    await send(a, { sidebarWidth: 310 });
    await send(a, { sidebarWidth: 320 });
    await peer(b, { collapsed: { notes: true } });
    await deliver(a);
    expect(a.prefs()).toEqual({ sidebarWidth: 320, collapsed: { notes: true } });
    // Removed, not merely absent: the row drops the key.
    await peer(b, { collapsed: {} });
    await deliver(a);
    expect(authoritative()).toEqual({ sidebarWidth: 320, collapsed: {} });
    await expectConverged();
  });

  it("removes a key locally without dropping a peer's concurrent change", async () => {
    const { a, b } = await open({ sidebarWidth: 300, collapsed: { notes: true, board: true } });
    await send(a, { sidebarWidth: 310 });
    await send(a, { collapsed: { board: true } });
    await peer(b, { collapsed: { notes: true, board: true, chat: true } });
    await deliver(a);
    expect(a.prefs()).toEqual({ sidebarWidth: 310, collapsed: { board: true, chat: true } });
    await peer(b, { sidebarWidth: 290 });
    await deliver(a);
    // The queued removal carries only its own change, so b's later width stands.
    expect(authoritative()).toEqual({ sidebarWidth: 290, collapsed: { board: true, chat: true } });
    await expectConverged();
  });

  it.each([
    { later: "main window", expected: 310 },
    { later: "Settings", expected: 420 },
  ])(
    "lets the later accepted write to the same field win ($later)",
    async ({ later, expected }) => {
      const { a, b } = await open({ sidebarWidth: 300, costVisible: true });
      await send(a, { costVisible: false });
      await send(a, { sidebarWidth: 310 });
      await deliver(a);
      if (later === "main window") {
        await peer(b, { sidebarWidth: 420 });
        await deliver(a);
      } else {
        await deliver(a);
        await peer(b, { sidebarWidth: 420 });
      }
      expect(authoritative()).toEqual({ sidebarWidth: expected, costVisible: false });
      await expectConverged();
    },
  );

  it("surfaces a refused write, keeps its edit, and sends it only with the next edit", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true, uiScale: 1 });
    await send(a, { sidebarWidth: 310 });
    await deliver(a, "refuse");
    expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(
      `Couldn't save "${KEY}": database locked`,
      { duration: 8000, closeButton: true },
    );
    expect(a.prefs()).toEqual({ sidebarWidth: 310, costVisible: true, uiScale: 1 });
    // Not acknowledged, and never retried in the background or by a flush.
    await as(a, async () => {
      await expect(a.storage.flushPendingAppStateKey(KEY)).resolves.toBe(false);
      await expect(a.storage.flushAllPendingAppState()).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
    });
    expect(inbox).toEqual([]);
    // A peer's accepted change repaints the window without erasing the edit.
    await peer(b, { costVisible: false });
    expect(a.prefs()).toEqual({ sidebarWidth: 310, costVisible: false, uiScale: 1 });
    await send(a, { uiScale: 1.25 });
    await deliver(a);
    expect(authoritative()).toEqual({ sidebarWidth: 310, costVisible: false, uiScale: 1.25 });
    await expectConverged();
    expect(vi.mocked(toast.error)).toHaveBeenCalledOnce();
  });

  it("lets a peer's later accepted change supersede a refused edit to the same field", async () => {
    const { a, b } = await open({
      sidebarWidth: 300,
      costVisible: true,
      uiScale: 1,
      collapsed: { notes: true, chat: true },
    });
    // Flips notes and removes chat inside the record.
    await send(a, { sidebarWidth: 310, costVisible: false, collapsed: { notes: false } });
    await deliver(a, "refuse");
    await peer(b, { sidebarWidth: 420, collapsed: { notes: true, chat: true, board: true } });
    // The peer's width and new key win; refused edits it left alone stay.
    expect(a.prefs()).toEqual({
      sidebarWidth: 420,
      costVisible: false,
      uiScale: 1,
      collapsed: { notes: false, board: true },
    });
    await send(a, { uiScale: 1.25 });
    await deliver(a);
    expect(authoritative()).toEqual({
      sidebarWidth: 420,
      costVisible: false,
      uiScale: 1.25,
      collapsed: { notes: false, board: true },
    });
    await expectConverged();
  });

  it("drops a refused edit a peer has fully superseded, or cleared", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true });
    await send(a, { sidebarWidth: 310 });
    await deliver(a, "refuse");
    await peer(b, { sidebarWidth: 420 });
    expect(a.prefs()).toEqual({ sidebarWidth: 420, costVisible: true });
    await expect(a.storage.flushPendingAppStateKey(KEY)).resolves.toBe(false);
    await expectConverged();
    await send(a, { costVisible: false });
    await deliver(a, "refuse");
    stored = "";
    broadcast(b, "");
    expect(a.storage.appStateStorage.getItem(KEY)).toBeNull();
  });

  it("carries a refused write into the write already queued behind it", async () => {
    const { a, b } = await open({ sidebarWidth: 300, costVisible: true, uiScale: 1 });
    await send(a, { sidebarWidth: 310 });
    await send(a, { uiScale: 1.25 });
    await peer(b, { costVisible: false });
    await deliver(a, "refuse");
    await deliver(a);
    expect(authoritative()).toEqual({ sidebarWidth: 310, costVisible: false, uiScale: 1.25 });
    await expectConverged();
    expect(vi.mocked(toast.error)).toHaveBeenCalledOnce();
  });
});

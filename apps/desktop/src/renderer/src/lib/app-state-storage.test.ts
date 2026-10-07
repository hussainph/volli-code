import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// A fresh module instance per test file run gets a fresh `cache` Map — reset
// it explicitly between tests instead, since the module is only imported once.
import {
  appStateStorage,
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

const setMock = vi.fn<(key: string, value: string) => Promise<{ ok: boolean; error?: string }>>();

// setItem/removeItem debounce the write-through (~200ms) before touching the
// bridge, so tests run on fake timers and advance past the debounce window to
// observe the write; `advanceTimersByTimeAsync` also flushes the fire-and-forget
// `.then/.catch` microtasks the write's result runs through.
const DEBOUNCE_MS = 200;
const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
const TEST_KEYS = ["volli:ui", "volli:workspace", "volli:projects-ui", "volli:chat-drafts"];

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
    // The VC-577 re-check's slow-write probe: the real renderer storage and
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

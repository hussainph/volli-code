import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// A fresh module instance per test file run gets a fresh `cache` Map — reset
// it explicitly between tests instead, since the module is only imported once.
import { appStateStorage, flushPendingAppState, seedAppStateCache } from "./app-state-storage";

const setMock = vi.fn<(key: string, value: string) => Promise<{ ok: boolean; error?: string }>>();

// setItem/removeItem debounce the write-through (~200ms) before touching the
// bridge, so tests run on fake timers and advance past the debounce window to
// observe the write; `advanceTimersByTimeAsync` also flushes the fire-and-forget
// `.then/.catch` microtasks the write's result runs through.
const DEBOUNCE_MS = 200;
const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { api: { appState: { set: setMock } } });
  // Clear anything a previous test seeded/wrote into the shared module-level
  // cache, then drain the debounced writes that cleanup just scheduled (flush
  // empties the pending map so none linger into the test) and reset their mock
  // calls, so each test starts from a clean slate.
  for (const key of ["volli:ui", "volli:workspace", "volli:projects-ui"]) {
    appStateStorage.removeItem(key);
  }
  flushPendingAppState();
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

  it("toasts on a typed write failure", async () => {
    setMock.mockResolvedValue({ ok: false, error: "disk full" });

    appStateStorage.setItem("volli:ui", "{}");
    await settle();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not save "volli:ui": disk full', {
      duration: 8000,
      closeButton: true,
    });
  });

  it("toasts when the bridge call rejects outright", async () => {
    setMock.mockRejectedValue(new Error("ipc gone"));

    appStateStorage.setItem("volli:ui", "{}");
    await settle();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not save "volli:ui": ipc gone', {
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

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not clear "volli:ui": locked', {
      duration: 8000,
      closeButton: true,
    });
  });
});

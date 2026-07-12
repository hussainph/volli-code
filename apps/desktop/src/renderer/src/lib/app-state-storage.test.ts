import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

// A fresh module instance per test file run gets a fresh `cache` Map — reset
// it explicitly between tests instead, since the module is only imported once.
import { appStateStorage, seedAppStateCache } from "./app-state-storage";

const setMock = vi.fn<(key: string, value: string) => Promise<{ ok: boolean; error?: string }>>();

/** Flush the `.then/.catch` microtask queue on the fire-and-forget write. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  setMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { api: { appState: { set: setMock } } });
  // Clear anything a previous test seeded/wrote into the shared module-level cache.
  for (const key of ["volli:ui", "volli:workspace", "volli:projects-ui"]) {
    appStateStorage.removeItem(key);
  }
  vi.clearAllMocks();
});

afterEach(() => {
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
  it("updates the cache synchronously and writes through to the bridge", async () => {
    appStateStorage.setItem("volli:ui", '{"sidebarWidth":420}');

    expect(appStateStorage.getItem("volli:ui")).toBe('{"sidebarWidth":420}');
    await flush();
    expect(setMock).toHaveBeenCalledWith("volli:ui", '{"sidebarWidth":420}');
  });

  it("toasts on a typed write failure", async () => {
    setMock.mockResolvedValue({ ok: false, error: "disk full" });

    appStateStorage.setItem("volli:ui", "{}");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not save "volli:ui": disk full');
  });

  it("toasts when the bridge call rejects outright", async () => {
    setMock.mockRejectedValue(new Error("ipc gone"));

    appStateStorage.setItem("volli:ui", "{}");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not save "volli:ui": ipc gone');
  });
});

describe("removeItem", () => {
  it("clears the cache synchronously and persists an empty value", async () => {
    seedAppStateCache({ "volli:ui": "stale" });

    appStateStorage.removeItem("volli:ui");

    expect(appStateStorage.getItem("volli:ui")).toBeNull();
    await flush();
    expect(setMock).toHaveBeenCalledWith("volli:ui", "");
  });

  it("toasts on a typed clear failure", async () => {
    setMock.mockResolvedValue({ ok: false, error: "locked" });

    appStateStorage.removeItem("volli:ui");
    await flush();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Could not clear "volli:ui": locked');
  });
});

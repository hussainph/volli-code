// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createProtectionStore,
  useProtectionExperiment,
  useProtectionSetting,
  useProtectionStore,
} from "./protection";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

type Answer = { ok: true; enabled: boolean } | { ok: false; error: string };

function stubProtection(
  get: () => Promise<Answer>,
  set: (enabled: boolean) => Promise<Answer> = (enabled) => Promise.resolve({ ok: true, enabled }),
) {
  const api = { get: vi.fn(get), set: vi.fn(set) };
  vi.stubGlobal("api", { protection: api });
  return api;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  useProtectionStore.setState({ enabled: null });
});

describe("load", () => {
  it("reads the switch once and keeps it", async () => {
    const api = stubProtection(() => Promise.resolve({ ok: true, enabled: true }));
    const store = createProtectionStore();

    await store.getState().load();
    await store.getState().load();

    expect(store.getState().enabled).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("shares one read between callers that collide", async () => {
    let release: ((answer: Answer) => void) | undefined;
    const api = stubProtection(
      () =>
        new Promise<Answer>((resolve) => {
          release = resolve;
        }),
    );
    const store = createProtectionStore();

    const first = store.getState().load();
    const second = store.getState().load();
    release?.({ ok: true, enabled: false });
    await Promise.all([first, second]);

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(store.getState().enabled).toBe(false);
  });

  it("toasts a failed read and leaves the switch unread, so the next caller retries", async () => {
    const api = stubProtection(() => Promise.resolve({ ok: false, error: "db closed" }));
    const store = createProtectionStore();

    await store.getState().load();

    expect(store.getState().enabled).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't read the Protection setting: db closed",
      expect.anything(),
    );

    api.get.mockResolvedValue({ ok: true, enabled: true });
    await store.getState().load();
    expect(store.getState().enabled).toBe(true);
  });

  it("lets a write that lands mid-read win over the older read", async () => {
    let release: ((answer: Answer) => void) | undefined;
    stubProtection(
      () =>
        new Promise<Answer>((resolve) => {
          release = resolve;
        }),
    );
    const store = createProtectionStore();

    const read = store.getState().load();
    await store.getState().setEnabled(true);
    release?.({ ok: true, enabled: false });
    await read;

    expect(store.getState().enabled).toBe(true);
  });
});

describe("setEnabled", () => {
  it("records the value main answered with", async () => {
    const api = stubProtection(
      () => Promise.resolve({ ok: true, enabled: false }),
      () => Promise.resolve({ ok: true, enabled: true }),
    );
    const store = createProtectionStore();

    await expect(store.getState().setEnabled(true)).resolves.toBe(true);

    expect(api.set).toHaveBeenCalledWith(true);
    expect(store.getState().enabled).toBe(true);
  });

  it("toasts a refused write and keeps the value it had", async () => {
    stubProtection(
      () => Promise.resolve({ ok: true, enabled: true }),
      () => Promise.resolve({ ok: false, error: "disk full" }),
    );
    const store = createProtectionStore();
    await store.getState().load();

    await expect(store.getState().setEnabled(false)).resolves.toBe(false);

    expect(store.getState().enabled).toBe(true);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't turn Protection off: disk full",
      expect.anything(),
    );
  });

  it("names the direction a failed switch-on was going", async () => {
    stubProtection(
      () => Promise.resolve({ ok: true, enabled: false }),
      () => Promise.reject(new Error("ipc gone")),
    );
    const store = createProtectionStore();

    await expect(store.getState().setEnabled(true)).resolves.toBe(false);

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't turn Protection on: ipc gone",
      expect.anything(),
    );
  });
});

describe("the hooks", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  const seen: { setting: boolean | null; experiment: boolean }[] = [];

  function Probe() {
    seen.push({ setting: useProtectionSetting(), experiment: useProtectionExperiment() });
    return null;
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    seen.length = 0;
  });

  it("reads the switch on first use and treats an unread switch as off", async () => {
    const api = stubProtection(() => Promise.resolve({ ok: true, enabled: true }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Probe />));

    expect(seen[0]).toEqual({ setting: null, experiment: false });
    expect(seen.at(-1)).toEqual({ setting: true, experiment: true });
    // Two hooks in one component, and the switch is still read once.
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not read again once the switch has landed", async () => {
    const api = stubProtection(() => Promise.resolve({ ok: true, enabled: true }));
    useProtectionStore.setState({ enabled: false });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<Probe />));

    expect(seen.at(-1)).toEqual({ setting: false, experiment: false });
    expect(api.get).not.toHaveBeenCalled();
  });
});

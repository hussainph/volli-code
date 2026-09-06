import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BackgroundShellState, BackgroundShellStateEvent } from "../../../ipc/contract";
import {
  hydrateBackgroundShells,
  subscribeBackgroundShells,
  useBackgroundShellsStore,
  type ShellsApi,
} from "./background-shells";

export function shellState(overrides: Partial<BackgroundShellState> = {}): BackgroundShellState {
  return {
    shellId: "sh-1",
    sessionId: "session-1",
    projectId: "project-1",
    ticketId: null,
    command: "pnpm dev",
    title: null,
    state: "running",
    code: null,
    signal: null,
    startedAt: 1_000,
    exitedAt: null,
    pid: 42,
    ...overrides,
  };
}

function api(overrides: Partial<ShellsApi> = {}): ShellsApi {
  return {
    list: vi.fn(async () => ({ ok: true as const, shells: [] })),
    tail: vi.fn(async () => ({ ok: false as const, error: "unused" })),
    kill: vi.fn(async () => ({ ok: true as const })),
    onShellState: vi.fn(() => () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  useBackgroundShellsStore.setState({ byId: {}, hydrated: false });
});

describe("background shells store", () => {
  it("receives updates, removes shells, and leaves an absent remove quiet", () => {
    const store = useBackgroundShellsStore.getState();
    store.receive(shellState());
    store.receive(shellState({ state: "exited", code: 0, exitedAt: 2_000 }));

    expect(useBackgroundShellsStore.getState().byId["sh-1"]).toMatchObject({
      state: "exited",
      code: 0,
    });
    store.remove("sh-1");
    expect(useBackgroundShellsStore.getState().byId).toEqual({});
    const settled = useBackgroundShellsStore.getState();
    settled.remove("missing");
    expect(useBackgroundShellsStore.getState()).toBe(settled);
  });

  it("reconciles the whole main-owned registry on receiveAll", () => {
    const store = useBackgroundShellsStore.getState();
    store.receive(shellState({ shellId: "stale" }));

    store.receiveAll([shellState({ shellId: "fresh" })]);

    expect(Object.keys(useBackgroundShellsStore.getState().byId)).toEqual(["fresh"]);
    expect(useBackgroundShellsStore.getState().hydrated).toBe(true);
  });

  it("hydrates only a successful main-owned listing", async () => {
    const failing = api({ list: vi.fn(async () => ({ ok: false as const, error: "gone" })) });
    await expect(hydrateBackgroundShells(failing)).resolves.toEqual({ ok: false, error: "gone" });
    expect(useBackgroundShellsStore.getState().hydrated).toBe(false);

    const listing = api({
      list: vi.fn(async () => ({ ok: true as const, shells: [shellState({ shellId: "sh-2" })] })),
    });
    await hydrateBackgroundShells(listing);
    expect(Object.keys(useBackgroundShellsStore.getState().byId)).toEqual(["sh-2"]);
    expect(useBackgroundShellsStore.getState().hydrated).toBe(true);
  });

  it("subscribes to the one push and folds both shapes into the store", () => {
    let push: ((event: BackgroundShellStateEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const subscribed = api({
      onShellState: vi.fn((callback) => {
        push = callback;
        return unsubscribe;
      }),
    });

    const stop = subscribeBackgroundShells(subscribed);
    push!({ shell: shellState() });
    expect(useBackgroundShellsStore.getState().byId["sh-1"]?.state).toBe("running");
    push!({ removedShellId: "sh-1" });
    expect(useBackgroundShellsStore.getState().byId).toEqual({});

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

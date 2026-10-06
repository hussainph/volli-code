import { describe, expect, it, vi } from "vite-plus/test";

import { createHostLiveWork, hasLiveWork, NO_LIVE_WORK } from "./live-work";

function fold(sessionId: string, turnActive: boolean) {
  return { session: { id: sessionId } as never, turnActive };
}

function watch(bound: string[] = []) {
  const open = new Set(bound);
  const onError = vi.fn();
  const live = createHostLiveWork({ openSessionIds: () => open, onError });
  return { live, open, onError };
}

describe("host live work (VC-577)", () => {
  it("starts with nothing running", () => {
    const { live } = watch();
    expect(live.current()).toEqual(NO_LIVE_WORK);
    expect(hasLiveWork(live.current())).toBe(false);
  });

  it("counts an open turn only while its Session holds an executor binding", () => {
    const { live, open } = watch(["a"]);
    live.observeSession(fold("a", true));
    live.observeSession(fold("b", true));
    expect(live.current()).toEqual({ turns: 1, shells: 0 });
    open.add("b");
    expect(live.current()).toEqual({ turns: 2, shells: 0 });
    open.delete("a");
    expect(live.current()).toEqual({ turns: 1, shells: 0 });
  });

  it("drops a turn when its Session folds idle", () => {
    const { live } = watch(["a"]);
    live.observeSession(fold("a", true));
    live.observeSession(fold("a", false));
    expect(live.current()).toEqual(NO_LIVE_WORK);
  });

  it("counts running shells, and forgets exited and removed ones", () => {
    const { live } = watch();
    live.observeShell({ shellId: "s1", state: "running" });
    live.observeShell({ shellId: "s2", state: "running" });
    expect(live.current()).toEqual({ turns: 0, shells: 2 });
    expect(hasLiveWork(live.current())).toBe(true);
    live.observeShell({ shellId: "s1", state: "exited" });
    live.forgetShell("s2");
    expect(live.current()).toEqual(NO_LIVE_WORK);
  });

  it("announces changes only, and stops after unsubscribe", () => {
    const { live } = watch(["a"]);
    const heard = vi.fn();
    const stop = live.subscribe(heard);
    live.observeSession(fold("a", true));
    live.observeSession(fold("a", true));
    live.observeShell({ shellId: "s1", state: "running" });
    expect(heard.mock.calls).toEqual([[{ turns: 1, shells: 0 }], [{ turns: 1, shells: 1 }]]);
    stop();
    live.forgetShell("s1");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("reports a throwing listener and still tells the next one", () => {
    const { live, onError } = watch(["a"]);
    const boom = new Error("listener");
    const second = vi.fn();
    live.subscribe(() => {
      throw boom;
    });
    live.subscribe(second);
    live.observeSession(fold("a", true));
    expect(onError).toHaveBeenCalledWith(boom);
    expect(second).toHaveBeenCalledWith({ turns: 1, shells: 0 });
  });

  it("never throws into the write path when the binding read fails", () => {
    const boom = new Error("bindings");
    const onError = vi.fn();
    const live = createHostLiveWork({
      openSessionIds: () => {
        throw boom;
      },
      onError,
    });
    const heard = vi.fn();
    live.subscribe(heard);
    expect(() => live.observeSession(fold("a", true))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(heard).not.toHaveBeenCalled();
  });

  it("defaults its diagnostics to console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const live = createHostLiveWork({ openSessionIds: () => new Set(["a"]) });
    live.subscribe(() => {
      throw new Error("loud");
    });
    live.observeSession(fold("a", true));
    expect(warn).toHaveBeenCalledWith("[volli] live work:", expect.any(Error));
    warn.mockRestore();
  });
});

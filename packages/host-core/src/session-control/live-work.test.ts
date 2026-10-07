import { describe, expect, it, vi } from "vite-plus/test";
import { captureHostLog } from "../testing/log";

import { createHostLiveWork, hasLiveWork, NO_LIVE_WORK, turnActiveAfter } from "./live-work";

function fold(sessionId: string, turnActive: boolean) {
  return { session: { id: sessionId } as never, turnActive };
}

function watch(bound: string[] = []) {
  const open = new Set(bound);
  const onError = vi.fn();
  const live = createHostLiveWork({ openSessionIds: () => open, onError });
  return { live, open, onError };
}

function fact(sessionId: string, sequence: number, kind: string) {
  return { sessionId, sequence, payload: { kind } as never };
}

function latched(pending: Set<string>, bound: string[] = []) {
  const open = new Set(bound);
  const starts = { hold: vi.fn(), release: vi.fn() };
  const live = createHostLiveWork({
    openSessionIds: () => open,
    pendingStartSessionIds: () => pending,
    starts,
  });
  return { live, starts };
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

  it("defaults its diagnostics to the host log", () => {
    const captured = captureHostLog();
    const live = createHostLiveWork({ openSessionIds: () => new Set(["a"]) });
    live.subscribe(() => {
      throw new Error("loud");
    });
    live.observeSession(fold("a", true));
    expect(captured.of("live-work")).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "live work listener failed",
        error: expect.objectContaining({ message: "loud" }),
      }),
    ]);
    captured.restore();
  });

  describe("committed facts (VC-577)", () => {
    it("follows the projection fold's turnActive rule exactly", () => {
      expect(turnActiveAfter("turn.started")).toBe(true);
      for (const kind of [
        "turn.completed",
        "turn.interrupted",
        "attachment.closed",
        "attachment.failed",
      ] as const) {
        expect(turnActiveAfter(kind)).toBe(false);
      }
      expect(turnActiveAfter("attachment.opened")).toBeNull();
      expect(turnActiveAfter("command.recorded")).toBeNull();
    });

    it("opens and closes a turn on the write itself, and ignores facts that do not move it", () => {
      const { live } = watch(["a"]);
      const heard = vi.fn();
      live.subscribe(heard);
      live.observeEvent(fact("a", 1, "attachment.opened"));
      expect(heard).not.toHaveBeenCalled();
      live.observeEvent(fact("a", 2, "turn.started"));
      expect(live.current()).toEqual({ turns: 1, shells: 0 });
      live.observeEvent(fact("a", 3, "attachment.closed"));
      expect(live.current()).toEqual(NO_LIVE_WORK);
      expect(heard.mock.calls).toEqual([[{ turns: 1, shells: 0 }], [NO_LIVE_WORK]]);
    });

    it("never replays an older fact over a newer one (a deduped observe answers the original)", () => {
      const { live } = watch(["a"]);
      live.observeEvent(fact("a", 2, "turn.started"));
      live.observeEvent(fact("a", 3, "turn.completed"));
      live.observeEvent(fact("a", 2, "turn.started"));
      expect(live.current()).toEqual(NO_LIVE_WORK);
    });

    it("lets a fold seed only a Session no committed fact has reached", () => {
      const { live } = watch(["a", "b"]);
      live.observeEvent(fact("a", 5, "turn.started"));
      // An older idle fold of "a" landing late cannot close a newer start.
      live.observeSession(fold("a", false));
      // "b" has had no fact in this process: its fold is the whole truth.
      live.observeSession(fold("b", true));
      expect(live.current()).toEqual({ turns: 2, shells: 0 });
    });
  });

  describe("accepted starts and the idle-exit latch (VC-577)", () => {
    it("counts a Session whose turn is accepted but not yet open, once", () => {
      const pending = new Set(["a", "b"]);
      const { live } = latched(pending, ["a"]);
      live.observeSession(fold("a", true));
      // "a" both starting and running is one turn, not two.
      expect(live.current()).toEqual({ turns: 2, shells: 0 });
      pending.clear();
      expect(live.current()).toEqual({ turns: 1, shells: 0 });
    });

    it("refuses to latch while anything is live, and latches atomically when nothing is", () => {
      const pending = new Set(["a"]);
      const { live, starts } = latched(pending);
      expect(live.tryBeginIdleExit()).toBe(false);
      expect(live.exiting()).toBe(false);
      expect(starts.hold).not.toHaveBeenCalled();
      pending.clear();
      live.observeShell({ shellId: "s", state: "running" });
      expect(live.tryBeginIdleExit()).toBe(false);
      live.forgetShell("s");
      expect(live.tryBeginIdleExit()).toBe(true);
      expect(live.exiting()).toBe(true);
      expect(starts.hold).toHaveBeenCalledOnce();
      // Already latched: true again, held once.
      expect(live.tryBeginIdleExit()).toBe(true);
      expect(starts.hold).toHaveBeenCalledOnce();
      live.abandonIdleExit();
      live.abandonIdleExit();
      expect(live.exiting()).toBe(false);
      expect(starts.release).toHaveBeenCalledOnce();
    });

    it("latches with no runtime to hold", () => {
      const { live } = watch();
      expect(live.tryBeginIdleExit()).toBe(true);
      live.abandonIdleExit();
      expect(live.exiting()).toBe(false);
    });
  });
});

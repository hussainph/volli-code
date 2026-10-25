import { describe, expect, it, vi } from "vite-plus/test";
import { classifyAppStateKey } from "@volli/shared";

import {
  CLOUD_LAUNCH_APP_STATE_KEY,
  chooseProductStore,
  createRelaunchController,
  decodeLaunchMarker,
  encodeLaunchMarker,
  launchMarkerStore,
  type LaunchMarkerRow,
} from "./cloud-launch";

const USER = "6b4c3a1e-2a9f-4c3e-9d1b-0f8e7d6c5b4a";
const URL = "http://127.0.0.1:3210";

describe("the launch's product store (VC-889)", () => {
  it("is cloud only with the flag on, a marker and a backend", () => {
    const marker = () => ({ userId: USER });
    expect(
      chooseProductStore({
        cloudFlag: true,
        readMarker: marker,
        backendUrl: URL,
        signInConfigured: true,
      }),
    ).toEqual({
      store: "cloud",
      userId: USER,
      backendUrl: URL,
    });
    const table: [boolean, boolean, string | null, boolean][] = [
      [true, false, URL, true],
      [true, true, null, true],
      [true, true, URL, false],
      [false, true, URL, true],
      [false, false, null, false],
    ];
    for (const [cloudFlag, signedIn, backendUrl, signInConfigured] of table) {
      expect(
        chooseProductStore({
          cloudFlag,
          readMarker: () => (signedIn ? { userId: USER } : null),
          backendUrl,
          signInConfigured,
        }),
      ).toEqual({ store: "local" });
    }
  });

  it("never reads the marker with the flag off, or with no backend or sign-in to launch into", () => {
    const readMarker = vi.fn(() => ({ userId: USER }));
    chooseProductStore({ cloudFlag: false, readMarker, backendUrl: URL, signInConfigured: true });
    chooseProductStore({ cloudFlag: true, readMarker, backendUrl: null, signInConfigured: true });
    chooseProductStore({ cloudFlag: true, readMarker, backendUrl: URL, signInConfigured: false });
    expect(readMarker).not.toHaveBeenCalled();
  });

  it("stores the marker as a user id, and reads anything else as none", () => {
    expect(decodeLaunchMarker(encodeLaunchMarker(USER))).toEqual({ userId: USER });
    for (const raw of [undefined, "", "{", "null", "[]", '{"userId":""}', '{"userId":7}']) {
      expect(decodeLaunchMarker(raw), String(raw)).toBeNull();
    }
    // A registered, device-local row: never a host's or a Workspace's.
    expect(classifyAppStateKey(CLOUD_LAUNCH_APP_STATE_KEY)?.placement).toBe("client-local");
  });
});

function row(initial?: string) {
  let value = initial;
  const live = {
    read: vi.fn(() => value),
    write: vi.fn((next: string) => {
      value = next;
    }),
    remove: vi.fn(() => {
      value = undefined;
    }),
  } satisfies LaunchMarkerRow;
  return live;
}
const log = () => ({ warn: vi.fn() });

describe("the launch marker's row", () => {
  it("writes and clears the marker, touching the row only when it changes", () => {
    const live = row();
    const store = launchMarkerStore(() => live, log());
    expect(store.read()).toBeNull();
    store.clear();
    expect(live.remove).not.toHaveBeenCalled();
    store.write(USER);
    store.write(USER);
    expect(live.write).toHaveBeenCalledOnce();
    expect(store.read()).toEqual({ userId: USER });
    store.clear();
    expect(live.remove).toHaveBeenCalledOnce();
    expect(store.read()).toBeNull();
  });

  it("reads as no marker, and writes nothing, without a database", () => {
    const store = launchMarkerStore(() => null, log());
    expect(store.read()).toBeNull();
    expect(() => store.write(USER)).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it("logs a row that fails and launches local", () => {
    const warnings = log();
    const broken: LaunchMarkerRow = {
      read: () => {
        throw new Error("database is locked");
      },
      write: () => {},
      remove: () => {},
    };
    const store = launchMarkerStore(() => broken, warnings);
    expect(store.read()).toBeNull();
    store.write(USER);
    store.clear();
    expect(warnings.warn.mock.calls.map(([message]) => message)).toEqual([
      "could not read the Volli Cloud launch marker",
      "could not write the Volli Cloud launch marker",
      "could not clear the Volli Cloud launch marker",
    ]);
  });
});

function app() {
  return { quit: vi.fn(), relaunch: vi.fn() };
}

describe("the relaunch", () => {
  it("goes through the quit path and starts a new process only once the quit is accepted", () => {
    const lifecycle = app();
    const relaunch = createRelaunchController(lifecycle);
    expect(relaunch.pending()).toBe(false);
    relaunch.request();
    relaunch.request();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
    expect(lifecycle.relaunch).not.toHaveBeenCalled();
    expect(relaunch.pending()).toBe(true);
    relaunch.quitAccepted();
    expect(lifecycle.relaunch).toHaveBeenCalledOnce();
    expect(relaunch.pending()).toBe(false);
  });

  it("leaves the launch as it is when a gate cancels, and the next plain quit stays a quit", () => {
    const lifecycle = app();
    const relaunch = createRelaunchController(lifecycle);
    relaunch.request();
    relaunch.quitRefused();
    expect(relaunch.pending()).toBe(false);
    relaunch.quitAccepted();
    expect(lifecycle.relaunch).not.toHaveBeenCalled();
    // Asked again: a new attempt through the gates.
    relaunch.request();
    expect(lifecycle.quit).toHaveBeenCalledTimes(2);
  });
});

function turnFeed(answer: "wait" | "now" | "cancel") {
  let turns = 2;
  let changed: (() => void) | null = null;
  let tick: (() => void) | null = null;
  const off = vi.fn(() => {
    changed = null;
  });
  const ports = {
    turns: () => turns,
    subscribe: (listener: () => void) => {
      changed = listener;
      return off;
    },
    choose: vi.fn(() => answer),
    setInterval: (run: () => void) => {
      tick = run;
      return "timer";
    },
    clearInterval: vi.fn(() => {
      tick = null;
    }),
  };
  return {
    ports,
    off,
    set: (count: number) => {
      turns = count;
      changed?.();
    },
    tick: () => tick?.(),
  };
}

describe("switching stores over running turns", () => {
  it("waits for turns without stopping anything, then uses every normal quit gate once", () => {
    const lifecycle = app();
    const work = turnFeed("wait");
    const control = createRelaunchController(lifecycle, work.ports);
    control.request();
    control.request();
    expect(work.ports.choose).toHaveBeenCalledExactlyOnceWith(2);
    expect(lifecycle.quit).not.toHaveBeenCalled();
    work.set(1);
    expect(lifecycle.quit).not.toHaveBeenCalled();
    work.set(0);
    work.tick();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
    expect(work.off).toHaveBeenCalledOnce();
    expect(control.pending()).toBe(true);
    control.quitAccepted();
    expect(lifecycle.relaunch).toHaveBeenCalledOnce();
  });
  it("releases a primed subscription that already observed the last turn finish", () => {
    const lifecycle = app();
    let turns = 1;
    const off = vi.fn();
    const timer = vi.fn();
    const control = createRelaunchController(lifecycle, {
      turns: () => turns,
      choose: () => "wait",
      subscribe: (listener) => {
        turns = 0;
        listener();
        return off;
      },
      setInterval: timer,
    });
    control.request();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
    expect(control.pending()).toBe(true);
  });

  it("clears the default polling timer on refusal and when turns finish without a fold", () => {
    vi.useFakeTimers();
    try {
      const lifecycle = app();
      let turns = 1;
      const off = vi.fn();
      const control = createRelaunchController(lifecycle, {
        turns: () => turns,
        choose: () => "wait",
        subscribe: () => off,
      });
      control.request();
      expect(vi.getTimerCount()).toBe(1);
      control.quitRefused();
      expect(vi.getTimerCount()).toBe(0);
      expect(lifecycle.quit).not.toHaveBeenCalled();
      control.request();
      turns = 0;
      vi.advanceTimersByTime(1_000);
      expect(lifecycle.quit).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(off).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can switch now or cancel, without arming an eventual unrelated relaunch", () => {
    const lifecycle = app();
    const cancelled = createRelaunchController(lifecycle, turnFeed("cancel").ports);
    cancelled.request();
    expect(cancelled.pending()).toBe(false);
    expect(lifecycle.quit).not.toHaveBeenCalled();
    const now = createRelaunchController(lifecycle, turnFeed("now").ports);
    now.request();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
    now.quitRefused();
    now.quitAccepted();
    expect(lifecycle.relaunch).not.toHaveBeenCalled();
  });
});

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
    expect(chooseProductStore({ cloudFlag: true, readMarker: marker, backendUrl: URL })).toEqual({
      store: "cloud",
      userId: USER,
      backendUrl: URL,
    });
    const table: [boolean, boolean, string | null][] = [
      [true, false, URL],
      [true, true, null],
      [false, true, URL],
      [false, false, null],
    ];
    for (const [cloudFlag, signedIn, backendUrl] of table) {
      expect(
        chooseProductStore({
          cloudFlag,
          readMarker: () => (signedIn ? { userId: USER } : null),
          backendUrl,
        }),
      ).toEqual({ store: "local" });
    }
  });

  it("never reads the marker with the flag off, or with no backend to launch into", () => {
    const readMarker = vi.fn(() => ({ userId: USER }));
    chooseProductStore({ cloudFlag: false, readMarker, backendUrl: URL });
    chooseProductStore({ cloudFlag: true, readMarker, backendUrl: null });
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

import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { parkBrowserPlanesOnRendererReset } from "./plane-reset";
import { BrowserStageUnavailableError } from "./tab-host";

/**
 * One window's `webContents`, recording what the rule subscribed to. An event it
 * never subscribed to reaches nothing, which is how a test tells a started or
 * in-page navigation from a committed one.
 */
class FakeContents {
  readonly listeners = new Map<string, (() => void)[]>();

  on(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  subscribed(): string[] {
    return [...this.listeners.keys()];
  }
}

function fakeWindow(destroyed = false): BrowserWindow {
  return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

/** The windows the host was asked to park, in order, and what was logged. */
let parked: BrowserWindow[];
let logged: string[];
/** What the host does when asked, so a test can model a stage it cannot build. */
let hostFails: (() => void) | null;

/** Wires one window, the way `createOwnedWindow` does for every window it makes. */
function wire(window: BrowserWindow, contents = new FakeContents()): FakeContents {
  parkBrowserPlanesOnRendererReset({
    host: {
      parkPlanesOn: (target) => {
        parked.push(target);
        hostFails?.();
        return ["tab-1"];
      },
    },
    window,
    contents,
    log: (message) => logged.push(message),
  });
  return contents;
}

beforeEach(() => {
  parked = [];
  logged = [];
  hostFails = null;
});

describe("parkBrowserPlanesOnRendererReset", () => {
  it("listens for the committed navigation and the dead renderer, and nothing else", () => {
    const contents = wire(fakeWindow());

    // A started navigation is not a page that went away: it can be superseded
    // or cancelled with the React tree that owns the planes still running, and
    // sweeping then would blank a live pane. An in-page navigation keeps the
    // page outright. Neither is subscribed, so neither can park anything.
    expect(contents.subscribed()).toEqual(["did-navigate", "render-process-gone"]);
    contents.emit("did-start-navigation");
    contents.emit("did-navigate-in-page");
    contents.emit("did-frame-navigate");
    expect(parked).toEqual([]);
  });

  it("parks the window's planes when its page commits a navigation", () => {
    const window = fakeWindow();
    const contents = wire(window);

    contents.emit("did-navigate");

    expect(parked).toEqual([window]);
    expect(logged).toEqual([]);
  });

  it("parks them when the app renderer dies instead, which commits nothing", () => {
    const window = fakeWindow();
    const contents = wire(window);

    contents.emit("render-process-gone");

    expect(parked).toEqual([window]);
  });

  it("parks only the window whose page reset, when several are wired", () => {
    const mine = fakeWindow();
    const other = fakeWindow();
    const mineContents = wire(mine);
    const otherContents = wire(other);

    mineContents.emit("did-navigate");
    expect(parked).toEqual([mine]);

    // Each window's events carry its own window, so a second window reloading
    // never sweeps the planes off the one still showing them.
    otherContents.emit("render-process-gone");
    expect(parked).toEqual([mine, other]);
  });

  it("leaves a destroyed window alone, so teardown never rebuilds the off-screen stage", () => {
    const contents = wire(fakeWindow(true));

    // The window is going away with the app: no fresh UI on it to protect, and
    // parking may ask the host to build a BaseWindow for its stage — not
    // something to create while the app is tearing down.
    contents.emit("render-process-gone");
    contents.emit("did-navigate");

    expect(parked).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("logs a host failure instead of raising it into an Electron event handler", () => {
    const contents = wire(fakeWindow());
    hostFails = () => {
      throw new BrowserStageUnavailableError();
    };

    expect(() => contents.emit("render-process-gone")).not.toThrow();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("crashed");
    expect(logged[0]).toContain("no surface to capture or click");
  });

  it("describes a thrown non-error too, naming the reset it followed", () => {
    const contents = wire(fakeWindow());
    hostFails = () => {
      throw "the window server went away";
    };

    contents.emit("did-navigate");

    expect(logged[0]).toContain("navigated");
    expect(logged[0]).toContain("the window server went away");
  });
});

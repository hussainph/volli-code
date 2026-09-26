import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import { BrowserStageUnavailableError } from "./tab-host";
import { parkBrowserPlanes, replacesAppRenderer } from "./plane-reset";

/** Identity is all this rule does with the window: it hands it to the host. */
const appWindow = {} as unknown as BrowserWindow;

describe("replacesAppRenderer", () => {
  it("counts a main-frame document navigation, which is the reload and the crash recovery", () => {
    expect(replacesAppRenderer({ isMainFrame: true, isSameDocument: false })).toBe(true);
  });

  it("ignores a same-document navigation, which keeps the panes that own the planes", () => {
    // A hash change or a history push inside the running app: the React tree
    // is still there and still placing its planes, so sweeping them off would
    // blank a pane nothing is going to show again.
    expect(replacesAppRenderer({ isMainFrame: true, isSameDocument: true })).toBe(false);
  });

  it("ignores a subframe navigation, whatever loads inside the app page", () => {
    expect(replacesAppRenderer({ isMainFrame: false, isSameDocument: false })).toBe(false);
    expect(replacesAppRenderer({ isMainFrame: false, isSameDocument: true })).toBe(false);
  });
});

describe("parkBrowserPlanes", () => {
  it("parks the window's planes and reports which tabs came off", () => {
    const parkPlanesOn = vi.fn(() => ["tab-1", "tab-2"]);
    const log = vi.fn();

    expect(
      parkBrowserPlanes({ host: { parkPlanesOn }, window: appWindow, why: "reloaded", log }),
    ).toEqual(["tab-1", "tab-2"]);

    expect(parkPlanesOn.mock.calls).toEqual([[appWindow]]);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a host failure instead of raising it into an Electron event handler", () => {
    const log = vi.fn();

    const parked = parkBrowserPlanes({
      host: {
        parkPlanesOn: () => {
          throw new BrowserStageUnavailableError();
        },
      },
      window: appWindow,
      why: "crashed",
      log,
    });

    // Nothing is waiting on this cleanup and the page that could show a toast
    // is the one that just died, so the fault is reported to the log and the
    // reset carries on: the planes are already off the window by then.
    expect(parked).toEqual([]);
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toContain("crashed");
    expect(log.mock.calls[0]?.[0]).toContain("no surface to capture or click");
  });

  it("describes a thrown non-error too", () => {
    const log = vi.fn();

    parkBrowserPlanes({
      host: {
        parkPlanesOn: () => {
          throw "the window server went away";
        },
      },
      window: appWindow,
      why: "reloaded",
      log,
    });

    expect(log.mock.calls[0]?.[0]).toContain("the window server went away");
  });
});

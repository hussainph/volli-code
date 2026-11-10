// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  beginPaneResize,
  observePaneLayout,
  onPaneResizeSettled,
  paneResizeActive,
} from "./pane-resize";

afterEach(() => vi.unstubAllGlobals());
it("defers layout until all pane owners settle and unsubscribes cleanly", () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const layout = vi.fn(),
    settled = vi.fn();
  const stop = observePaneLayout(document.createElement("div"), layout);
  const off = onPaneResizeSettled(settled);
  const endLeft = beginPaneResize({}),
    endRight = beginPaneResize({});
  expect(paneResizeActive()).toBe(true);
  resize();
  resize();
  expect(layout).not.toHaveBeenCalled();
  endLeft();
  expect(layout).not.toHaveBeenCalled();
  endRight();
  expect(paneResizeActive()).toBe(false);
  expect(layout).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledTimes(1);
  endRight();
  expect(layout).toHaveBeenCalledTimes(1);
  resize();
  expect(layout).toHaveBeenCalledTimes(2);
  stop();
  off();
  expect(disconnect).toHaveBeenCalledTimes(1);
  beginPaneResize({})();
  expect(layout).toHaveBeenCalledTimes(2);
  expect(settled).toHaveBeenCalledTimes(1);
});

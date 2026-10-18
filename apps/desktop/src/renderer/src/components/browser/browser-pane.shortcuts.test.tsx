// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { runBrowserAppShortcut } from "./browser-app-shortcuts";
import { BrowserPane } from "./browser-pane";

/**
 * ⌘W and ⌘L pressed inside a page come back from main naming the tab
 * (VC-301). These drive the pane that draws it, through the same entry the
 * app-shell subscription calls.
 */

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function tab(tabId: string): BrowserTabState {
  return {
    tabId,
    projectId: "project-1",
    ticketId: null,
    createdBy: "user",
    ownerSessionId: null,
    presentation: "tab",
    url: `https://example.com/${tabId}`,
    title: tabId,
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
    heldBy: null,
  };
}

const api = {
  capture: vi.fn(async () => ({ ok: true, frames: [] }) as const),
  setBounds: vi.fn(async () => ({ ok: true }) as const),
  show: vi.fn(async () => ({ ok: true }) as const),
  hide: vi.fn(async () => ({ ok: true }) as const),
} as unknown as BrowserApi;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

interface DrawnPane {
  tab: BrowserTabState;
  visible: boolean;
  onClose?: () => void;
  onFocusPane?: () => void;
}

function draw(panes: DrawnPane[]): void {
  act(() => {
    root.render(
      <>
        {panes.map((pane) => (
          <BrowserPane
            key={pane.tab.tabId}
            tab={pane.tab}
            visible={pane.visible}
            api={api}
            onTabState={() => undefined}
            onClose={pane.onClose}
            onFocusPane={pane.onFocusPane}
          />
        ))}
      </>,
    );
  });
}

function address(tabId: string): HTMLInputElement {
  const input = container
    .querySelector(`[data-browser-plane="${tabId}"]`)
    ?.parentElement?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`no address bar for ${tabId}`);
  return input;
}

describe("BrowserPane app shortcuts", () => {
  it("closes the pane's own tab on ⌘W, not the other pane on screen", () => {
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    draw([
      { tab: tab("tab-1"), visible: true, onClose: closeFirst },
      { tab: tab("tab-2"), visible: true, onClose: closeSecond },
    ]);

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
  });

  it("calls the surface's latest close, not the one it mounted with", () => {
    const stale = vi.fn();
    const latest = vi.fn();
    draw([{ tab: tab("tab-1"), visible: true, onClose: stale }]);
    draw([{ tab: tab("tab-1"), visible: true, onClose: latest }]);

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(latest).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it("reports ⌘W as not acted on for a pane its surface gave no close", () => {
    draw([{ tab: tab("tab-1"), visible: true }]);

    expect(runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } })).toBe(false);
  });

  it("focuses its own split-view pane before a chord from inside the page is replayed", () => {
    const focusFirst = vi.fn();
    const focusSecond = vi.fn();
    draw([
      { tab: tab("tab-1"), visible: true, onFocusPane: focusFirst },
      { tab: tab("tab-2"), visible: true, onFocusPane: focusSecond },
    ]);

    runBrowserAppShortcut({
      tabId: "tab-2",
      shortcut: {
        kind: "replay",
        chord: {
          key: "ArrowRight",
          code: "ArrowRight",
          metaKey: true,
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
          repeat: false,
        },
      },
    });

    expect(focusSecond).toHaveBeenCalledOnce();
    expect(focusFirst).not.toHaveBeenCalled();
  });

  it("returns focus to the pane's own address bar on ⌘L, with the address selected", () => {
    draw([
      { tab: tab("tab-1"), visible: true },
      { tab: tab("tab-2"), visible: true },
    ]);

    runBrowserAppShortcut({ tabId: "tab-2", shortcut: { kind: "focus-address" } });

    const field = address("tab-2");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it("does not answer for a hidden pane, which has no page focus to press from", () => {
    const close = vi.fn();
    draw([{ tab: tab("tab-1"), visible: false, onClose: close }]);

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });
    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "focus-address" } });

    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(address("tab-1"));
  });

  it("stops answering once the pane unmounts", () => {
    const close = vi.fn();
    draw([{ tab: tab("tab-1"), visible: true, onClose: close }]);
    draw([]);

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(close).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabCaptureResult, BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { BrowserPane } from "./browser-pane";

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const tab: BrowserTabState = {
  tabId: "tab-1",
  projectId: "project-1",
  ticketId: null,
  createdBy: "user",
  url: "https://example.com",
  title: "Example",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 0,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.remove());
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("BrowserPane renderer overlays", () => {
  it("captures before hiding the native plane, then restores it when the overlay closes", async () => {
    let finishCapture: ((result: BrowserTabCaptureResult) => void) | null = null;
    const capture = vi.fn(
      () =>
        new Promise<BrowserTabCaptureResult>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const setBounds = vi.fn(async () => ({ ok: true }) as const);
    const show = vi.fn(async () => ({ ok: true }) as const);
    const hide = vi.fn(async () => ({ ok: true }) as const);
    const api = {
      capture,
      setBounds,
      show,
      hide,
    } as unknown as BrowserApi;

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    expect(show).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    await settle();

    expect(capture).toHaveBeenCalledWith({ tabId: "tab-1" });
    expect(hide).not.toHaveBeenCalled();

    await act(async () => {
      finishCapture?.({
        ok: true,
        frames: [
          {
            kind: "page",
            dataUrl: "data:image/png;base64,frozen-page",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
          },
        ],
      });
      await Promise.resolve();
    });

    const snapshot = container?.querySelector<HTMLImageElement>(
      '[data-browser-plane-snapshot="page"]',
    );
    expect(snapshot?.src).toBe("data:image/png;base64,frozen-page");
    expect(snapshot?.style.cssText).toContain("width: 800px");
    expect(hide).toHaveBeenCalledOnce();

    dialog.remove();
    await settle();

    expect(show).toHaveBeenCalledTimes(2);
    expect(container?.querySelector("[data-browser-plane-snapshot]")).toBeNull();
  });
});

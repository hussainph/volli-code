// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabCaptureResult, BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { BrowserPane } from "./browser-pane";
import { PLANE_FREEZE_CAPTURE_TIMEOUT_MS } from "./browser-plane-freeze";

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
  vi.useRealTimers();
});

/** A pane api whose capture the test resolves by hand. */
function deferredApi(): {
  api: BrowserApi;
  settle: (result: BrowserTabCaptureResult) => void;
  capture: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
} {
  let answer: ((result: BrowserTabCaptureResult) => void) | null = null;
  const capture = vi.fn(
    () =>
      new Promise<BrowserTabCaptureResult>((resolve) => {
        answer = resolve;
      }),
  );
  const show = vi.fn(async () => ({ ok: true }) as const);
  const hide = vi.fn(async () => ({ ok: true }) as const);
  const api = {
    capture,
    setBounds: vi.fn(async () => ({ ok: true }) as const),
    show,
    hide,
  } as unknown as BrowserApi;
  return { api, settle: (result) => answer?.(result), capture, show, hide };
}

/**
 * Stands in for a portaled overlay. Radix renders to `document.body`, outside
 * the app root, which is exactly what `hasNativePlaneOverlay` looks for.
 */
function openDialog(): HTMLDivElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  act(() => {
    document.body.append(dialog);
  });
  return dialog;
}

function closeOverlay(node: HTMLElement): void {
  act(() => node.remove());
}

function snapshotCount(): number {
  return container?.querySelectorAll("[data-browser-plane-snapshot]").length ?? 0;
}

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

    const dialog = openDialog();
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

    closeOverlay(dialog);
    await settle();

    expect(show).toHaveBeenCalledTimes(2);
    expect(container?.querySelector("[data-browser-plane-snapshot]")).toBeNull();
  });

  it("yields the plane on a refused capture, so the overlay is still operable", async () => {
    const { api, settle: resolveCapture, hide } = deferredApi();
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });

    const dialog = openDialog();
    await settle();
    expect(hide).not.toHaveBeenCalled();

    await act(async () => {
      resolveCapture({ ok: false, error: "no such tab" });
      await Promise.resolve();
    });

    // Themed background rather than pixels — but the plane MUST come down, or
    // the dialog stays underneath a native view the person cannot see past.
    expect(hide).toHaveBeenCalledOnce();
    expect(snapshotCount()).toBe(0);
    closeOverlay(dialog);
  });

  it("stops waiting when a capture hangs, rather than hiding the overlay forever", async () => {
    vi.useFakeTimers();
    const { api, hide } = deferredApi();
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });

    const dialog = openDialog();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still live: the pane is giving the capture its bounded chance.
    expect(hide).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(PLANE_FREEZE_CAPTURE_TIMEOUT_MS + 1);
      await Promise.resolve();
    });

    expect(hide).toHaveBeenCalledOnce();
    expect(snapshotCount()).toBe(0);
    closeOverlay(dialog);
  });

  it("ignores a capture that lands after the pane stopped caring", async () => {
    const { api, settle: resolveCapture, hide } = deferredApi();
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });

    const dialog = openDialog();
    await settle();
    closeOverlay(dialog);
    await settle();

    await act(async () => {
      resolveCapture({
        ok: true,
        frames: [
          {
            kind: "page",
            dataUrl: "data:image/png;base64,too-late",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
          },
        ],
      });
      await Promise.resolve();
    });

    // The overlay is gone; stale pixels must never reappear over a live plane.
    expect(snapshotCount()).toBe(0);
    expect(hide).not.toHaveBeenCalled();
  });
});

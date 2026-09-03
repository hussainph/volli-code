// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabCaptureResult, BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { BrowserPane } from "./browser-pane";
import { PLANE_REFRESH_MIN_INTERVAL_MS } from "./browser-plane-freeze";

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

function captureResult(label: string): BrowserTabCaptureResult {
  return {
    ok: true,
    frames: [
      {
        kind: "page",
        dataUrl: `data:image/png;base64,${label}`,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    ],
  };
}

function makeApi(capture: BrowserApi["capture"]) {
  const show = vi.fn(async () => ({ ok: true }) as const);
  const hide = vi.fn(async () => ({ ok: true }) as const);
  const api = {
    capture,
    setBounds: vi.fn(async () => ({ ok: true }) as const),
    show,
    hide,
  } as unknown as BrowserApi;
  return { api, show, hide };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Radix portals to `document.body`, outside the app root — so does this. */
function openDialog(): HTMLDivElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  act(() => {
    document.body.append(dialog);
  });
  return dialog;
}

function shownPixels(): string | null {
  const img = container?.querySelector<HTMLImageElement>("[data-browser-plane-snapshot]");
  return img === null || img === undefined ? null : img.src;
}

describe("BrowserPane renderer overlays", () => {
  it("photographs the plane up front, so an overlay never waits for pixels", async () => {
    const capture = vi.fn(async () => captureResult("primed"));
    const { api, hide } = makeApi(capture as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();

    // Captured on arrival, with no overlay in sight.
    expect(capture).toHaveBeenCalledWith({ tabId: "tab-1" });
    expect(shownPixels()).toBe("data:image/png;base64,primed");
    expect(hide).not.toHaveBeenCalled();

    const capturesBefore = capture.mock.calls.length;
    openDialog();
    await settle();

    // The plane came down WITHOUT another round trip: the pixels were already
    // in the tree. This is what stops an overlay opening behind the page.
    expect(hide).toHaveBeenCalledOnce();
    expect(capture.mock.calls.length).toBe(capturesBefore);
    expect(shownPixels()).toBe("data:image/png;base64,primed");
  });

  it("restores the plane when the overlay leaves", async () => {
    const { api, show } = makeApi(
      vi.fn(async () => captureResult("primed")) as unknown as BrowserApi["capture"],
    );

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();
    expect(show).toHaveBeenCalledOnce();

    const dialog = openDialog();
    await settle();

    act(() => dialog.remove());
    await settle();

    expect(show).toHaveBeenCalledTimes(2);
    // The pixels stay in the tree, covered by the reattached native view, so
    // there is no moment where neither the page nor its stand-in is painted.
    expect(shownPixels()).toBe("data:image/png;base64,primed");
  });

  it("refuses to photograph a plane that is already detached", async () => {
    const capture = vi.fn(async () => captureResult("primed"));
    const { api } = makeApi(capture as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();
    openDialog();
    await settle();

    const capturesBefore = capture.mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });

    // A detached view has nothing current to photograph, and the frames it
    // would answer with are the ones already on screen.
    expect(capture.mock.calls.length).toBe(capturesBefore);
  });

  it("throttles a burst of presses down to one photograph", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => captureResult("primed"));
    const { api } = makeApi(capture as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const capturesAfterMount = capture.mock.calls.length;

    await act(async () => {
      for (let press = 0; press < 5; press += 1) {
        document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(capture.mock.calls.length).toBe(capturesAfterMount);

    vi.advanceTimersByTime(PLANE_REFRESH_MIN_INTERVAL_MS + 1);
    await act(async () => {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(capture.mock.calls.length).toBe(capturesAfterMount + 1);
  });

  it("keeps the last good pixels when a capture is refused", async () => {
    let answer: BrowserTabCaptureResult = captureResult("good");
    const capture = vi.fn(async () => answer);
    const { api } = makeApi(capture as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();
    expect(shownPixels()).toBe("data:image/png;base64,good");

    answer = { ok: false, error: "no such tab" };
    await act(async () => {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });

    // No toast, no blank plane: the previous photograph is still the truest
    // thing available, so the overlay still opens onto page pixels.
    expect(shownPixels()).toBe("data:image/png;base64,good");
  });

  it("drops the pixels when the pane goes away, so nothing stale returns", async () => {
    const { api } = makeApi(
      vi.fn(async () => captureResult("primed")) as unknown as BrowserApi["capture"],
    );

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();
    expect(shownPixels()).toBe("data:image/png;base64,primed");

    await act(async () => {
      root?.render(
        <BrowserPane tab={tab} visible={false} api={api} onTabState={() => undefined} />,
      );
    });
    await settle();
    expect(shownPixels()).toBeNull();
  });
});

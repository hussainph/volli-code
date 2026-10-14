// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserTabCaptureResult, BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { BrowserPane } from "./browser-pane";
import { PLANE_CAPTURE_DEADLINE_MS, PLANE_OVERLAY_RELEASE_MS } from "./browser-plane-freeze";

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

const tab: BrowserTabState = {
  tabId: "tab-1",
  projectId: "project-1",
  ticketId: null,
  createdBy: "user",
  ownerSessionId: null,
  presentation: "tab",
  url: "https://example.com",
  title: "Example",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 0,
  heldBy: null,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(100, 100, 800, 600),
  );
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(100, 100, 800, 600)] as unknown as DOMRectList,
  );
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.remove());
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function captureResult(label: string): BrowserTabCaptureResult {
  return {
    ok: true,
    frames: [
      {
        kind: "page",
        dataUrl: `data:image/jpeg;base64,${label}`,
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

/**
 * Flushes a frame as well as the microtask queue: the overlay hook coalesces
 * its document read with `requestAnimationFrame`, so microtasks alone never
 * let it notice that an overlay appeared.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
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

async function releaseOverlay(): Promise<void> {
  await settle();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, PLANE_OVERLAY_RELEASE_MS + 20));
  });
}

function shownPixels(): string | null {
  const img = container?.querySelector<HTMLImageElement>("[data-browser-plane-snapshot]");
  return img === null || img === undefined ? null : img.src;
}

describe("BrowserPane renderer overlays", () => {
  it("captures WHEN the overlay opens, and holds the plane until the pixels land", async () => {
    const gate: { answer: ((r: BrowserTabCaptureResult) => void) | null } = { answer: null };
    const capture = vi.fn(
      () =>
        new Promise<BrowserTabCaptureResult>((resolve) => {
          gate.answer = resolve;
        }),
    );
    const { api, hide } = makeApi(capture as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();
    // Nothing is photographed speculatively: a pre-taken frame would be stale.
    expect(capture).not.toHaveBeenCalled();

    openDialog();
    await settle();
    expect(capture).toHaveBeenCalledWith({ tabId: "tab-1" });
    // The page is STILL on screen. Detaching before the stand-in exists is
    // exactly what showed a black rectangle.
    expect(hide).not.toHaveBeenCalled();

    await act(async () => {
      gate.answer?.(captureResult("fresh"));
      await Promise.resolve();
    });

    expect(hide).toHaveBeenCalledOnce();
    expect(shownPixels()).toBe("data:image/jpeg;base64,fresh");
  });

  it("takes the tier back after the close grace, pixels still painted", async () => {
    const { api, show } = makeApi(
      vi.fn(async () => captureResult("fresh")) as unknown as BrowserApi["capture"],
    );

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    await settle();
    expect(show).toHaveBeenCalledOnce();

    const dialog = openDialog();
    await settle();
    expect(shownPixels()).toBe("data:image/jpeg;base64,fresh");

    act(() => dialog.remove());
    await settle();
    expect(show).toHaveBeenCalledOnce();
    await releaseOverlay();

    // No second capture on the way back, and the stand-in stays painted under
    // the reattached view so no frame is ever empty.
    expect(show).toHaveBeenCalledTimes(2);
    expect(shownPixels()).toBe("data:image/jpeg;base64,fresh");
  });

  it("gives up on a hung capture rather than hiding the overlay", async () => {
    // Real timers: the overlay hook coalesces on `requestAnimationFrame`, which
    // vitest's fake clock does not drive. The deadline is short enough to wait.
    const capture = vi.fn(() => new Promise<BrowserTabCaptureResult>(() => {}));
    const { api, hide } = makeApi(capture as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    openDialog();
    await settle();

    // The capture is away and will never answer, so the page still holds the
    // window rather than the overlay opening onto a hole.
    expect(capture).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PLANE_CAPTURE_DEADLINE_MS + 40));
    });

    // The deadline is the only reason a menu cannot be hidden by a bad page.
    expect(hide).toHaveBeenCalledOnce();
  });

  it("falls back to the previous frames when a capture is refused", async () => {
    let answer: BrowserTabCaptureResult = captureResult("first");
    const { api, hide } = makeApi(vi.fn(async () => answer) as unknown as BrowserApi["capture"]);

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    const first = openDialog();
    await settle();
    expect(shownPixels()).toBe("data:image/jpeg;base64,first");
    act(() => first.remove());
    await releaseOverlay();

    answer = { ok: false, error: "no such tab" };
    openDialog();
    await settle();

    // No toast, no blank plane: the last good photograph is still the truest
    // thing available, and the overlay still becomes operable.
    expect(shownPixels()).toBe("data:image/jpeg;base64,first");
    expect(hide).toHaveBeenCalledTimes(2);
  });

  it("keeps one still across back-to-back hovering surfaces", async () => {
    const capture = vi.fn(async () => captureResult("hover"));
    const { api, show, hide } = makeApi(capture as unknown as BrowserApi["capture"]);
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    const first = openDialog();
    first.style.position = "fixed";
    first.removeAttribute("role");
    await settle();
    expect(hide).toHaveBeenCalledOnce();
    act(() => first.remove());
    await settle();
    const second = openDialog();
    second.setAttribute("role", "tooltip");
    await settle();
    expect(capture).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    expect(shownPixels()).toBe("data:image/jpeg;base64,hover");
    second.remove();
    await releaseOverlay();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("does not release when a reopened hover still has its animation-frame read pending", async () => {
    const capture = vi.fn(async () => captureResult("hover"));
    const { api, show } = makeApi(capture as unknown as BrowserApi["capture"]);
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    const first = openDialog();
    await settle();
    // Flush the mutation caused by painting the captured image before taking
    // control of the next frame/deadline ordering.
    await settle();
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    await act(async () => first.remove());
    await act(async () => {
      for (const callback of callbacks.splice(0)) callback(0);
    });
    await act(async () => {
      vi.advanceTimersByTime(PLANE_OVERLAY_RELEASE_MS - 1);
    });
    openDialog();
    await act(async () => {
      await Promise.resolve();
    });
    expect(callbacks.length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(show).toHaveBeenCalledOnce();
    await act(async () => {
      for (const callback of callbacks.splice(0)) callback(0);
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
  });

  it("does not capture unrelated hover UI, and remeasures on scroll and resize", async () => {
    const capture = vi.fn(async () => captureResult("hover"));
    const { api, hide, show } = makeApi(capture as unknown as BrowserApi["capture"]);
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    const tooltip = openDialog();
    let rect = new DOMRect(0, 0, 50, 50);
    vi.spyOn(tooltip, "getClientRects").mockImplementation(() => [rect] as unknown as DOMRectList);
    tooltip.setAttribute("role", "tooltip");
    await settle();
    expect(capture).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    rect = new DOMRect(200, 200, 50, 50);
    document.dispatchEvent(new Event("scroll"));
    await settle();
    expect(hide).toHaveBeenCalledOnce();
    rect = new DOMRect(0, 0, 50, 50);
    window.dispatchEvent(new Event("resize"));
    await releaseOverlay();
    expect(show).toHaveBeenCalledTimes(2);
    tooltip.remove();
  });

  it("ignores a capture that resolves after its overlay closed", async () => {
    let resolve!: (result: BrowserTabCaptureResult) => void;
    const capture = vi.fn(
      () =>
        new Promise<BrowserTabCaptureResult>((answer) => {
          resolve = answer;
        }),
    );
    const { api } = makeApi(capture as unknown as BrowserApi["capture"]);
    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    const dialog = openDialog();
    await settle();
    dialog.remove();
    await releaseOverlay();
    await act(async () => resolve(captureResult("late")));
    expect(shownPixels()).toBeNull();
  });

  it("drops the pixels when the pane goes away, so nothing stale returns", async () => {
    const { api } = makeApi(
      vi.fn(async () => captureResult("fresh")) as unknown as BrowserApi["capture"],
    );

    await act(async () => {
      root?.render(<BrowserPane tab={tab} visible api={api} onTabState={() => undefined} />);
    });
    openDialog();
    await settle();
    expect(shownPixels()).toBe("data:image/jpeg;base64,fresh");

    await act(async () => {
      root?.render(
        <BrowserPane tab={tab} visible={false} api={api} onTabState={() => undefined} />,
      );
    });
    await settle();
    expect(shownPixels()).toBeNull();
  });
});

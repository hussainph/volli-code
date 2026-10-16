// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BrowserTabState } from "../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { closeBrowserTabWithUndo, useClosingBrowserTabIds } from "./use-island-tabs-close";

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toast } from "sonner";
import { toastError } from "@renderer/lib/toast";

const tab: BrowserTabState = {
  tabId: "a",
  projectId: "p",
  ticketId: "t",
  createdBy: "session",
  ownerSessionId: "s",
  presentation: "tab",
  url: "http://localhost:5173/settings",
  title: "Settings",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
  heldBy: null,
};
function bridge() {
  return {
    close: vi.fn(async () => ({ ok: true }) as const),
    setPresentation: vi.fn(async () => ({ ok: true, tab }) as const),
  };
}
function undo(): void {
  const action = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action))
    throw new Error("No Undo action");
  action.onClick({} as never);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useClosingBrowserTabIds.setState(new Set(), true);
  useBrowserTabsStore.setState({ byId: { a: tab } });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("reversible Browser Tab close", () => {
  it("hides immediately, ignores duplicate presses and destroys once after Undo expires", async () => {
    const api = bridge();
    const refused = vi.fn();
    await closeBrowserTabWithUndo(api as unknown as BrowserApi, tab, refused);
    await closeBrowserTabWithUndo(api as unknown as BrowserApi, tab, refused);
    expect(api.setPresentation).toHaveBeenCalledExactlyOnceWith({
      tabId: "a",
      presentation: "headless",
    });
    expect(useClosingBrowserTabIds.getState().has("a")).toBe(true);
    expect(api.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.close).toHaveBeenCalledExactlyOnceWith({ tabId: "a" });
    expect(useClosingBrowserTabIds.getState().size).toBe(0);
    expect(useBrowserTabsStore.getState().byId.a).toBeUndefined();
    undo(); // An expired notification can never resurrect a destroyed tab.
    expect(api.setPresentation).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it("undo restores the old presentation and keeps native identity and ownership", async () => {
    const api = bridge();
    await closeBrowserTabWithUndo(api as unknown as BrowserApi, tab, vi.fn());
    undo();
    undo();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.setPresentation).toHaveBeenLastCalledWith({ tabId: "a", presentation: "tab" });
    expect(api.setPresentation).toHaveBeenCalledTimes(2);
    expect(api.close).not.toHaveBeenCalled();
    expect(useClosingBrowserTabIds.getState().size).toBe(0);
    expect(useBrowserTabsStore.getState().byId.a).toBe(tab);
  });

  it("undo on an already-headless tab makes no presentation request", async () => {
    const api = bridge();
    await closeBrowserTabWithUndo(
      api as unknown as BrowserApi,
      { ...tab, presentation: "headless" },
      vi.fn(),
    );
    undo();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.setPresentation).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();
    expect(useClosingBrowserTabIds.getState().size).toBe(0);
  });

  it("surfaces a hide refusal and leaves the row visible without scheduling destruction", async () => {
    const api = bridge();
    api.setPresentation.mockResolvedValueOnce({ ok: false, error: "held" } as never);
    const refused = vi.fn();
    await closeBrowserTabWithUndo(api as unknown as BrowserApi, tab, refused);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.close).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Could not close Browser Tab: held");
    expect(refused).toHaveBeenCalledOnce();
    expect(useClosingBrowserTabIds.getState().size).toBe(0);
  });

  it("restores a row and presentation if native close is refused", async () => {
    const api = bridge();
    api.close.mockResolvedValueOnce({ ok: false, error: "held" } as never);
    const refused = vi.fn();
    await closeBrowserTabWithUndo(api as unknown as BrowserApi, tab, refused);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.setPresentation).toHaveBeenLastCalledWith({ tabId: "a", presentation: "tab" });
    expect(toastError).toHaveBeenCalledWith("Could not close Browser Tab: held");
    expect(refused).toHaveBeenCalledOnce();
    expect(useClosingBrowserTabIds.getState().size).toBe(0);
  });

  it("reports transport and restore failures rather than losing the hidden row", async () => {
    const api = bridge();
    api.close.mockRejectedValueOnce(new Error("disconnected"));
    api.setPresentation.mockResolvedValueOnce({ ok: true, tab });
    api.setPresentation.mockResolvedValueOnce({ ok: false, error: "restore refused" } as never);
    await closeBrowserTabWithUndo(api as unknown as BrowserApi, tab, vi.fn());
    await vi.advanceTimersByTimeAsync(5000);
    expect(toastError).toHaveBeenCalledWith("Could not restore Browser Tab: restore refused");
    expect(toastError).toHaveBeenCalledWith("Could not close Browser Tab: disconnected");
    expect(useClosingBrowserTabIds.getState().size).toBe(0);
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { UpdateUiState } from "../../../../../ipc/contract";
import { useUpdateStore } from "@renderer/stores/update";
import { UpdatesPane } from "./updates-pane";

let root: Root;
let host: HTMLDivElement;
const initialStore = useUpdateStore.getState();
function downloaded(version: string): UpdateUiState {
  return {
    supported: true,
    phase: "downloaded",
    currentVersion: "0.1.0",
    targetVersion: version,
    percent: null,
    error: null,
    lastCheck: null,
  };
}
async function render() {
  await act(async () => root.render(<UpdatesPane />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("api", {
    updates: { channel: vi.fn().mockResolvedValue({ ok: true, channel: "stable" }) },
  });
  useUpdateStore.setState(initialStore, true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useUpdateStore.setState(initialStore, true);
  vi.unstubAllGlobals();
});
describe("update ready notice", () => {
  it("remembers a dismissed version across navigation, but offers a newer version", async () => {
    useUpdateStore.getState().receive(downloaded("notice-test-1"));
    await render();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
    expect(host.textContent).not.toContain("is ready");
    act(() => root.render(null));
    await render();
    expect(host.textContent).not.toContain("is ready");
    // Dismissing this transient receipt never hides the update from the store or badge.
    expect(useUpdateStore.getState().state?.phase).toBe("downloaded");
    act(() => useUpdateStore.getState().openDialog());
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    act(() => useUpdateStore.getState().receive(downloaded("notice-test-2")));
    expect(host.textContent).toContain("Volli notice-test-2 is ready");
  });
});

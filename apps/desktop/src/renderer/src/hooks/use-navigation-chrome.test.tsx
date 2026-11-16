// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useProjectShortcuts } from "./use-project-shortcuts";
import { useUiStore } from "@renderer/stores/ui";
import { useProjectsStore } from "@renderer/stores/projects";
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
function Harness() {
  useProjectShortcuts();
  return <div data-scroll />;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStore.setState({ projectRailHidden: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fire(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => window.dispatchEvent(event));
  return event;
}

describe("navigation chrome", () => {
  it("gives rail layout its exact chord while leaving direct project selection intact", async () => {
    const select = vi
      .spyOn(useProjectsStore.getState(), "selectByIndex")
      .mockImplementation(() => {});
    expect((await fire({ key: "S", metaKey: true, shiftKey: true })).defaultPrevented).toBe(true);
    expect(useUiStore.getState().projectRailHidden).toBe(true);
    await fire({ key: "S", metaKey: true, shiftKey: true, repeat: true });
    await fire({ key: "s", ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().projectRailHidden).toBe(true);
    await fire({ key: "s", metaKey: true, shiftKey: true });
    expect(useUiStore.getState().projectRailHidden).toBe(false);
    await fire({ key: "2", metaKey: true });
    expect(select).toHaveBeenCalledExactlyOnceWith(1);
  });
});

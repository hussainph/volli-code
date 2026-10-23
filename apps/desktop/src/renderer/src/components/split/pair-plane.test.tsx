// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  activateTab,
  groupedSplitView,
  pairTabs,
  projectSplitView,
  unpairTab,
} from "@volli/shared";
import { SplitViewGrid } from "./split-view-grid";
import { SplitViewTabBar } from "./split-view-tab-bar";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
  document.body.innerHTML = "";
});

describe("grouped pair plane", () => {
  it("keeps resident browser content mounted across pairing, switching, orientation and unpairing", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const mounts = vi.fn();
    const unmounts = vi.fn();
    function Browser({ id }: { id: string }) {
      React.useEffect(() => {
        mounts(id);
        return () => unmounts(id);
      }, [id]);
      return <input data-browser={id} defaultValue="unsent address" />;
    }
    let state = groupedSplitView([], "browser:a");
    let minted = 0;
    const mint = () => `p${++minted}`;
    const render = () =>
      act(() => {
        root.render(
          <SplitViewGrid
            view={projectSplitView(
              state,
              ["board", "chat:s", "browser:a", "browser:b"],
              state.selectedTabId ?? null,
              "board",
            )}
            retainedTabIds={["browser:a", "browser:b"]}
            renderStrip={() => null}
            renderContent={(pane) =>
              pane.activeTabId?.startsWith("browser:") ? (
                <Browser id={pane.activeTabId} />
              ) : (
                <div>{pane.activeTabId}</div>
              )
            }
            onFocusPane={() => {}}
            onResizeSplit={() => {}}
          />,
        );
      });
    render();
    const original = host.querySelector('[data-browser="browser:a"]');
    state = pairTabs(state, "chat:s", "browser:a", "right", mint);
    render();
    expect(host.querySelectorAll("[data-pane-id]")).toHaveLength(2);
    expect(host.querySelector('[role="separator"]')).not.toBeNull();
    state = activateTab(state, "board");
    render();
    expect(host.querySelectorAll("[data-pane-id]")).toHaveLength(1);
    expect(host.querySelector('[role="separator"]')).toBeNull();
    state = activateTab(state, "browser:a");
    render();
    expect(host.querySelectorAll("[data-pane-id]")).toHaveLength(2);
    state = pairTabs(state, "browser:a", "browser:b", "down", mint);
    render();
    expect(host.querySelector('[role="separator"]')?.getAttribute("aria-orientation")).toBe(
      "horizontal",
    );
    state = unpairTab(state, "browser:a");
    render();
    expect(host.querySelector('[data-browser="browser:a"]')).toBe(original);
    expect(mounts.mock.calls).toEqual([["browser:a"], ["browser:b"]]);
    expect(unmounts).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(unmounts).toHaveBeenCalledTimes(2);
  });
  it("keeps the area strip whole while a pair divides only its content", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    let n = 0;
    const state = pairTabs(
      groupedSplitView([], "board"),
      "board",
      "browser:a",
      "right",
      () => `id${++n}`,
    );
    const view = projectSplitView(state, ["board", "browser:a", "chat:s"], "browser:a", "board");
    const focused = vi.fn();
    act(() =>
      root.render(
        <SplitViewTabBar
          view={view}
          tabs={{ ids: ["board", "browser:a", "chat:s"], activeTabId: "browser:a" }}
          renderStrip={(pane) => <div role="tablist">{pane.tabIds.join(",")}</div>}
          onFocusPane={focused}
          onResizeSplit={() => {}}
        />,
      ),
    );
    expect(host.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(host.textContent).toBe("board,browser:a,chat:s");
    act(() =>
      host
        .querySelector('[role="tablist"]')
        ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
    );
    expect(focused).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

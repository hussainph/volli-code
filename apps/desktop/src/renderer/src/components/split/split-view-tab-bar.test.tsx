// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveSplitView,
  type ResolvedSplitView,
  type SplitViewDirection,
  type SplitViewNode,
} from "@volli/shared";

import { Tab, TabStrip } from "@renderer/components/ui/tab-strip";
import { SplitViewGrid } from "./split-view-grid";
import { SplitViewTabBar } from "./split-view-tab-bar";

const leaf = (id: string, tabIds = [id]): SplitViewNode => ({
  kind: "pane",
  id,
  tabIds,
  activeTabId: tabIds[0] ?? null,
});
const branch = (
  direction: SplitViewDirection,
  first: SplitViewNode,
  second: SplitViewNode,
  ratio = 0.5,
): SplitViewNode => ({
  kind: "split",
  id: `${first.id}-${second.id}`,
  direction,
  first,
  second,
  ratio,
});
const row = (first: SplitViewNode, second: SplitViewNode, ratio = 0.5) =>
  branch("row", first, second, ratio);
const column = (first: SplitViewNode, second: SplitViewNode) => branch("column", first, second);
function resolve(root: SplitViewNode): ResolvedSplitView {
  return resolveSplitView({ root, focusedPaneId: "a" }, ["a", "b", "c", "d"], "a");
}

const strip = (pane: ResolvedSplitView["panes"][number], last = false) => (
  <TabStrip label={`${pane.id} tabs`} actions={last ? <button>New chat</button> : undefined}>
    {pane.tabIds.map((id) => (
      <Tab
        key={id}
        label={id}
        active={id === pane.activeTabId}
        tabStop={id === pane.activeTabId}
        onActivate={() => {}}
      />
    ))}
  </TabStrip>
);

function Surface({ view, railWidth = 0 }: { view: ResolvedSplitView; railWidth?: number }) {
  return (
    <>
      <SplitViewTabBar
        view={view}
        railWidth={railWidth}
        renderStrip={strip}
        onFocusPane={() => {}}
        onResizeSplit={() => {}}
      />
      <SplitViewGrid
        view={view}
        renderStrip={(pane) => (pane.tabIds.length === 0 ? null : strip(pane))}
        renderContent={(pane) => <div data-content={pane.id} />}
        renderOverlay={(pane) => <div data-overlay={pane.id} />}
        onFocusPane={() => {}}
        onResizeSplit={() => {}}
      />
    </>
  );
}
function draw(root: SplitViewNode, railWidth = 0): HTMLDivElement {
  const dom = document.createElement("div");
  dom.innerHTML = renderToStaticMarkup(<Surface view={resolve(root)} railWidth={railWidth} />);
  return dom;
}
const topPaneIds = (dom: Element) =>
  Array.from(dom.querySelectorAll('[data-slot="split-view-tab-pane"]'), (el) =>
    el.getAttribute("data-pane-id"),
  );
const paneSegment = (dom: Element, id: string) =>
  dom.querySelector(`[data-slot="split-view-tab-pane"][data-pane-id="${id}"]`)!;
/** jsdom has no PointerEvent of its own — the stand-in `split-view-divider.test.tsx` builds. */
const press = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
const lowerStripIds = (dom: Element) =>
  Array.from(dom.querySelectorAll('[data-slot="split-view-pane"] [role="tablist"]'), (el) =>
    el.getAttribute("aria-label"),
  );

describe("SplitViewTabBar", () => {
  it.each([
    ["unsplit", leaf("a"), ["a"], []],
    ["right", row(leaf("a"), leaf("b")), ["a", "b"], []],
    ["down", column(leaf("a"), leaf("b")), ["a"], ["b tabs"]],
    ["right then down", row(leaf("a"), column(leaf("b"), leaf("c"))), ["a", "b"], ["c tabs"]],
    [
      "down then right",
      column(row(leaf("a"), leaf("b")), row(leaf("c"), leaf("d"))),
      ["a", "b"],
      ["c tabs", "d tabs"],
    ],
    [
      "down in both columns",
      row(column(leaf("a"), leaf("b")), column(leaf("c"), leaf("d"))),
      ["a", "c"],
      ["b tabs", "d tabs"],
    ],
  ] as const)(
    "partitions %s into the main bar and only lower pane strips",
    (_name, root, top, lower) => {
      const dom = draw(root);
      expect(topPaneIds(dom)).toEqual(top);
      expect(lowerStripIds(dom)).toEqual(lower);
      // Every live tab is drawn exactly once; no duplicate/nested top-edge strip.
      const tabs = Array.from(dom.querySelectorAll('[role="tab"]'), (tab) => tab.textContent);
      expect(new Set(tabs).size).toBe(tabs.length);
      expect(tabs.toSorted()).toEqual(["a", "b", "c", "d"]);
      expect(dom.querySelectorAll("button:not([role=tab])")).toHaveLength(1);
      const actionsPane = dom.querySelector("button:not([role=tab])")!.closest("[data-pane-id]");
      expect(actionsPane?.getAttribute("data-pane-id")).toBe(top.at(-1));
    },
  );

  it("reserves the rail's width, extending only the trailing strip over it", () => {
    const dom = draw(row(row(leaf("a"), leaf("b"), 0.3), leaf("c"), 0.6), 320);
    const bar = dom.querySelector<HTMLElement>('[data-slot="split-view-tab-bar"]')!;
    expect(bar.style.paddingRight).toBe("320px");
    const strips = Array.from(
      bar.querySelectorAll<HTMLElement>('[data-slot="split-view-tab-pane"]'),
    );
    expect(strips.map((element) => element.style.marginRight)).toEqual(["", "", "-320px"]);
    // Main bar and plane use the same branch arithmetic, including nested ratios.
    for (const share of [30, 60]) {
      expect(dom.innerHTML.split(`flex:0 0 calc(${share}% - 3px)`).length - 1).toBe(2);
    }
  });

  it("keeps an empty lower pane free of tab chrome and overlays inside content", () => {
    const dom = draw(column(leaf("a"), leaf("empty", [])));
    expect(lowerStripIds(dom)).toEqual([]);
    const empty = dom.querySelector('[data-slot="split-view-pane"][data-pane-id="empty"]')!;
    expect(empty.querySelector('[data-content="empty"]')).not.toBeNull();
    for (const overlay of dom.querySelectorAll("[data-overlay]")) {
      expect(overlay.parentElement?.querySelector('[role="tablist"]')).toBeNull();
    }
  });

  it("routes main-bar resizing to the same split id without focusing another pane", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const resize = vi.fn();
    try {
      act(() =>
        root.render(
          <SplitViewTabBar
            view={resolve(row(leaf("a"), leaf("b")))}
            renderStrip={(pane) => pane.id}
            onFocusPane={() => {}}
            onResizeSplit={resize}
          />,
        ),
      );
      act(() =>
        container
          .querySelector('[data-slot="split-view-divider"]')!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
      );
      expect(resize).toHaveBeenCalledWith("a-b", 0.53);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("announces one grip per seam: the plane's, not the bar's second copy", () => {
    const dom = draw(row(leaf("a"), leaf("b")));
    const grips = dom.querySelectorAll('[data-slot="split-view-divider"]');
    // Both halves of the seam are draggable...
    expect(grips).toHaveLength(2);
    // ...but only the plane's is a separator AT can reach or tab to.
    expect(dom.querySelectorAll('[role="separator"]')).toHaveLength(1);
    const bar = dom.querySelector('[data-slot="split-view-tab-bar"]')!;
    const barGrip = bar.querySelector('[data-slot="split-view-divider"]')!;
    expect(barGrip.getAttribute("aria-hidden")).toBe("true");
    expect(barGrip.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps an empty top-edge segment as a plain band, not an empty tablist", () => {
    // `b` is empty and not last, `c` is empty and last: only `c` draws a strip,
    // because that is where the surface's actions live.
    const dom = draw(row(leaf("a"), row(leaf("b", []), leaf("c", []))));
    expect(topPaneIds(dom)).toEqual(["a", "b", "c"]);
    expect(paneSegment(dom, "b").querySelector('[role="tablist"]')).toBeNull();
    // It still owes the bar its bottom edge, which the strip would have drawn.
    expect(paneSegment(dom, "b").className).toContain("border-b");
    expect(paneSegment(dom, "c").querySelector("button:not([role=tab])")).not.toBeNull();
  });

  it("raises pane focus from the bar, except on the surface-wide actions", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const focus = vi.fn();
    try {
      act(() =>
        root.render(
          <SplitViewTabBar
            view={resolve(row(leaf("a"), leaf("b")))}
            renderStrip={strip}
            onFocusPane={focus}
            onResizeSplit={() => {}}
          />,
        ),
      );
      // The blank space beside a pane's tabs is still that pane.
      press(paneSegment(container, "b"));
      expect(focus).toHaveBeenLastCalledWith("b");
      press(paneSegment(container, "a").querySelector('[role="tab"]')!);
      expect(focus).toHaveBeenLastCalledWith("a");

      // The trailing cluster acts on the surface and opens into the focused
      // pane, so pressing it must not first move focus to the pane it sits in.
      focus.mockClear();
      press(paneSegment(container, "b").querySelector("button:not([role=tab])")!);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});

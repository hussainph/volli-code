// @vitest-environment jsdom
/**
 * ⌃⌘ + an arrow pressed inside a Browser page (VC-301), through the real split
 * chord listener and the real project UI store.
 *
 * The subject is the seam: a click into the native page never reaches the
 * renderer, so the split view's focused pane is whichever one was last clicked
 * in the app. The chord replayed from the page has to move from the pane that
 * draws the page instead.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { projectSplitView, SPLIT_VIEW_ROOT_PANE_ID, splitViewPanes } from "@volli/shared";

import {
  registerBrowserPaneCommands,
  runBrowserAppShortcut,
} from "@renderer/components/browser/browser-app-shortcuts";
import { browserTabId } from "@renderer/components/home/home-tabs";
import { useProjectsStore } from "@renderer/stores/projects";
import { DEFAULT_PROJECT_UI, useProjectUiStore } from "@renderer/stores/project-ui";

import { useSplitShortcuts } from "./use-split-shortcuts";

const PROJECT = "project-1";
const LEFT = browserTabId("tab-left");
const RIGHT = browserTabId("tab-right");
const STRIP = [LEFT, RIGHT];

let container: HTMLDivElement;
let root: Root;
let unregister: (() => void) | null = null;

function Probe(): null {
  // What the surface hands the hook: the pane it DRAWS in focus, and its front.
  const ui = useProjectUiStore((state) => state.byProject[PROJECT]);
  const view = projectSplitView(
    ui?.homeSplitView ?? null,
    ["board", ...STRIP],
    ui?.homeActiveTab ?? "board",
    "board",
  );
  useSplitShortcuts({
    projectId: PROJECT,
    ticketId: null,
    paneId: view.focusedPaneId,
    targetTabId: view.activeTabId,
  });
  return null;
}

function split() {
  const state = useProjectUiStore.getState().byProject[PROJECT]?.homeSplitView;
  if (state === null || state === undefined) throw new Error("expected a Home split");
  return state;
}

/** The pane holding one tab, by id. */
function paneOf(tabId: string): string {
  const pane = splitViewPanes(split()).find((candidate) => candidate.tabIds.includes(tabId));
  if (pane === undefined) throw new Error(`no pane holds ${tabId}`);
  return pane.id;
}

/** ⌃⌘← as main hands it back from the right member's page. */
function pressLeftInRightPage(): boolean {
  return runBrowserAppShortcut({
    tabId: "tab-right",
    shortcut: {
      kind: "replay",
      chord: {
        key: "ArrowLeft",
        code: "ArrowLeft",
        metaKey: true,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        repeat: false,
      },
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useProjectsStore.setState({ selectedProjectId: PROJECT });
  useProjectUiStore.setState({
    byProject: { [PROJECT]: { ...DEFAULT_PROJECT_UI, nav: "home", homeActiveTab: LEFT } },
  } as never);
  // One group of two Browser Tabs, side by side.
  const workspace = useProjectUiStore.getState();
  workspace.splitHomePane(PROJECT, SPLIT_VIEW_ROOT_PANE_ID, "right", { tabId: RIGHT });
  // The last pane clicked IN THE APP was the left one; the person then clicked
  // into the right member's native page, which the split view never heard.
  workspace.focusHomePane(PROJECT, paneOf(LEFT));

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  unregister?.();
  unregister = null;
  act(() => root.unmount());
  container.remove();
  useProjectUiStore.setState({ byProject: {} } as never);
  useProjectsStore.setState({ selectedProjectId: null });
  vi.unstubAllGlobals();
});

describe("⌃⌘ + an arrow from inside a Browser page", () => {
  it("moves from the pane drawing the page, not the pane last clicked in the app", () => {
    // The surface's wiring: BrowserPane's onFocusPane is focusHomePane(pane).
    unregister = registerBrowserPaneCommands("tab-right", {
      close: () => true,
      focusAddress: () => undefined,
      focusPane: () => useProjectUiStore.getState().focusHomePane(PROJECT, paneOf(RIGHT)),
    });

    const focused: string[] = [];
    const unsubscribe = useProjectUiStore.subscribe(() => focused.push(split().focusedPaneId));
    const right = paneOf(RIGHT);
    const left = paneOf(LEFT);
    try {
      expect(pressLeftInRightPage()).toBe(true);
      // The final pane alone cannot prove the origin with just two panes:
      // without the handoff, left-at-left would also end on the left. Observe
      // the real store transitions: focus the page's member, then move left.
      expect(focused).toEqual([right, left]);
      expect(split().focusedPaneId).toBe(left);
    } finally {
      unsubscribe();
    }
  });

  it("would stay at the stale pane without the native-page focus handoff", () => {
    // No pane registered for the page: the chord starts from the stale pane.
    expect(pressLeftInRightPage()).toBe(true);

    expect(split().focusedPaneId).toBe(paneOf(LEFT));
  });

  it("reports the chord as unclaimed while no group is shown, so focus goes back to the page", () => {
    useProjectUiStore.setState({
      byProject: { [PROJECT]: { ...DEFAULT_PROJECT_UI, nav: "home", homeActiveTab: RIGHT } },
    } as never);

    expect(pressLeftInRightPage()).toBe(false);
  });
});

/** ⌘\\ pressed with nothing focused but the window. */
function pressSplit(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "\\", code: "Backslash", metaKey: true }),
    );
  });
}

describe("⌘\\ splits the pane the surface draws in focus (VC-614)", () => {
  it("splits a shown group's focused pane, growing the group past two", () => {
    pressSplit();
    expect(splitViewPanes(split()).map((pane) => pane.tabIds)).toEqual([[LEFT], [], [RIGHT]]);
    expect(split().pairs).toHaveLength(1);
  });

  it("makes a new group of two from a full-width tab, its new pane an empty menu", () => {
    act(() => useProjectUiStore.getState().setHomeActiveTab(PROJECT, "board"));
    pressSplit();
    expect(split().pairs).toHaveLength(2);
    expect(splitViewPanes(split()).map((pane) => pane.tabIds)).toEqual([["board"], []]);
  });
});

/** A focused empty pane's cell, with its menu row named `label`. */
function FocusedEmptyCell({ label }: { label: string }): React.ReactElement {
  return (
    <div data-slot="split-view-pane" data-pane-id="pane-new" data-focused="true">
      <button type="button" data-slot="pane-empty-row" aria-label={label} />
    </div>
  );
}

/**
 * Two planes' cells, the way the app holds them while a Ticket view has taken
 * Home over: Home's first in document order, kept mounted behind
 * `<Activity mode="hidden">` (VC-1080), then the one in front.
 */
function Planes(): React.ReactElement {
  return (
    <>
      <React.Activity mode="hidden">
        <FocusedEmptyCell label="hidden plane" />
      </React.Activity>
      <FocusedEmptyCell label="plane in front" />
    </>
  );
}

/**
 * jsdom has neither layout nor `checkVisibility`; this models what Chromium
 * answers — hidden under any `display: none` ancestor, which is how
 * `<Activity mode="hidden">` hides its host nodes.
 */
function modelCheckVisibility(this: Element): boolean {
  for (
    let node: Element | null = this as Element | null;
    node !== null;
    node = node.parentElement
  ) {
    if (node instanceof HTMLElement && node.style.display === "none") return false;
  }
  return true;
}

describe("⌘\\ focuses the new pane's menu in the plane in front (VC-1102)", () => {
  it("skips the hidden plane's focused empty pane", () => {
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
      run(0);
      return 0;
    });
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "checkVisibility");
    Element.prototype.checkVisibility = modelCheckVisibility;
    const planes = document.createElement("div");
    document.body.append(planes);
    const planesRoot = createRoot(planes);
    try {
      act(() => planesRoot.render(<Planes />));
      pressSplit();
      expect(document.activeElement?.getAttribute("aria-label")).toBe("plane in front");
    } finally {
      act(() => planesRoot.unmount());
      planes.remove();
      if (original === undefined) {
        delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
      } else {
        Object.defineProperty(Element.prototype, "checkVisibility", original);
      }
    }
  });
});

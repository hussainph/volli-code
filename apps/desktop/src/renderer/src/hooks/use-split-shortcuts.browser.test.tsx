// @vitest-environment jsdom
/**
 * ⌃⌘ + an arrow pressed inside a Browser page (VC-301), through the real split
 * chord listener and the real workspace store.
 *
 * The subject is the seam: a click into the native page never reaches the
 * renderer, so the split view's focused pane is whichever one was last clicked
 * in the app. The chord replayed from the page has to move from the pane that
 * draws the page instead.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SPLIT_VIEW_ROOT_PANE_ID, splitViewPanes } from "@volli/shared";

import {
  registerBrowserPaneCommands,
  runBrowserAppShortcut,
} from "@renderer/components/browser/browser-app-shortcuts";
import { browserTabId } from "@renderer/components/home/home-tabs";
import { useProjectsStore } from "@renderer/stores/projects";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import { useSplitShortcuts } from "./use-split-shortcuts";

const PROJECT = "project-1";
const LEFT = browserTabId("tab-left");
const RIGHT = browserTabId("tab-right");
const STRIP = [LEFT, RIGHT];

let container: HTMLDivElement;
let root: Root;
let unregister: (() => void) | null = null;

function Probe(): null {
  useSplitShortcuts({ projectId: PROJECT, ticketId: null, orderedTabIds: STRIP });
  return null;
}

function split() {
  const state = useWorkspaceStore.getState().byProject[PROJECT]?.homeSplitView;
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
  useWorkspaceStore.setState({
    byProject: { [PROJECT]: { ...DEFAULT_WORKSPACE_UI, nav: "home", homeActiveTab: LEFT } },
  } as never);
  // One bounded pair. A second split cannot create a third pane (VC-614).
  const workspace = useWorkspaceStore.getState();
  workspace.splitHomePane(PROJECT, SPLIT_VIEW_ROOT_PANE_ID, "right", {
    tabId: RIGHT,
    surfaceTabIds: STRIP,
  });
  // The last pane clicked IN THE APP was the left one; the person then clicked
  // into the right member's native page, which the split view never heard.
  workspace.focusHomePane(PROJECT, SPLIT_VIEW_ROOT_PANE_ID);

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
  useWorkspaceStore.setState({ byProject: {} } as never);
  useProjectsStore.setState({ selectedProjectId: null });
  vi.unstubAllGlobals();
});

describe("⌃⌘ + an arrow from inside a Browser page", () => {
  it("moves from the pane drawing the page, not the pane last clicked in the app", () => {
    // The surface's wiring: BrowserPane's onFocusPane is focusHomePane(pane).
    unregister = registerBrowserPaneCommands("tab-right", {
      close: () => true,
      focusAddress: () => undefined,
      focusPane: () => useWorkspaceStore.getState().focusHomePane(PROJECT, paneOf(RIGHT)),
    });

    const focused: string[] = [];
    const unsubscribe = useWorkspaceStore.subscribe(() => focused.push(split().focusedPaneId));
    const right = paneOf(RIGHT);
    const left = paneOf(LEFT);
    try {
      expect(pressLeftInRightPage()).toBe(true);
      // The final pane alone cannot prove the origin with just two members:
      // without the handoff, left-at-left would also end on the left. Observe
      // the real store transitions: focus the page's member, then move left.
      expect(focused).toEqual([right, left]);
      expect(split().focusedPaneId).toBe(left);
    } finally {
      unsubscribe();
    }
  });

  it("would stay at the stale member without the native-page focus handoff", () => {
    // No pane registered for the page: the chord starts from the stale pane.
    expect(pressLeftInRightPage()).toBe(true);

    expect(split().focusedPaneId).toBe(paneOf(LEFT));
  });

  it("reports the chord as unclaimed when the surface is not split, so focus goes back to the page", () => {
    useWorkspaceStore.setState({
      byProject: { [PROJECT]: { ...DEFAULT_WORKSPACE_UI, nav: "home", homeActiveTab: RIGHT } },
    } as never);

    expect(pressLeftInRightPage()).toBe(false);
  });
});

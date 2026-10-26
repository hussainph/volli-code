// @vitest-environment jsdom
import {
  claimTabInPane,
  emptySplitView,
  focusPane,
  groupForTab,
  paneForTab,
  selectTab,
  splitPane,
  SPLIT_VIEW_ROOT_PANE_ID,
  type SplitViewState,
} from "@volli/shared";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { appStateStorage } from "./app-state-storage";
import { placementPaneId, registerProvisionalPaneHost } from "./provisional-pane-commit";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProvisionalPaneLayoutStore } from "@renderer/stores/provisional-pane-layout";

beforeEach(() => {
  vi.spyOn(appStateStorage, "setItem").mockImplementation(() => undefined);
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {} });
  useChatDraftsStore.setState({ drafts: {} });
  useProvisionalPaneLayoutStore.setState({ byOwner: new Map() });
});
afterEach(() => {
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {} });
  useChatDraftsStore.setState({ drafts: {} });
  vi.restoreAllMocks();
});

it("retains an earned claim without a host and retries until a registered layout can save it", () => {
  const drafts = useChatDraftsStore.getState();
  drafts.openProvisional("late", {
    projectId: "project",
    ticketId: "owner",
    title: null,
    operationId: "op",
  });
  useChatSessionsStore.getState().openChatTab("owner", "late");
  useChatSessionsStore.getState().setProvisionalActive("owner", "late");
  useProvisionalPaneLayoutStore.getState().place("owner", "late", "secondary");
  drafts.setDraft("late", "content before registration");
  expect(useProvisionalPaneLayoutStore.getState().byOwner.get("owner")?.has("late")).toBe(true);
  // A group of `owner` beside an empty pane, "secondary", the Draft was placed in.
  const ids = ["secondary", "group", "anchor"];
  let split: SplitViewState = splitPane(
    emptySplitView("owner"),
    SPLIT_VIEW_ROOT_PANE_ID,
    "right",
    {},
    () => ids.shift()!,
  );
  const refuse = vi.fn();
  const detach = registerProvisionalPaneHost("owner", {
    readSplitView: () => split,
    claimTab: refuse,
  });
  expect(refuse).toHaveBeenCalledWith("chat:late", "secondary", true);
  expect(useProvisionalPaneLayoutStore.getState().byOwner.get("owner")?.has("late")).toBe(true);
  const accept = vi.fn((tabId: string, paneId: string, front: boolean) => {
    split = claimTabInPane(split, tabId, paneId, front);
  });
  const detachSecond = registerProvisionalPaneHost("owner", {
    readSplitView: () => split,
    claimTab: accept,
  });
  expect(paneForTab(split, "chat:late")).toBe("secondary");
  expect(useProvisionalPaneLayoutStore.getState().byOwner.has("owner")).toBe(false);
  expect(useChatSessionsStore.getState().provisionalActive.owner).toBeUndefined();
  detach();
  detachSecond();
  // An unrelated store update is not another content arrival.
  useChatDraftsStore.setState({ drafts: useChatDraftsStore.getState().drafts });
  expect(accept).toHaveBeenCalledTimes(1);
});

/** [owner] | [browser] — `n1` is the browser's pane, `n3` the owner's. */
function ownerBesideBrowser(): SplitViewState {
  let sequence = 0;
  return splitPane(
    emptySplitView("owner"),
    SPLIT_VIEW_ROOT_PANE_ID,
    "right",
    { tabId: "browser" },
    () => `n${++sequence}`,
  );
}

for (const front of [false, true]) {
  it(`claims a ${front ? "foreground" : "background"} Draft into its group pane's stack, never retrying`, () => {
    let split = ownerBesideBrowser();
    const drafts = useChatDraftsStore.getState();
    drafts.openProvisional("stacked", {
      projectId: "project",
      ticketId: "owner",
      title: null,
      operationId: "op",
    });
    useChatSessionsStore.getState().openChatTab("owner", "stacked");
    useProvisionalPaneLayoutStore.getState().place("owner", "stacked", "n1");
    if (!front) useProvisionalPaneLayoutStore.getState().deactivatePanes("owner", new Set(["n1"]));
    const select = vi.fn();
    const claim = vi.fn((tabId: string, paneId: string, active: boolean) => {
      split = claimTabInPane(split, tabId, paneId, active);
    });
    const detach = registerProvisionalPaneHost("owner", {
      readSplitView: () => split,
      claimTab: claim,
      activateTab: select,
    });
    drafts.setDraft("stacked", "content");
    expect(claim).toHaveBeenCalledExactlyOnceWith("chat:stacked", "n1", front);
    expect(paneForTab(split, "chat:stacked")).toBe("n1");
    expect(split.selectedTabId).toBe(front ? "chat:stacked" : "browser");
    expect(select).not.toHaveBeenCalled();
    expect(useProvisionalPaneLayoutStore.getState().byOwner.has("owner")).toBe(false);
    drafts.setDraft("stacked", "more content");
    expect(claim).toHaveBeenCalledTimes(1);
    detach();
  });
}

for (const shown of [false, true]) {
  it(`retires a full-width Draft as an ordinary tab${shown ? ", selecting it while it is in front" : " behind the group on screen"}`, () => {
    let split = shown
      ? selectTab(ownerBesideBrowser(), "ordinary")
      : selectTab(ownerBesideBrowser(), "browser");
    const drafts = useChatDraftsStore.getState();
    drafts.openProvisional("plain", {
      projectId: "project",
      ticketId: "owner",
      title: null,
      operationId: "op",
    });
    useChatSessionsStore.getState().openChatTab("owner", "plain");
    // Placed full width, in a pane no group has (a group that has since gone).
    useProvisionalPaneLayoutStore.getState().place("owner", "plain", "gone");
    const select = vi.fn((tabId: string) => {
      split = selectTab(split, tabId);
    });
    const claim = vi.fn((tabId: string, paneId: string, active: boolean) => {
      split = claimTabInPane(split, tabId, paneId, active);
    });
    const detach = registerProvisionalPaneHost("owner", {
      readSplitView: () => split,
      claimTab: claim,
      activateTab: select,
    });
    drafts.setDraft("plain", "content");
    expect(claim).toHaveBeenCalledExactlyOnceWith("chat:plain", SPLIT_VIEW_ROOT_PANE_ID, true);
    expect(groupForTab(split, "chat:plain")).toBeNull();
    expect(select).toHaveBeenCalledTimes(shown ? 1 : 0);
    expect(split.selectedTabId).toBe(shown ? "chat:plain" : "browser");
    expect(useProvisionalPaneLayoutStore.getState().byOwner.has("owner")).toBe(false);
    detach();
  });
}

it("recognizes a hidden group's pane as a real destination rather than aliasing it to root", () => {
  const hidden = selectTab(ownerBesideBrowser(), "unrelated");
  expect(hidden.root.kind).toBe("pane");
  expect(placementPaneId(hidden, "n1")).toBe("n1");
  expect(placementPaneId(hidden, "closed")).toBe("root");
  expect(placementPaneId(null, "n1")).toBe("root");
});

for (const hidden of [false, true]) {
  it(`commits a Draft after unmount${hidden ? " into a hidden group without selecting it" : " without moving focus"}`, () => {
    let split = ownerBesideBrowser();
    const draft = useChatDraftsStore.getState();
    draft.openProvisional("left-draft", {
      projectId: "project",
      ticketId: "owner",
      title: null,
      operationId: "left-op",
    });
    useChatSessionsStore.getState().openChatTab("owner", "left-draft");
    useProvisionalPaneLayoutStore.getState().place("owner", "left-draft", "n3");
    split = focusPane(split, "n1");
    if (hidden) split = selectTab(split, "ordinary");
    const before = split;
    const claim = vi.fn((tabId: string, paneId: string, active: boolean) => {
      split = claimTabInPane(split, tabId, paneId, active);
    });
    const detach = registerProvisionalPaneHost("owner", {
      readSplitView: () => split,
      claimTab: claim,
    });
    detach();
    draft.setDraftAttachments("left-draft", [
      {
        linkId: null,
        blobHash: "a".repeat(64),
        label: "x.txt",
        originalName: "x.txt",
        mime: "text/plain",
        sizeBytes: 1,
      },
    ]);
    expect(claim).toHaveBeenCalledExactlyOnceWith("chat:left-draft", "n3", true);
    expect(paneForTab(split, "chat:left-draft")).toBe("n3");
    expect(split.focusedPaneId).toBe(before.focusedPaneId);
    expect(split.selectedTabId).toBe(before.selectedTabId);
    expect(useProvisionalPaneLayoutStore.getState().byOwner.has("owner")).toBe(false);
  });
}

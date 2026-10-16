// @vitest-environment jsdom
import {
  activateTab,
  claimTabInPane,
  groupedSplitView,
  focusPane,
  pairTabs,
  pairForTab,
  paneForTab,
  singlePaneSplitView,
  splitPane,
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
  let split: SplitViewState = splitPane(
    singlePaneSplitView([], null, "root"),
    "root",
    "right",
    {},
    () => "secondary",
  );
  const refuse = vi.fn();
  const detach = registerProvisionalPaneHost("owner", {
    readSplitView: () => split,
    claimTab: refuse,
  });
  expect(refuse).toHaveBeenCalledWith("chat:late", "secondary", true);
  expect(useProvisionalPaneLayoutStore.getState().byOwner.get("owner")?.has("late")).toBe(true);
  const accept = vi.fn((tabId: string) => {
    split = activateTab(split, tabId);
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

for (const front of [false, true]) {
  it(`retires a grouped ${front ? "foreground occupied" : "inactive"} claim as ordinary instead of retrying a hidden pane stack`, () => {
    let sequence = 0;
    let split = pairTabs(
      groupedSplitView([], "owner"),
      "owner",
      "browser",
      "right",
      () => `n${++sequence}`,
    );
    const drafts = useChatDraftsStore.getState();
    drafts.openProvisional("ordinary", {
      projectId: "project",
      ticketId: "owner",
      title: null,
      operationId: "op",
    });
    useChatSessionsStore.getState().openChatTab("owner", "ordinary");
    useProvisionalPaneLayoutStore.getState().place("owner", "ordinary", "n1");
    if (!front) useProvisionalPaneLayoutStore.getState().deactivatePanes("owner", new Set(["n1"]));
    const select = vi.fn((tabId: string) => {
      split = activateTab(split, tabId);
    });
    const claim = vi.fn((tabId: string, paneId: string, active: boolean) => {
      split = claimTabInPane(split, tabId, paneId, active);
    });
    const detach = registerProvisionalPaneHost("owner", {
      readSplitView: () => split,
      claimTab: claim,
      activateTab: select,
    });
    drafts.setDraft("ordinary", "content");
    expect(claim).toHaveBeenCalledExactlyOnceWith("chat:ordinary", "n1", front);
    expect(pairForTab(split, "chat:ordinary")).toBeNull();
    expect(pairForTab(split, "browser")).not.toBeNull();
    expect(select).toHaveBeenCalledTimes(front ? 1 : 0);
    expect(split.selectedTabId).toBe(front ? "chat:ordinary" : "browser");
    expect(useProvisionalPaneLayoutStore.getState().byOwner.has("owner")).toBe(false);
    drafts.setDraft("ordinary", "more content");
    expect(claim).toHaveBeenCalledTimes(1);
    detach();
  });
}

it("recognizes a hidden pending partner as a real destination rather than aliasing it to the visible root", () => {
  let sequence = 0;
  const pending = pairTabs(
    groupedSplitView([], "owner"),
    "owner",
    null,
    "right",
    () => `n${++sequence}`,
  );
  const hidden = activateTab(activateTab(pending, "browser"), "unrelated");
  expect(hidden.root.kind).toBe("pane");
  expect(placementPaneId(hidden, "n1")).toBe("n1");
  expect(placementPaneId(hidden, "closed")).toBe("root");
  expect(placementPaneId(null, "n1")).toBe("root");
});

for (const hidden of [false, true]) {
  it(`commits a left-hand local Draft after unmount${hidden ? " into a hidden pair without selecting it" : " without moving anchor focus"}`, () => {
    let sequence = 0;
    let split = pairTabs(
      groupedSplitView([], "browser"),
      null,
      "browser",
      "right",
      () => `left${++sequence}`,
    );
    const pair = split.pairs![0]!;
    const draft = useChatDraftsStore.getState();
    draft.openProvisional("left-draft", {
      projectId: "project",
      ticketId: "owner",
      title: null,
      operationId: "left-op",
    });
    useChatSessionsStore.getState().openChatTab("owner", "left-draft");
    useProvisionalPaneLayoutStore.getState().place("owner", "left-draft", pair.first.id);
    split = focusPane(split, pair.second.id);
    if (hidden) split = activateTab(split, "ordinary");
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
    expect(claim).toHaveBeenCalledExactlyOnceWith("chat:left-draft", pair.first.id, true);
    expect(pairForTab(split, "chat:left-draft")?.first.id).toBe(pair.first.id);
    expect(split.focusedPaneId).toBe(before.focusedPaneId);
    expect(split.selectedTabId).toBe(before.selectedTabId);
    expect(useProvisionalPaneLayoutStore.getState().byOwner.has("owner")).toBe(false);
  });
}

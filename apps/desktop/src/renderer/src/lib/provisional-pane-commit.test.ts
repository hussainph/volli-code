// @vitest-environment jsdom
import {
  activateTab,
  paneForTab,
  singlePaneSplitView,
  splitPane,
  type SplitViewState,
} from "@volli/shared";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { appStateStorage } from "./app-state-storage";
import { registerProvisionalPaneHost } from "./provisional-pane-commit";
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

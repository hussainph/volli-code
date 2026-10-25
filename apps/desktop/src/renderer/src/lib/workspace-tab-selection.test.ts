import { emptySplitView, splitPane } from "@volli/shared";
import { expect, it, vi } from "vite-plus/test";

import {
  publishWorkspaceTabSelection,
  subscribeWorkspaceTabSelection,
} from "./workspace-tab-selection";

it("delivers selection intent only to its owner and resolves existing or newly opened tab destinations", () => {
  const a = vi.fn();
  const b = vi.fn();
  const c = vi.fn();
  const stopA = subscribeWorkspaceTabSelection("a", a);
  const stopB = subscribeWorkspaceTabSelection("a", b);
  const stopC = subscribeWorkspaceTabSelection("c", c);
  // A group of two: chat:old's pane, and the empty pane ⌘\ opened and focused.
  const ids = ["opened", "group", "old"];
  const split = splitPane(emptySplitView("chat:old"), "root", "right", {}, () => ids.shift()!);
  publishWorkspaceTabSelection("a", "chat:old", split);
  expect(a).toHaveBeenLastCalledWith("old");
  expect(b).toHaveBeenLastCalledWith("old");
  expect(c).not.toHaveBeenCalled();
  // A tab no group holds was opened where the focus is.
  publishWorkspaceTabSelection("a", "chat:new", split);
  expect(a).toHaveBeenLastCalledWith("opened");
  stopA();
  publishWorkspaceTabSelection("a", "chat:new", null);
  expect(a).toHaveBeenCalledTimes(2);
  expect(b).toHaveBeenLastCalledWith("root");
  stopB();
  stopC();
  publishWorkspaceTabSelection("a", "chat:old", split);
  publishWorkspaceTabSelection("absent", "chat:new", null);
  expect(b).toHaveBeenCalledTimes(3);
});

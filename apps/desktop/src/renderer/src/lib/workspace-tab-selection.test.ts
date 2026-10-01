import { singlePaneSplitView, splitPane } from "@volli/shared";
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
  const split = splitPane(
    singlePaneSplitView(["chat:old"], "chat:old", "root"),
    "root",
    "right",
    {},
    () => "right",
  );
  publishWorkspaceTabSelection("a", "chat:old", split);
  expect(a).toHaveBeenLastCalledWith("root");
  expect(b).toHaveBeenLastCalledWith("root");
  expect(c).not.toHaveBeenCalled();
  publishWorkspaceTabSelection("a", "chat:new", split);
  expect(a).toHaveBeenLastCalledWith("right");
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

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useHomeTabReceipt } from "./use-home-tab-receipt";

type Receipt = Parameters<typeof useHomeTabReceipt>[0];
function Harness({ receipt }: { receipt: Receipt }) {
  useHomeTabReceipt(receipt);
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("only records a settled, changed, nonempty fallback without a focused overlay", () => {
  const recordResolvedTab = vi.fn();
  const base: Receipt = {
    projectId: "project",
    provisionalActive: null,
    emptyTabIds: new Set(),
    restoreKind: "settled",
    activeTabId: "chat:real",
    recordedTab: "chat:closed",
    recordResolvedTab,
  };
  const cases: Partial<Receipt>[] = [
    { projectId: null },
    { provisionalActive: "draft" },
    { emptyTabIds: new Set(["chat:real"]) },
    { restoreKind: "pending" },
    { restoreKind: "adopt" },
    { recordedTab: "chat:real" },
  ];
  for (const receipt of cases)
    act(() => root.render(<Harness receipt={{ ...base, ...receipt }} />));
  expect(recordResolvedTab).not.toHaveBeenCalled();
  act(() => root.render(<Harness receipt={base} />));
  expect(recordResolvedTab).toHaveBeenCalledExactlyOnceWith("project", "chat:real");
});

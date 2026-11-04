// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerChips } from "./composer-chips";

vi.mock("./composer-labels", () => ({ ComposerLabels: () => null }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function Preview() {
  const [usesWorktree, setWorktree] = useState(true);
  const [createMore, setMore] = useState(false);
  const branch: ComponentProps<typeof ComposerChips>["branch"] = {
    state: { status: "loading" },
    baseBranch: "main",
    onBaseBranchChange: () => {},
    usesWorktree,
    onUsesWorktreeChange: setWorktree,
  };
  return (
    <ComposerChips
      projectId="p1"
      status="todo"
      onStatusChange={() => {}}
      priority="medium"
      onPriorityChange={() => {}}
      labels={[]}
      onLabelsChange={() => {}}
      branch={branch}
      createMore={createMore}
      onCreateMoreChange={setMore}
    />
  );
}
it("offers both working copies directly, hiding the base when it has no worktree to branch", async () => {
  await act(async () => root.render(<Preview />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Ticket options"]')!.click(),
  );
  const panel = document.querySelector('[data-slot="popover-content"]')!;
  const radios = panel.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect(radios).toHaveLength(2);
  expect(radios[0].checked).toBe(true);
  expect(panel.textContent).toContain("New worktree");
  expect(panel.textContent).toContain("Project checkout");
  expect(panel.querySelector('[aria-label="Base branch: main"]')).not.toBeNull();
  await act(async () => radios[1].click());
  expect(radios[1].checked).toBe(true);
  expect(panel.querySelector('[aria-label="Base branch: main"]')).toBeNull();
  expect(host.textContent).toContain("Project checkout");
  expect(document.querySelector('[data-slot="popover-content"]')).toBe(panel);
});
it("keeps batch-entry state visible after dismissing Options", async () => {
  await act(async () => root.render(<Preview />));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Ticket options"]')!;
  await act(async () => trigger.click());
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Create more"]')!.click(),
  );
  expect(host.textContent).toContain("Create more");
  await act(async () => trigger.click());
  expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  expect(host.textContent).toContain("Create more");
});

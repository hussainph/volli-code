// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { CircleIcon } from "./icon";
import { ViewSwitcher } from "./view-switcher";

const modes = [
  { key: "first", label: "First" },
  { key: "second", label: "Second" },
] as const;
function drawing(variant: "text" | "selected-label" | "icon-only") {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    <ViewSwitcher
      modes={
        variant === "text"
          ? modes
          : modes.map((mode) => ({ key: mode.key, label: mode.label, icon: CircleIcon }))
      }
      active="first"
      label="Pages"
      variant={variant}
      onSelect={() => {}}
    />,
  );
  return root;
}
it("retains the inspector's selected-label drawing for in-page icon choices", () => {
  const root = drawing("selected-label");
  expect(root.querySelectorAll("svg")).toHaveLength(2);
  expect(root.querySelectorAll('[data-slot="view-switcher-label"]')).toHaveLength(1);
  expect(root.querySelector('[aria-selected="true"]')?.className).toContain("w-[84px]");
  expect(root.querySelector('[role="tablist"]')?.className).toContain("glass");
});
it("retains the inspector's regular track and target geometry", () => {
  const regular = drawing("selected-label");
  expect(regular.querySelector('[role="tablist"]')?.className).toContain("p-1");
  expect(regular.querySelector('[aria-selected="true"]')?.className).toContain("h-8");
});
it("offers the receiving Automations task a text-only pill without empty icon spacing", () => {
  const root = drawing("text");
  expect(root.querySelectorAll("svg")).toHaveLength(0);
  expect(root.querySelectorAll('[data-slot="view-switcher-label"]')).toHaveLength(2);
  for (const tab of root.querySelectorAll('[role="tab"]')) {
    expect(tab.children).toHaveLength(1);
    expect(tab.hasAttribute("aria-controls")).toBe(false);
    expect(tab.getAttribute("aria-label")).toBe(tab.textContent);
  }
});
it("keeps narrow icon-only choices named and the same roving stop", () => {
  const root = drawing("icon-only");
  expect(root.querySelectorAll('[data-slot="view-switcher-label"]')).toHaveLength(0);
  expect(
    [...root.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => [
      tab.getAttribute("aria-label"),
      tab.tabIndex,
    ]),
  ).toEqual([
    ["First", 0],
    ["Second", -1],
  ]);
});

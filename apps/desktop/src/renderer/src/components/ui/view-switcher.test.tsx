// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { CircleIcon } from "./icon";
import { ViewSwitcher } from "./view-switcher";

const modes = [
  { key: "first", label: "First" },
  { key: "second", label: "Second" },
] as const;
function drawing(
  variant: "text" | "selected-label" | "icon-only",
  size: "regular" | "small" = "regular",
) {
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
      size={size}
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
it("offers a quiet 24px source-header size without changing the inspector geometry", () => {
  const small = drawing("selected-label", "small");
  expect(small.querySelector('[role="tablist"]')?.getAttribute("data-size")).toBe("small");
  expect(small.querySelector('[role="tablist"]')?.className).toContain("p-0.5");
  for (const tab of small.querySelectorAll('[role="tab"]')) {
    expect(tab.className).toContain("h-5");
    expect(tab.className).toContain("text-label");
    expect(tab.querySelector("svg")?.classList.contains("size-3.5")).toBe(true);
  }
  expect(small.querySelector('[aria-selected="true"]')?.className).toContain("w-[72px]");
  const regular = drawing("selected-label");
  expect(regular.querySelector('[role="tablist"]')?.getAttribute("data-size")).toBe("regular");
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

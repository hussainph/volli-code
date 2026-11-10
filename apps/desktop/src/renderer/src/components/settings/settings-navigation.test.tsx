// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import { OverrideMenu, SettingsNavigation } from "./settings-navigation";

const projects: Project[] = ["First project", "Second project"].map((name, index) => ({
  id: `p${index}`,
  name,
  path: `/repo/${index}`,
  ticketPrefix: `P${index}`,
  baseBranch: "main",
  colorIndex: index,
  sortOrder: index,
  createdAt: 0,
  updatedAt: 0,
}));
let host: HTMLDivElement;
let root: Root;
const openProject = vi.fn();
const navigation = { openProject };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  openProject.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render(items = projects, page = "appearance") {
  act(() =>
    root.render(
      <SettingsNavigation.Provider value={navigation}>
        <OverrideMenu projects={items} page={page} />
      </SettingsNavigation.Provider>,
    ),
  );
}
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
it("renders nothing without overrides or navigation", () => {
  render([]);
  expect(host.innerHTML).toBe("");
  act(() => root.render(<OverrideMenu projects={projects} page="appearance" />));
  expect(host.innerHTML).toBe("");
});
it("uses a single non-wrapping count with singular and plural labels", () => {
  render(projects.slice(0, 1));
  expect(host.querySelector("button")?.textContent).toBe("1 project override");
  render();
  expect(host.querySelectorAll("button")).toHaveLength(1);
  const trigger = host.querySelector("button")!;
  expect(trigger.textContent).toBe("2 project overrides");
  expect(trigger.className).toContain("whitespace-nowrap");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(host.textContent).not.toContain("overrides this");
});
it.each(["appearance", "sessions"])("lists project marks and navigates to %s", async (page) => {
  render(projects, page);
  const trigger = host.querySelector("button")!;
  trigger.focus();
  await press(trigger, "ArrowDown");
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items).toHaveLength(2);
  expect(items.map((item) => item.querySelector("span:last-child")?.textContent)).toEqual(
    projects.map((project) => project.name),
  );
  for (const item of items) {
    expect(item.querySelector('[data-slot="identity-tile"][aria-hidden="true"]')).not.toBeNull();
  }
  await act(async () => items[1]!.click());
  expect(openProject).toHaveBeenCalledExactlyOnceWith("p1", page);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("supports keyboard selection and Escape returns focus without navigating", async () => {
  render();
  const trigger = host.querySelector("button")!;
  trigger.focus();
  await press(trigger, "ArrowDown");
  await press(document.activeElement!, "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(openProject).not.toHaveBeenCalled();
  await press(trigger, "ArrowDown");
  const first = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  first.focus();
  await press(first, "Enter");
  expect(openProject).toHaveBeenCalledExactlyOnceWith("p0", "appearance");
});

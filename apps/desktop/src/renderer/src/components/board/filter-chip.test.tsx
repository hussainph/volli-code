// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { FilterChip } from "./filter-chip";

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

it("preserves label spelling and keeps case-distinct labels independently selectable", async () => {
  const toggle = vi.fn();
  const labels = ["iOS", "bug", "Bug"];
  await act(async () =>
    root.render(
      <FilterChip
        label="Label"
        options={labels.map((label) => ({ value: label, label }))}
        selected={["bug"]}
        onToggle={toggle}
      />,
    ),
  );
  await act(async () =>
    host
      .querySelector("button")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
  expect(items.map((item) => item.textContent)).toEqual(labels);
  expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
    "false",
    "true",
    "false",
  ]);
  for (const item of items) await act(async () => item.click());
  expect(toggle.mock.calls).toEqual([["iOS"], ["bug"], ["Bug"]]);
  expect(document.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(3);
});

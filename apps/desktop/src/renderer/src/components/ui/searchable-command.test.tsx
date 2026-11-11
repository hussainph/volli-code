// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SearchableCommand } from "./searchable-command";
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("bounds 1000 choices and reaches the last logical item from the keyboard", async () => {
  const choose = vi.fn();
  const items = Array.from({ length: 1000 }, (_, i) => `Choice ${i}`);
  await act(async () =>
    root.render(
      <SearchableCommand
        items={items}
        keyOf={(item) => item}
        renderItem={(item) => <span>{item}</span>}
        onSelect={choose}
        query=""
        onQueryChange={() => {}}
        placeholder="Search choices"
      />,
    ),
  );
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(12);
  const input = host.querySelector("input")!;
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    ),
  );
  expect(choose).not.toHaveBeenCalled();
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(12);
  const current = host.querySelector('[role="option"][aria-selected="true"]');
  expect(current?.textContent).toBe("Choice 999");
  expect(input.getAttribute("aria-activedescendant")).toBe(current?.id);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(choose).toHaveBeenCalledWith("Choice 999");
});
const draw = (items: string[], query: string) =>
  root.render(
    <SearchableCommand
      items={items}
      keyOf={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      onSelect={() => {}}
      query={query}
      onQueryChange={() => {}}
      placeholder="Search choices"
    />,
  );

it("reconciles a shortened query with no stale window and names an empty result", async () => {
  await act(async () => draw(["Only"], "Only"));
  expect(host.querySelector('[role="option"]')?.textContent).toBe("Only");
  await act(async () => draw([], "missing"));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("No results");
});
it("keeps group headings and keyboard order across an unmounted group boundary", async () => {
  const choose = vi.fn();
  const items = Array.from({ length: 1000 }, (_, i) => ({
    name: `Model ${i}`,
    provider: i < 500 ? "First" : "Last",
  }));
  await act(async () =>
    root.render(
      <SearchableCommand
        items={items}
        keyOf={(item) => item.name}
        groupOf={(item) => item.provider}
        renderItem={(item) => item.name}
        onSelect={choose}
        query=""
        onQueryChange={() => {}}
        placeholder="Model"
      />,
    ),
  );
  expect(host.querySelector('[role="group"][aria-label="First"]')).not.toBeNull();
  const input = host.querySelector("input")!;
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  const selected = host.querySelector('[role="option"][aria-selected="true"]')!;
  expect(selected.textContent).toBe("Model 999");
  expect(selected.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Last");
  expect(input.getAttribute("aria-activedescendant")).toBe(selected.id);
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(12);
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(choose).toHaveBeenCalledWith(items[999]);
});

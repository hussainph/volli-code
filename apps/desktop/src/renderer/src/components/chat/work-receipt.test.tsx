// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WorkReceipt } from "./work-receipt";

let container: HTMLDivElement;
let root: Root;
let expanded = false;
function render() {
  act(() =>
    root.render(
      <WorkReceipt
        work={{ key: "work", rows: [], startedAt: 1000, endedAt: 13000, state: "complete" }}
        summary={[{ text: "Read DESIGN.md, used 6 tools", tone: "neutral" }]}
        open={expanded}
        onToggle={() => {
          expanded = !expanded;
          render();
        }}
      />,
    ),
  );
}
function button() {
  return container.querySelector<HTMLButtonElement>("button")!;
}
function preview() {
  return document.querySelector('[data-slot="popover-content"][data-state="open"]');
}
function pointer(type: string) {
  act(() => button().dispatchEvent(new MouseEvent(type, { bubbles: true })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  expanded = false;
  render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows a transient preview only over the collapsed receipt and never latches pointer focus", () => {
  expect(preview()).toBeNull();
  pointer("pointerover");
  expect(preview()).not.toBeNull();
  pointer("pointerout");
  expect(preview()).toBeNull();
  pointer("pointerdown");
  act(() => button().focus());
  expect(preview()).toBeNull();
  act(() => button().click());
  expect(button().getAttribute("aria-expanded")).toBe("true");
  expect(button().textContent).toContain("Read DESIGN.md");
  pointer("pointerover");
  expect(preview()).toBeNull();
  act(() => button().click());
  expect(button().textContent).toContain("Worked for 12s");
  expect(preview()).toBeNull();
});

it("allows keyboard collapsed focus, dismisses on Escape and blur, and has no tooltip title", () => {
  act(() => button().focus());
  expect(preview()).not.toBeNull();
  act(() => button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(preview()).toBeNull();
  act(() => button().blur());
  expect(preview()).toBeNull();
  expect(button().hasAttribute("title")).toBe(false);
  expect(button().querySelector(".transcript-clock-slot > svg.size-4")).not.toBeNull();
});

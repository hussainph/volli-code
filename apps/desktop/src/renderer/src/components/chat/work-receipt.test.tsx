// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WorkReceipt } from "./work-receipt";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";

const read = {
  kind: "tool" as const,
  key: "read",
  part: {
    type: "dynamic-tool" as const,
    toolCallId: "read",
    toolName: "read",
    state: "output-available" as const,
    input: { path: "DESIGN.md" },
    output: "design",
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind: "read-file",
        nativeToolName: "read",
        subject: { label: "DESIGN.md", path: "DESIGN.md", lineRange: null },
        startedAt: null,
        endedAt: null,
        outcome: null,
      },
    },
  },
};

let container: HTMLDivElement;
let root: Root;
let expanded = false;
function render() {
  act(() =>
    root.render(
      <WorkReceipt
        work={{ key: "work", rows: [read], startedAt: 1000, endedAt: 13000, state: "complete" }}
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
  expect(button().textContent).toContain("Explored 1 file");
  pointer("pointerover");
  expect(preview()).toBeNull();
  act(() => button().click());
  expect(button().textContent).toContain("Explored 1 file");
  expect(preview()).toBeNull();
});

it("keeps unresolved activity visible in a boundary-frozen collapsed receipt and clears it at settlement", () => {
  const work = {
    key: "work",
    startedAt: 1000,
    endedAt: 13000,
    state: "complete" as const,
    rows: [
      {
        kind: "tool" as const,
        key: "call",
        part: {
          type: "dynamic-tool" as const,
          toolCallId: "call",
          toolName: "bash",
          state: "input-available" as const,
          input: {},
        },
      },
    ],
  };
  act(() =>
    root.render(
      <WorkReceipt
        work={work}
        summary={[
          { text: "Running command", tone: "neutral" },
          { text: "1 failed", tone: "danger" },
        ]}
        open={false}
        onToggle={() => {}}
      />,
    ),
  );
  expect(button().textContent).toContain("Using 1 tool");
  expect(button().textContent).toContain("1 unresolved");
  expect(button().textContent).toContain("1 failed");
  act(() =>
    root.render(
      <WorkReceipt
        work={{
          ...work,
          rows: [
            {
              ...work.rows[0]!,
              part: { ...work.rows[0]!.part, state: "output-available", output: "done" },
            },
          ],
        }}
        summary={[{ text: "Ran command", tone: "neutral" }]}
        open={false}
        onToggle={() => {}}
      />,
    ),
  );
  expect(button().textContent).toContain("Used 1 tool");
  expect(button().textContent).not.toContain("unresolved");
});

it("allows keyboard collapsed focus, dismisses on Escape and blur, and has no tooltip title", () => {
  act(() => button().focus());
  expect(preview()).not.toBeNull();
  act(() => button().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(preview()).toBeNull();
  act(() => button().blur());
  expect(preview()).toBeNull();
  expect(button().hasAttribute("title")).toBe(false);
  expect(button().querySelector(".transcript-status-slot > svg.size-3\\.5")).not.toBeNull();
});

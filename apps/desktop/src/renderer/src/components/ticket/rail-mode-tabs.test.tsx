// @vitest-environment jsdom
/** Inspector navigation uses the shared thumb and preserves every keyboard path. */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RailModeTabs, type RailModeTab } from "./rail-mode-tabs";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

const MODES: readonly RailModeTab<"now" | "files" | "diffs">[] = [
  { key: "now", label: "Now", icon: CircleIcon },
  { key: "files", label: "Files", icon: CircleIcon },
  { key: "diffs", label: "Diffs", icon: CircleIcon },
];

let root: Root | null = null;
let container: HTMLElement | null = null;
const selected = vi.fn();

/** The pill as a rail mounts it: the caller owns `active`, this owns the pill. */
function Harness() {
  const [active, setActive] = React.useState<"now" | "files" | "diffs">("now");
  return (
    <TooltipProvider>
      <RailModeTabs
        modes={MODES}
        active={active}
        label="Rail pages"
        idPrefix="rail"
        onSelect={(next) => {
          selected(next);
          setActive(next);
        }}
      />
    </TooltipProvider>
  );
}

function query<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`no element matching ${selector}`);
  return found;
}

function tab(key: string): HTMLButtonElement {
  return query<HTMLButtonElement>(`[data-testid="rail-tab-${key}"]`);
}

/** Whether the pill would animate the selection it is showing. */
function animated(): string | null {
  return query('[role="tablist"]').getAttribute("data-pointer-motion");
}

/**
 * One activation, as the browser delivers it. `detail` is 0 for the synthetic
 * click Enter/Space produce on a focused button and ≥1 for a real press;
 * `target` is whatever was under the pointer, which for a press on the glyph is
 * a descendant of the tab rather than the tab.
 */
async function activate(target: Element, detail: number): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  });
}

async function walk(target: Element, name: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  MotionGlobalConfig.skipAnimations = true;
  selected.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  MotionGlobalConfig.skipAnimations = false;
  vi.unstubAllGlobals();
});

describe("what sets the pill's gate", () => {
  it("springs for a real press, including one that lands on the glyph inside", async () => {
    // The shipping pointer feel, and the reason the gate is read on the BUTTON:
    // the press a person makes usually lands on the icon, and the click that
    // bubbles up from it is still a pointer click.
    const glyph = tab("files").querySelector("svg") ?? tab("files");
    await activate(glyph, 1);

    expect(selected).toHaveBeenCalledWith("files");
    expect(animated()).toBe("true");
    expect(tab("files").getAttribute("aria-selected")).toBe("true");
  });

  it("stands still for Enter or Space on a focused tab", async () => {
    // The whole finding: Enter/Space dispatch a click whose `detail` is 0, so a
    // keyboard activation used to reach the same `animateSelection(true)` a
    // mouse press does and animate a selection the reader made by keystroke.
    tab("files").focus();
    await activate(tab("files"), 0);

    expect(selected).toHaveBeenCalledWith("files");
    expect(animated()).toBe("false");
  });

  it("is set per activation, not once per session", async () => {
    // A pointer press after a keystroke animates again, and a keystroke after a
    // press does not: the gate is a property of the activation in hand.
    await activate(tab("files"), 0);
    expect(animated()).toBe("false");

    await activate(tab("diffs"), 1);
    expect(animated()).toBe("true");

    await activate(tab("now"), 0);
    expect(animated()).toBe("false");
    expect(selected.mock.calls.map(([next]) => next)).toEqual(["files", "diffs", "now"]);
  });

  it("keeps the arrow walk's order and its stillness", async () => {
    await walk(tab("now"), "ArrowRight");
    expect(selected).toHaveBeenLastCalledWith("files");
    expect(animated()).toBe("false");
    expect(document.activeElement).toBe(tab("files"));

    // Wrapping, both ways, from wherever the walk is.
    await walk(tab("files"), "ArrowLeft");
    expect(selected).toHaveBeenLastCalledWith("now");
    await walk(tab("now"), "ArrowLeft");
    expect(selected).toHaveBeenLastCalledWith("diffs");

    await walk(tab("diffs"), "Home");
    expect(selected).toHaveBeenLastCalledWith("now");
    await walk(tab("now"), "End");
    expect(selected).toHaveBeenLastCalledWith("diffs");
    expect(animated()).toBe("false");
    expect(document.activeElement).toBe(tab("diffs"));
  });

  it("keeps every icon named, including inactive pages", async () => {
    // The exit half of the gate, observed rather than measured: the word of the
    // tab being left is gone by the time the next activation could land.
    await activate(tab("files"), 0);
    expect(tab("files").textContent).toContain("Files");
    expect(tab("now").querySelector(".sr-only")?.textContent).toBe("Now");
    expect(tab("now").title).toBe("Now");

    await activate(tab("diffs"), 1);
    expect(tab("diffs").textContent).toContain("Diffs");
    expect(tab("files").querySelector(".sr-only")?.textContent).toBe("Files");
    expect(tab("diffs").getAttribute("aria-controls")).toBe("rail-page-diffs");
  });
});

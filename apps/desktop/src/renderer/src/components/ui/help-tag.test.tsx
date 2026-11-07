// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HelpTag } from "./help-tag";
import { TooltipProvider } from "./tooltip";
import { SearchableCommand } from "./searchable-command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const content = () => document.body.querySelector('[data-slot="tooltip-content"]');
function move(element: Element) {
  act(() =>
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })),
  );
}
function leave(element: Element) {
  act(() =>
    element.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    ),
  );
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

function UnsetModel({ saveGate }: { saveGate?: Promise<void> }) {
  const [value, setValue] = useState("");
  return (
    <Select
      defaultOpen
      value={value}
      onValueChange={async (next) => {
        if (saveGate) await saveGate;
        setValue(next);
      }}
    >
      <SelectTrigger aria-label="Model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="model">
          <HelpTag label="Provider">
            <span>P</span>
          </HelpTag>
          Model
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("HelpTag", () => {
  it("ends restoration before a delayed mark mounts on an already refocused trigger", async () => {
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    try {
      await act(async () => root.render(<UnsetModel saveGate={saveGate} />));
      await advance(0);
      const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
      const option = document.querySelector<HTMLElement>('[role="option"]')!;
      await act(async () => {
        option.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
        );
        option.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
        );
        option.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
        );
      });
      await advance(0);
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(trigger.querySelector('[data-slot="help-tag"]')).toBeNull();
      await act(async () => finishSave());
      expect(trigger.querySelector('[data-slot="help-tag"]')).not.toBeNull();
      expect(content()).toBeNull();
      act(() => {
        trigger.blur();
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        trigger.focus();
      });
      expect(content()?.textContent).toBe("Provider");
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
    }
  });
  it("preserves deliberate keyboard help when Select restores focus to a newly mounted mark", async () => {
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      await act(async () => root.render(<UnsetModel />));
      await advance(0);
      const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
      expect(trigger.querySelector('[data-slot="help-tag"]')).toBeNull();
      const option = document.querySelector<HTMLElement>('[role="option"]')!;
      await act(async () => {
        option.focus();
        option.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      });
      await advance(0);
      expect(content()?.textContent).toBe("Provider");
      await act(async () =>
        option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      await advance(0);
      expect(document.activeElement).toBe(trigger);
      expect(trigger.querySelector('[data-slot="help-tag"]')).not.toBeNull();
      expect(content()?.textContent).toBe("Provider");
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
    }
  });
  it("waits 1500ms even in an instant-tooltip group, dismisses immediately, and waits again", async () => {
    act(() =>
      root.render(
        <TooltipProvider delayDuration={0}>
          <HelpTag label="Cloudflare Workers AI">
            <span>A</span>
          </HelpTag>
          <HelpTag label="Cloudflare AI Gateway">
            <span>A</span>
          </HelpTag>
        </TooltipProvider>,
      ),
    );
    const marks = container.querySelectorAll('[data-slot="help-tag"]');
    expect(marks[0]?.getAttribute("aria-label")).toBe("Cloudflare Workers AI");
    expect(marks[0]?.getAttribute("tabindex")).toBe("0");
    move(marks[0]!);
    await advance(1499);
    expect(content()).toBeNull();
    await advance(1);
    expect(content()?.textContent).toBe("Cloudflare Workers AI");
    leave(marks[0]!);
    expect(content()).toBeNull();
    move(marks[1]!);
    await advance(1499);
    expect(content()).toBeNull();
    await advance(1);
    expect(content()?.textContent).toBe("Cloudflare AI Gateway");
  });
  it("cancels a short hover and reveals an inert mark on focus without waiting", async () => {
    act(() =>
      root.render(
        <HelpTag label="Custom provider">
          <span>C</span>
        </HelpTag>,
      ),
    );
    const mark = container.querySelector<HTMLElement>('[data-slot="help-tag"]')!;
    move(mark);
    await advance(600);
    leave(mark);
    await advance(1500);
    expect(content()).toBeNull();
    act(() => mark.focus());
    expect(content()?.textContent).toBe("Custom provider");
    act(() => mark.blur());
    expect(content()).toBeNull();
  });
  it("borrows a button's keyboard focus but does not open on a pointer press", () => {
    act(() =>
      root.render(
        <button>
          <HelpTag label="Provider">
            <span>P</span>
          </HelpTag>
          Model
        </button>,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.querySelector("[tabindex]")).toBeNull();
    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button.focus();
    });
    expect(content()).toBeNull();
    act(() => {
      button.blur();
      window.dispatchEvent(new PointerEvent("pointerup"));
      button.focus();
    });
    expect(content()?.textContent).toBe("Provider");
  });
  it("does not borrow a dialog or scrolling region's tabindex as an identity anchor", () => {
    act(() =>
      root.render(
        <div role="dialog" tabIndex={-1}>
          <button>Open as tab</button>
          <HelpTag label="Provider">
            <span>P</span>
          </HelpTag>
        </div>,
      ),
    );
    const mark = container.querySelector<HTMLElement>('[data-slot="help-tag"]')!;
    expect(mark.tabIndex).toBe(0);
    act(() => container.querySelector("button")!.focus());
    expect(content()).toBeNull();
    act(() => mark.focus());
    expect(content()?.textContent).toBe("Provider");
  });
  it("reveals the keyboard's active option without adding focus stops or losing virtualisation", async () => {
    const items = Array.from({ length: 1000 }, (_, n) => ({
      id: String(n),
      label: `Custom provider ${n}`,
    }));
    act(() =>
      root.render(
        <SearchableCommand
          items={items}
          keyOf={(item) => item.id}
          groupOf={() => "Providers"}
          showGroupHeadings={false}
          query=""
          onQueryChange={() => {}}
          placeholder="Model"
          onSelect={() => {}}
          renderItem={(item) => (
            <>
              <HelpTag label={item.label}>
                <span>C</span>
              </HelpTag>
              Same model
            </>
          )}
        />,
      ),
    );
    const input = container.querySelector("input")!;
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(content()?.textContent).toBe("Custom provider 1");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    expect(content()?.textContent).toBe("Custom provider 999");
    expect(container.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(13);
    expect(container.querySelectorAll('[role="option"] [tabindex]').length).toBe(0);
    expect(document.activeElement).toBe(input);
  });
});

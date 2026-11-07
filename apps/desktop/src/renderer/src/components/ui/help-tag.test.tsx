// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HelpTag } from "./help-tag";
import { TooltipProvider } from "./tooltip";
import { SearchableCommand } from "./searchable-command";

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

describe("HelpTag", () => {
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

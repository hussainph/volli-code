// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { ModelName } from "./model-identity";

const MODEL = {
  providerId: "anthropic",
  modelId: "opus",
  label: "Claude Opus with a very long model name",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function mount(disabled = false) {
  act(() =>
    root.render(
      <Select value="model" disabled={disabled}>
        <SelectTrigger aria-label="Runtime model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="model">
            <ModelName model={MODEL} models={[MODEL]} providerLabel="Anthropic" />
          </SelectItem>
        </SelectContent>
      </Select>,
    ),
  );
  return container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!;
}
const tag = () => document.body.querySelector('[data-slot="tooltip-content"]');
describe("mark-only model identity", () => {
  it("wraps list text and only clips the closed Select copy", () => {
    const html = renderToStaticMarkup(
      <ModelName model={MODEL} models={[MODEL]} providerLabel="Anthropic" trailing="High" />,
    );
    const dom = document.createElement("div");
    dom.innerHTML = html;
    const name = dom.querySelector('[data-slot="model-name"]')!;
    expect(name.className.split(" ")).toContain("break-words");
    expect(name.className.split(" ")).not.toContain("truncate");
    expect(name.className).toContain("in-data-[slot=select-trigger]:truncate");
    expect(name.textContent).toBe(`${MODEL.label} · High`);
    expect(dom.textContent).not.toContain("Anthropic");
    expect(dom.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Anthropic");
    expect(dom.querySelector("[title]")).toBeNull();
  });
  it("disambiguates colliding lettermarks and same-provider duplicate model labels in the tag", () => {
    const first = { ...MODEL, providerId: "custom-a", label: "Same model" };
    const html = renderToStaticMarkup(
      <ModelName
        model={first}
        models={[first, { ...first, modelId: "opus-v2" }]}
        providers={[
          { id: "custom-a", label: "Custom" },
          { id: "custom-b", label: "Custom" },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Custom · custom-a · opus"');
    expect(new DOMParser().parseFromString(html, "text/html").body.textContent).toBe(
      `C${first.label}`,
    );
  });
  it("reveals the whole model and provider on host keyboard focus, with no nested stop", () => {
    const trigger = mount();
    expect(trigger.querySelector('[data-slot="help-tag"]')?.hasAttribute("tabindex")).toBe(false);
    act(() => trigger.focus());
    expect(tag()?.textContent).toBe(`${MODEL.label} · Anthropic`);
    act(() =>
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(tag()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("borrows a stop while disabled and returns focus to the thawed host", async () => {
    const trigger = mount(true);
    const mark = trigger.querySelector<HTMLElement>('[data-slot="help-tag"]')!;
    expect(mark.tabIndex).toBe(0);
    act(() => mark.focus());
    expect(tag()?.textContent).toBe(`${MODEL.label} · Anthropic`);
    mount(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mark.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(trigger);
  });
  it("keeps real Select pointer-focused rows quiet, waits on the mark, and reveals keyboard navigation immediately", async () => {
    vi.useFakeTimers();
    const scroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      const models = [MODEL, { ...MODEL, providerId: "openai", modelId: "other" }];
      await act(async () =>
        root.render(
          <Select defaultOpen value="first">
            <SelectTrigger aria-label="Runtime model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="first">
                <ModelName model={models[0]!} models={models} providerLabel="Anthropic" />
              </SelectItem>
              <SelectItem value="second">
                <ModelName model={models[1]!} models={models} providerLabel="OpenAI" />
              </SelectItem>
            </SelectContent>
          </Select>,
        ),
      );
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      const options = document.querySelectorAll<HTMLElement>('[role="option"]');
      const second = options[1]!;
      await act(async () =>
        second.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
        ),
      );
      // This is Radix's own pointermove -> focus path, with NO pointer press.
      expect(document.activeElement).toBe(second);
      expect(tag()).toBeNull();
      const mark = second.querySelector<HTMLElement>('[data-slot="help-tag"]')!;
      expect(mark.hasAttribute("tabindex")).toBe(false);
      await act(async () =>
        mark.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
        ),
      );
      await act(async () => {
        vi.advanceTimersByTime(1499);
      });
      expect(tag()).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(tag()?.textContent).toBe(`${MODEL.label} · OpenAI`);
      await act(async () =>
        mark.dispatchEvent(
          new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
        ),
      );
      expect(tag()).toBeNull();
      act(() => second.focus());
      await act(async () =>
        second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
      );
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      expect(document.activeElement).toBe(options[0]);
      expect(tag()?.textContent).toBe(`${MODEL.label} · Anthropic`);
    } finally {
      HTMLElement.prototype.scrollIntoView = scroll;
      vi.useRealTimers();
    }
  });
});

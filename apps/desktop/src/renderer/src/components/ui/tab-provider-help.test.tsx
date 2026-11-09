// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Tab, TabStrip } from "./tab-strip";
import { SessionGlyph } from "@renderer/components/sessions/session-glyph";

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
const provider = "Cloudflare Workers AI";
const title = "Review\nAutomation · Nightly sweep";
const content = () => document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
function mount(grouped = false) {
  act(() =>
    root.render(
      <TabStrip label="Sessions">
        <Tab
          label="Review"
          title={title}
          identity={provider}
          active
          tabStop
          closable={false}
          onActivate={() => {}}
          actionsContent={grouped ? <div>Member Sessions</div> : undefined}
          leading={
            <SessionGlyph
              providerId="cloudflare-workers-ai"
              providerLabel={provider}
              name={provider}
              kind="chat"
              state="working"
              size="tab"
            />
          }
        />
      </TabStrip>,
    ),
  );
  const tab = container.querySelector<HTMLElement>('[role="tab"]')!;
  const mark = tab.querySelector<HTMLElement>("[data-session-glyph]")!;
  return { tab, mark };
}
function hover(tab: HTMLElement, mark: HTMLElement) {
  act(() => {
    mark.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    mark.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  });
  expect(tab.hasAttribute("title")).toBe(false);
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

describe("one tab help surface", () => {
  it("keeps title help fast and adds provider detail in the same popup only after a long hover", async () => {
    const { tab, mark } = mount();
    hover(tab, mark);
    await advance(400);
    const ordinary = content();
    expect(ordinary?.textContent).toBe(title);
    expect(ordinary?.textContent).not.toContain(provider);
    await advance(1099);
    expect(content()?.textContent).not.toContain(provider);
    await advance(1);
    expect(content()).toBe(ordinary);
    expect(content()?.textContent).toBe(`${title} · ${provider}`);
    expect(document.body.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
    act(() => mark.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" })));
    expect(content()?.textContent).toBe(title);
    hover(tab, mark);
    await advance(1499);
    expect(content()?.textContent).not.toContain(provider);
    await advance(1);
    expect(content()?.textContent).toContain(provider);
  });
  it("reuses the tab's keyboard anchor and keeps the provider accessible without an extra stop", () => {
    const { tab, mark } = mount();
    expect(tab.getAttribute("aria-label")).toBe(`Review · ${provider}`);
    expect(mark.getAttribute("aria-label")).toBe(provider);
    expect(mark.hasAttribute("tabindex")).toBe(false);
    expect(tab.querySelector('[data-slot="help-tag"]')).toBeNull();
    act(() => tab.focus());
    expect(content()?.textContent).toBe(`${title} · ${provider}`);
    act(() => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(content()).toBeNull();
    expect(document.activeElement).toBe(tab);
  });
  it("cancels short hovers and never stacks a plain tooltip on a grouped tab's member card", async () => {
    const { tab, mark } = mount(true);
    act(() => tab.focus());
    expect(content()).toBeNull();
    hover(tab, mark);
    await advance(1600);
    expect(content()).toBeNull();
  });
  it("does not reveal provider detail from a short hover or a pointer focus", async () => {
    const { tab, mark } = mount();
    hover(tab, mark);
    await advance(600);
    act(() => {
      mark.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
      tab.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      tab.focus();
    });
    await advance(1500);
    expect(content()?.textContent ?? "").not.toContain(provider);
    act(() => window.dispatchEvent(new PointerEvent("pointerup")));
  });
});

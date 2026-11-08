// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EffortSlider } from "./composer-effort-ui";

let root: Root;
let host: HTMLDivElement;
const levels = ["low", "medium", "high", "max"];
const change = vi.fn();
const dismiss = vi.fn();
const rail = createRef<HTMLDivElement>();
async function render(value = "medium") {
  await act(async () =>
    root.render(
      <EffortSlider
        levels={levels}
        value={value}
        onChange={change}
        onDismiss={dismiss}
        railRef={rail}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  change.mockClear();
  dismiss.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.motion;
  vi.unstubAllGlobals();
});
it("opens with complete static stops and snaps keyboard effort", async () => {
  await render();
  expect(rail.current?.hasAttribute("data-effort-instant")).toBe(true);
  const ticks = host.querySelectorAll<HTMLElement>('[data-slot="effort-tick"]');
  expect(ticks).toHaveLength(2);
  expect(
    [...ticks].every((tick) => !tick.style.animationDelay && !tick.className.includes("animate-")),
  ).toBe(true);
  expect(host.querySelector('[data-slot="effort-halo"]')?.className).not.toContain("transition");
  act(() =>
    rail.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  expect(change).toHaveBeenLastCalledWith("high");
  await render("high");
  expect(rail.current?.getAttribute("aria-valuetext")).toBe("High");
  expect(rail.current?.hasAttribute("data-effort-instant")).toBe(true);
  act(() =>
    rail.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(dismiss).toHaveBeenCalledOnce();
});
it("gates pointer settling when Motion is switched off during a pull", async () => {
  await render();
  if (!rail.current) throw new Error("No effort rail");
  rail.current.setPointerCapture = vi.fn();
  rail.current.releasePointerCapture = vi.fn();
  vi.spyOn(rail.current, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 224,
  } as DOMRect);
  act(() =>
    rail.current?.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: 250, bubbles: true }),
    ),
  );
  expect(rail.current.hasAttribute("data-dragging")).toBe(true);
  expect(rail.current.hasAttribute("data-effort-instant")).toBe(false);
  expect(change).toHaveBeenLastCalledWith("max");
  act(() => {
    document.documentElement.dataset.motion = "off";
    window.dispatchEvent(new Event("volli-motion-change"));
  });
  expect(rail.current.hasAttribute("data-effort-instant")).toBe(true);
  act(() => rail.current?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
  expect(rail.current.hasAttribute("data-dragging")).toBe(false);
});

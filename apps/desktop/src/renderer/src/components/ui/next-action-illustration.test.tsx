// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { NextActionKind } from "./next-action-illustration";

let NextActionIllustration: typeof import("./next-action-illustration").NextActionIllustration;

const preference = vi.hoisted(() => ({ reduce: false }));
vi.mock("@renderer/hooks/use-reduced-motion", () => ({
  prefersReducedMotion: () => preference.reduce,
}));
let root: Root;
let host: HTMLElement;
let intersect: IntersectionObserverCallback;
let change: () => void;
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel }));
const disconnect = vi.fn();
const originalAnimate = Element.prototype.animate;
beforeEach(async () => {
  vi.resetModules();
  ({ NextActionIllustration } = await import("./next-action-illustration"));
  preference.reduce = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: preference.reduce,
    addEventListener: (_name: string, listener: () => void) => {
      change = listener;
    },
    removeEventListener: vi.fn(),
  }));
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  animate.mockClear();
  cancel.mockClear();
  disconnect.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (originalAnimate) Element.prototype.animate = originalAnimate;
  else Reflect.deleteProperty(Element.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(kind: NextActionKind) {
  act(() => root.render(<NextActionIllustration kind={kind} />));
}
function visible() {
  intersect(
    [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
}
it("waits until in view, uses finite compositor-only steps, and does not replay on remount", () => {
  mount("board");
  expect(animate).not.toHaveBeenCalled();
  intersect(
    [{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  expect(animate).not.toHaveBeenCalled();
  visible();
  expect(animate).toHaveBeenCalledTimes(2);
  for (const [frames, timing] of animate.mock.calls as unknown as [
    Keyframe[],
    KeyframeAnimationOptions,
  ][]) {
    expect(timing.iterations).toBe(1);
    expect(Number(timing.duration)).toBeGreaterThanOrEqual(150);
    expect(Number(timing.duration)).toBeLessThanOrEqual(300);
    expect(Number(timing.delay) + Number(timing.duration)).toBeLessThanOrEqual(1200);
    expect(
      frames.every((frame) =>
        Object.keys(frame).every((key) => ["transform", "opacity", "offset"].includes(key)),
      ),
    ).toBe(true);
  }
  act(() => root.render(null));
  mount("board");
  expect(animate).toHaveBeenCalledTimes(2);
});
it("keeps a complete, accessible, non-interactive illustration with reduced motion", () => {
  preference.reduce = true;
  mount("chat");
  expect(animate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
    "model and effort",
  );
  expect(host.textContent).toContain("Model");
  expect(host.textContent).toContain("Effort");
  expect(host.querySelector("button, input, [tabindex]")).toBeNull();
});
it("cancels immediately when the user acts", () => {
  mount("active");
  visible();
  document.dispatchEvent(new PointerEvent("pointerdown"));
  expect(cancel).toHaveBeenCalled();
});
it("suppresses an explanation if keyboard input arrives before visibility", () => {
  mount("previous");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  visible();
  expect(animate).not.toHaveBeenCalled();
});
it("cancels when reduced motion is enabled during travel", () => {
  mount("files");
  visible();
  preference.reduce = true;
  change();
  expect(cancel).toHaveBeenCalledTimes(2);
});
it("cleans up animation effects on unmount", () => {
  mount("selection");
  visible();
  act(() => root.render(null));
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(disconnect).toHaveBeenCalled();
});
it("cancels when the document is hidden", () => {
  mount("project");
  visible();
  expect(animate).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(cancel).toHaveBeenCalledTimes(2);
  vi.restoreAllMocks();
});
it("does not move an explanation while a keyboard target has focus", () => {
  const button = document.body.appendChild(document.createElement("button"));
  button.focus();
  vi.spyOn(button, "matches").mockReturnValue(true);
  mount("project");
  visible();
  expect(animate).not.toHaveBeenCalled();
  button.remove();
  vi.restoreAllMocks();
});
it("falls back to the static drawing without animation or visibility support", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  mount("project");
  expect(animate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="img"]')?.textContent).toContain("Open a project");
});

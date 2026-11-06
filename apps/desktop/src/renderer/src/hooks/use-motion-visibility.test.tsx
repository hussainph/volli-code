// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useBoardMotionVisibility, useDocumentMotionVisibility } from "./use-motion-visibility";

function Probe() {
  const ref = React.useRef<HTMLDivElement>(null);
  useBoardMotionVisibility(ref);
  useDocumentMotionVisibility();
  return (
    <div ref={ref}>
      <div data-board-ticket-slot="one" />
    </div>
  );
}

function entry(target: Element, isIntersecting: boolean): IntersectionObserverEntry {
  return {
    target,
    isIntersecting,
    boundingClientRect: new DOMRect(),
    intersectionRect: new DOMRect(),
    rootBounds: null,
    intersectionRatio: isIntersecting ? 1 : 0,
    time: 0,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("uses one intersection observer across mounted slots and releases recycled slots", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let notify!: IntersectionObserverCallback;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  const construct = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
        construct();
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  const slot = host.querySelector<HTMLElement>("[data-board-ticket-slot]")!;
  expect(construct).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledWith(slot);
  expect(slot.dataset.viewportHidden).toBe("true");
  notify([entry(slot, true)], {} as IntersectionObserver);
  expect(slot.dataset.viewportHidden).toBe("false");
  const next = document.createElement("div");
  next.dataset.boardTicketSlot = "two";
  await act(async () => slot.parentElement!.append(next));
  expect(observe).toHaveBeenCalledWith(next);
  expect(construct).toHaveBeenCalledOnce();
  notify([entry(next, false)], {} as IntersectionObserver);
  expect(next.dataset.viewportHidden).toBe("true");
  await act(async () => next.remove());
  expect(unobserve).toHaveBeenCalledWith(next);
  expect(next.dataset.viewportHidden).toBeUndefined();
  await act(async () => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  expect(slot.dataset.viewportHidden).toBeUndefined();
  host.remove();
});

it("pauses a hidden document without a React render and cleans up on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  expect(document.documentElement.dataset.documentHidden).toBe("false");
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(document.documentElement.dataset.documentHidden).toBe("true");
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(document.documentElement.dataset.documentHidden).toBe("false");
  await act(async () => root.unmount());
  expect(document.documentElement.dataset.documentHidden).toBeUndefined();
  hidden.mockRestore();
});

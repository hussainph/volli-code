// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ENTER_DELAY_MS,
  EXIT_GRACE_MS,
  TRIGGER_ENTER_DELAY_MS,
  useEdgeReveal,
} from "./edge-reveal";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let panel: HTMLDivElement;
let zone: HTMLDivElement;
let band: HTMLDivElement;
let refs: {
  panelRef: { current: HTMLDivElement };
  zoneRef: { current: HTMLDivElement };
  bandRef: { current: HTMLDivElement };
};
function Harness() {
  const reveal = useEdgeReveal({ enabled: true, ...refs });
  return (
    <button
      data-visible={reveal.visible}
      onFocus={reveal.onPanelFocus}
      onClick={reveal.onPanelClick}
    />
  );
}
async function move(x: number, y: number, elapsed = 0) {
  await act(async () => {
    const event = new Event("pointermove");
    Object.assign(event, { pointerType: "mouse", clientX: x, clientY: y });
    window.dispatchEvent(event);
    vi.advanceTimersByTime(elapsed + 1);
  });
}
function visible() {
  return container.firstElementChild?.getAttribute("data-visible") === "true";
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  panel = document.createElement("div");
  zone = document.createElement("div");
  band = document.createElement("div");
  band.innerHTML = '<button data-slot="sidebar-trigger"></button>';
  vi.spyOn(band, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 36));
  vi.spyOn(band.firstElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(240, 6, 24, 24),
  );
  vi.spyOn(zone, "getBoundingClientRect").mockReturnValue(new DOMRect(60, 60, 8, 700));
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(68, 44, 240, 700));
  refs = { panelRef: { current: panel }, zoneRef: { current: zone }, bandRef: { current: band } };
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("pane hover intent", () => {
  it("uses a 140ms dwell on either the edge or its toolbar control", async () => {
    expect(ENTER_DELAY_MS).toBe(140);
    expect(TRIGGER_ENTER_DELAY_MS).toBe(140);
    await move(500, 200); // release the initial post-unpin latch
    await move(250, 18, 138);
    expect(visible()).toBe(false);
    await move(250, 18, 2);
    expect(visible()).toBe(true);
  });
  it("keeps the pour collision latched until the pointer leaves the button", async () => {
    await move(500, 200);
    await move(250, 18, 140);
    expect(visible()).toBe(true);
    await move(700, 300, EXIT_GRACE_MS);
    expect(visible()).toBe(false);
    panel.dataset.panePouring = "true";
    await move(250, 18, 140);
    expect(visible()).toBe(false);
    delete panel.dataset.panePouring;
    await move(250, 18, 500);
    expect(visible()).toBe(false);
    await move(500, 200);
    await move(250, 18, 140);
    expect(visible()).toBe(true);
  });
  it("dismisses from Escape with an immediate clock and no pour", async () => {
    vi.advanceTimersByTime(300);
    await move(64, 200, 140);
    expect(visible()).toBe(true);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(visible()).toBe(false);
    expect(panel.style.getPropertyValue("--reveal-duration")).toBe("0ms");
    expect(panel.dataset.keyboardDismiss).toBe("true");
  });
  it("keyboard focus arms a zero clock before opening, and marks a non-pouring journey", async () => {
    const target = container.firstElementChild!;
    vi.spyOn(target, "matches").mockReturnValue(true);
    await act(async () => target.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(visible()).toBe(true);
    expect(panel.style.getPropertyValue("--reveal-duration")).toBe("0ms");
    expect(panel.hasAttribute("data-keyboard-dismiss")).toBe(true);
  });
  it("keyboard navigation dismisses the peek immediately without a pointer grace timer", async () => {
    await move(500, 200);
    await move(250, 18, 140);
    await act(async () =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })),
    );
    expect(visible()).toBe(false);
    expect(panel.style.getPropertyValue("--reveal-duration")).toBe("0ms");
    expect(panel.hasAttribute("data-keyboard-dismiss")).toBe(true);
  });
});

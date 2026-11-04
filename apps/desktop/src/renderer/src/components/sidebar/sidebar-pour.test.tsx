// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useSidebarPour } from "./sidebar-pour";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let panel: HTMLDivElement;
let band: HTMLDivElement;
const cancel = vi.fn();
let finish: (() => void) | null;
const animate = vi.fn(() => {
  const result = { cancel, onfinish: null as (() => void) | null };
  Object.defineProperty(result, "onfinish", {
    set: (value: () => void) => {
      finish = value;
    },
  });
  return result;
});
function Harness({ shown, instant }: { shown: boolean; instant: boolean }) {
  const pouring = useSidebarPour({
    shown,
    instant,
    panelRef: { current: panel },
    bandRef: { current: band },
  });
  return <span data-pouring={pouring} />;
}
async function render(shown: boolean, instant = false) {
  await act(async () => root.render(<Harness shown={shown} instant={instant} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cancel.mockClear();
  animate.mockClear();
  finish = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const parent = document.createElement("div");
  panel = document.createElement("div");
  parent.append(panel);
  document.body.append(parent);
  band = document.createElement("div");
  band.innerHTML = '<button data-slot="sidebar-trigger"></button>';
  document.body.append(band);
  Object.defineProperties(panel, {
    offsetParent: { value: parent },
    offsetWidth: { value: 240 },
    offsetLeft: { value: 8 },
    offsetTop: { value: 8 },
    animate: { value: animate, configurable: true },
  });
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(68, 44, 240, 700));
  vi.spyOn(parent, "getBoundingClientRect").mockReturnValue(new DOMRect(60, 36, 300, 760));
  vi.spyOn(band.firstElementChild!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(240, 6, 24, 24),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  panel.parentElement?.remove();
  band.remove();
  container.remove();
  vi.unstubAllGlobals();
});
describe("sidebar pour", () => {
  it("returns a dismissed pointer pane to its control without layout animation", async () => {
    await render(true);
    await render(false);
    expect(animate).toHaveBeenCalledOnce();
    expect(panel.dataset.panePouring).toBe("true");
    const [frames, options] = animate.mock.calls[0] as unknown as [
      Keyframe[],
      KeyframeAnimationOptions,
    ];
    expect(frames[1].transform).toContain("translate(172px, -38px) scale(0.1,");
    expect(options).toMatchObject({ duration: 160 });
    expect(frames.every((frame) => frame.width === undefined && frame.height === undefined)).toBe(
      true,
    );
    await act(async () => finish?.());
    expect(panel.dataset.panePouring).toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });
  it("takes keyboard and reduced-motion endpoints without a morph", async () => {
    await render(true);
    await render(false, true);
    expect(animate).not.toHaveBeenCalled();
    await render(true);
    panel.dataset.keyboardDismiss = "true";
    await render(false);
    expect(animate).not.toHaveBeenCalled();
  });
  it("cancels a pour when the pane is reopened", async () => {
    await render(true);
    await render(false);
    await render(true);
    expect(cancel).toHaveBeenCalled();
    expect(panel.dataset.panePouring).toBeUndefined();
  });
});

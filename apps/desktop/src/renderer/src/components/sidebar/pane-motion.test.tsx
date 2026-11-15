// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usePaneMotion, type PaneMode } from "./pane-motion";

type Run = {
  node: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null };
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
let runs: Run[];
let paperShift = 0;
function Harness({
  side,
  mode,
  instant = false,
}: {
  side: "left" | "right";
  mode: PaneMode;
  instant?: boolean;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const pane = usePaneMotion({ side, mode, instant, panelRef });
  return (
    <div data-volli-shell="">
      <button ref={triggerRef} data-trigger={side}>
        Toggle
      </button>
      <main
        ref={pane.contentRef}
        data-paper=""
        style={{ marginLeft: pane.layoutPinned ? 240 : 0 }}
      />
      <div ref={panelRef} data-side={side} style={{ width: 240 }}>
        <div className="glass">
          <input defaultValue="Resident" />
        </div>
      </div>
      <span data-layout={pane.layoutPinned} data-moving={pane.moving} />
    </div>
  );
}
async function show(side: "left" | "right", mode: PaneMode, instant = false) {
  await act(async () => root.render(<Harness side={side} mode={mode} instant={instant} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  runs = [];
  paperShift = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-paper"))
      return new DOMRect(Number.parseFloat(this.style.marginLeft) + paperShift, 46, 800, 700);
    if (this.hasAttribute("data-trigger"))
      return new DOMRect(this.dataset.trigger === "left" ? 160 : 970, 8, 28, 28);
    const side = this.dataset.side ?? this.closest<HTMLElement>("[data-side]")?.dataset.side;
    if (side) return new DOMRect(side === "left" ? 60 : 700, 46, 240, 700);
    if (this.hasAttribute("data-pane-pour-shell")) return new DOMRect(80, 50, 150, 450);
    return new DOMRect();
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const isPaper = this.hasAttribute("data-paper");
      const animation = {
        cancel: vi.fn(() => {
          if (isPaper) paperShift = 0;
        }),
        onfinish: null as (() => void) | null,
      };
      runs.push({ node: this, frames, options, animation });
      return animation;
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe.each(["left", "right"] as const)("%s pane transactions", (side) => {
  it("animates the resident glass once without a second backdrop over its contents", async () => {
    await show(side, "pinned");
    const input = host.querySelector("input");
    await show(side, "closed");
    expect(host.querySelector("input")).toBe(input);
    const paper = runs.find((run) => run.node.hasAttribute("data-volli-shell"))!;
    expect(paper.options.duration).toBe(270);
    expect(paper.frames).toHaveLength(65);
    expect(
      paper.frames.every((frame) =>
        Object.keys(frame).every((key) => key === "offset" || key === `--${side}-pane-push`),
      ),
    ).toBe(true);
    expect(runs).toHaveLength(1);
    expect(document.querySelectorAll(".glass")).toHaveLength(1);
    expect(document.querySelector("[data-pane-pour-shell]")).toBeNull();
    expect(document.querySelector('[data-glass-blur="off"]')).toBeNull();
    expect(host.querySelector("button")?.hasAttribute("disabled")).toBe(false);
  });
  it.each([0.1, 0.4, 0.9])(
    "reverses at %s presentation without letting a stale finish clear the new run",
    async (progress) => {
      await show(side, "closed");
      await show(side, "pinned");
      const first = runs.findLast((run) => run.node.hasAttribute("data-volli-shell"))!;
      host
        .querySelector<HTMLElement>("[data-volli-shell]")!
        .style.setProperty(`--${side}-pane-push`, `${240 * progress}px`);
      await show(side, "closed");
      const latest = runs.findLast((run) => run.node.hasAttribute("data-volli-shell"))!;
      expect(latest).not.toBe(first);
      expect(first.animation.cancel).toHaveBeenCalled();
      await act(async () => first.animation.onfinish?.());
      expect(latest.animation.cancel).not.toHaveBeenCalled();
      await act(async () => latest.animation.onfinish?.());
      expect(host.querySelector("[data-moving]")?.getAttribute("data-moving")).toBe("false");
    },
  );
  it("keeps the push endpoint out of the peek transition until a real peek starts", async () => {
    await show(side, "closed");
    await show(side, "pinned");
    const panel = host.querySelector<HTMLElement>("[data-side]")!;
    expect(panel.hasAttribute("data-pane-pin-motion")).toBe(true);
    await show(side, "closed");
    const close = runs.findLast((run) => run.node.hasAttribute("data-volli-shell"))!;
    await act(async () => close.animation.onfinish?.());
    expect(panel.hasAttribute("data-pane-pin-motion")).toBe(true);
    expect(
      host.querySelector("[data-volli-shell]")?.hasAttribute(`data-${side}-pane-push-active`),
    ).toBe(false);
    await show(side, "peeking");
    expect(panel.hasAttribute("data-pane-pin-motion")).toBe(false);
    await show(side, "closed");
    expect(panel.hasAttribute("data-pane-pin-motion")).toBe(false);
  });
  it("reserves paper without withdrawing an already visible peek", async () => {
    await show(side, "closed");
    await show(side, "peeking");
    const input = host.querySelector("input");
    await show(side, "pinned");
    const panel = host.querySelector<HTMLElement>("[data-side]")!;
    expect(Number(panel.style.getPropertyValue("--pane-push-factor"))).toBe(0);
    expect(panel.style.getPropertyValue("--pane-push-offset")).toBe("0px");
    expect(host.querySelector("input")).toBe(input);
    expect(
      runs.findLast((run) => run.node.hasAttribute("data-volli-shell"))?.options.duration,
    ).toBe(270);
    expect(runs.some((run) => run.node.hasAttribute("data-pane-pour-shell"))).toBe(false);
  });
  it("reverses a peek-to-pin push from the pane's own presentation", async () => {
    await show(side, "closed");
    await show(side, "peeking");
    const panel = host.querySelector<HTMLElement>("[data-side]")!;
    const shell = host.querySelector<HTMLElement>("[data-volli-shell]")!;
    Object.defineProperties(panel, {
      offsetParent: { value: shell },
      offsetLeft: { value: side === "left" ? 60 : 700 },
      offsetWidth: { value: 240 },
    });
    await show(side, "pinned");
    shell.style.setProperty(`--${side}-pane-push`, "120px");
    await show(side, "closed");
    const direction = side === "left" ? 1 : -1;
    expect(Number(panel.style.getPropertyValue("--pane-push-factor"))).toBe(2 * direction);
    expect(panel.style.getPropertyValue("--pane-push-offset")).toBe(`${-240 * direction}px`);
  });
  it("keyboard/reduced/native instant paths and resize cancel every transient owner", async () => {
    await show(side, "closed");
    await show(side, "pinned", true);
    expect(runs).toHaveLength(0);
    await show(side, "closed");
    expect(runs.length).toBeGreaterThan(0);
    await show(side, "pinned", true);
    expect(document.querySelector("[data-pane-pour-shell]")).toBeNull();
    expect(host.querySelector("[data-layout]")?.getAttribute("data-layout")).toBe("true");
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(host.querySelector("[data-moving]")?.getAttribute("data-moving")).toBe("false");
  });
});

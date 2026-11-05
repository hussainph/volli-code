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
  const pane = usePaneMotion({ side, mode, instant, panelRef, triggerRef });
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
      {pane.decoration}
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
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-paper"))
        return new DOMRect(Number.parseFloat(this.style.marginLeft) + paperShift, 46, 800, 700);
      if (this.hasAttribute("data-trigger"))
        return new DOMRect(this.dataset.trigger === "left" ? 160 : 970, 8, 28, 28);
      const side = this.dataset.side ?? this.closest<HTMLElement>("[data-side]")?.dataset.side;
      if (side) return new DOMRect(side === "left" ? 60 : 700, 46, 240, 700);
      if (this.hasAttribute("data-pane-pour-shell")) return new DOMRect(80, 50, 150, 450);
      return new DOMRect();
    },
  );
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
  it("preserves residency and material, with separate width and decorative owners", async () => {
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
    const shell = runs.find((run) => run.node.hasAttribute("data-pane-pour-shell"))!;
    expect(shell.options.duration).toBe(110);
    expect(shell.node.querySelector("input")).toBeNull();
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

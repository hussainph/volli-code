// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Tab, TabStrip } from "./tab-strip";
import { TabCascadeContext } from "./tab-cascade";
import { GLASS_MOTION } from "@renderer/lib/glass-motion";
import { beginPaneResize } from "@renderer/lib/pane-resize";

interface Playback {
  node: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: Animation;
  finish(): void;
}
let host: HTMLDivElement;
let root: Root;
let width: number;
let plays: Playback[];
let resized: (() => void)[];
let ids: string[];
let renderIds: (next: string[]) => void;
let rejected: boolean;
const GAP = 2;
const childrenOf = (list: Element) => Array.from(list.children) as HTMLElement[];
function currentWidth(slot: HTMLElement): number {
  const running = plays
    .toReversed()
    .find((play) => play.node === slot && play.animation.playState === "running");
  if (running) {
    const at = Math.min(
      64,
      Math.round((Number(running.animation.currentTime ?? 0) / GLASS_MOTION.pin) * 64),
    );
    return Number.parseFloat(String(running.frames[at]?.width ?? 0));
  }
  if (slot.style.width) return Number.parseFloat(slot.style.width);
  if (slot.querySelector('[data-icon-only="true"]')) return 36;
  const list = slot.parentElement;
  const slots = list
    ? childrenOf(list).filter((node) => !node.hasAttribute("data-tab-retiring"))
    : [];
  const movable = slots.filter((node) => !node.querySelector('[data-icon-only="true"]'));
  return Math.min(240, (width - 36 - (slots.length - 1) * GAP) / Math.max(1, movable.length));
}
function slotOf(element: HTMLElement): HTMLElement {
  let slot = element;
  while (slot.parentElement && slot.parentElement.getAttribute("role") !== "tablist")
    slot = slot.parentElement;
  return slot;
}
function geometry(element: HTMLElement): DOMRect {
  let x = 0,
    w = width;
  const list = element.closest('[role="tablist"]');
  if (list && list !== element) {
    const slot = slotOf(element);
    w = currentWidth(slot);
    for (const sibling of childrenOf(list)) {
      if (sibling === slot) break;
      const play = plays
        .toReversed()
        .find((item) => item.node === sibling && item.animation.playState === "running");
      const at = play
        ? Math.min(
            64,
            Math.round((Number(play.animation.currentTime ?? 0) / GLASS_MOTION.pin) * 64),
          )
        : 64;
      const margin = play
        ? Number.parseFloat(String(play.frames[at]?.marginInlineEnd ?? 0))
        : Number.parseFloat(sibling.style.marginInlineEnd) || 0;
      x += currentWidth(sibling) + GAP + margin;
    }
    if (element.dataset.slot === "tab-close") {
      x += w - 22;
      w = 20;
    }
  }
  return {
    x,
    y: 0,
    left: x,
    top: 0,
    width: w,
    height: 28,
    right: x + w,
    bottom: 28,
    toJSON: () => ({}),
  };
}
function NewControl() {
  const cascade = React.useContext(TabCascadeContext);
  return (
    <button
      data-new=""
      onClick={(event) => {
        cascade?.open(event.detail > 0);
        renderIds([...ids, `tab-${ids.length + 10}`]);
      }}
    >
      New
    </button>
  );
}
function Fixture() {
  const [tabs, setTabs] = React.useState(ids);
  renderIds = (next) => {
    ids = next;
    setTabs(next);
  };
  return (
    <TabStrip label="Cascade tabs" actions={<NewControl />}>
      <div>
        <Tab label="Board" iconOnly closable={false} active tabStop onActivate={() => {}} />
      </div>
      {tabs.map((id) => (
        <div key={id}>
          <Tab
            label={id}
            active={false}
            tabStop={false}
            onActivate={() => {}}
            onClose={() => {
              if (!rejected) renderIds(ids.filter((candidate) => candidate !== id));
            }}
          />
        </div>
      ))}
    </TabStrip>
  );
}
function click(target: Element, pointer = true) {
  act(() =>
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: pointer ? 1 : 0 })),
  );
}
function finish() {
  act(() => {
    for (const play of plays) if (play.animation.playState === "running") play.finish();
  });
}
function closeButtons() {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="tab"] [data-slot="tab-close"]'));
}
function closeAt(x: number) {
  const target = closeButtons().find((button) => {
    const box = button.getBoundingClientRect();
    return x >= box.left && x <= box.right;
  });
  if (!target) throw new Error(`No close at ${x}`);
  click(target);
}
function leave() {
  act(() =>
    host
      .querySelector('[data-slot="tab-strip"]')!
      .dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  width = 900;
  plays = [];
  resized = [];
  ids = ["One", "Two", "Three", "Four", "Five"];
  rejected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return geometry(this);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: vi.fn(function (
      this: HTMLElement,
      frames: Keyframe[],
      options: KeyframeAnimationOptions,
    ) {
      const animation = {
        currentTime: 0,
        playState: "running",
        onfinish: null,
        cancel: vi.fn(() => {
          Object.assign(animation, { playState: "idle" });
        }),
      } as unknown as Animation;
      plays.push({
        node: this,
        frames,
        options,
        animation,
        finish() {
          Object.assign(animation, { currentTime: GLASS_MOTION.pin, playState: "finished" });
          animation.onfinish?.(new Event("finish") as AnimationPlaybackEvent);
        },
      });
      return animation;
    }),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Fixture />));
  const list = host.querySelector<HTMLElement>('[role="tablist"]')!;
  list.style.columnGap = `${GAP}px`;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute("data-motion");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("pointer tab width cascade", () => {
  it("grows a new tab from zero while existing widths shrink, without scaling captions", () => {
    const before = closeButtons()[0]!.getBoundingClientRect().width;
    click(host.querySelector("[data-new]")!);
    const newPlay = plays.find((play) => play.node.textContent?.includes("tab-15"))!;
    expect(newPlay.frames[0]?.width).toBe("0px");
    const existing = plays.find((play) => play.node.textContent?.includes("One"))!;
    expect(Number.parseFloat(String(existing.frames.at(-1)?.width))).toBeLessThan(
      Number.parseFloat(String(existing.frames[0]?.width)),
    );
    for (const play of plays) {
      expect(play.options.duration).toBeLessThanOrEqual(270);
      expect(play.frames).toHaveLength(65);
      expect(play.frames.every((frame) => !("transform" in frame))).toBe(true);
    }
    finish();
    expect(closeButtons()[0]!.getBoundingClientRect().width).toBe(before);
    expect(host.querySelectorAll('[style*="flex: 0 0 auto"]')).toHaveLength(0);
  });
  it("closes three consecutive tabs at one pointer position and holds the surviving widths", () => {
    const target = closeButtons()[1]!;
    const x = target.getBoundingClientRect().left + 10;
    const slotWidth = currentWidth(slotOf(target));
    for (const label of ["Two", "Three", "Four"]) {
      closeAt(x);
      expect(ids).not.toContain(label);
      const ghost = host.querySelector<HTMLElement>("[data-tab-retiring]")!;
      expect(ghost.closest('[role="tablist"]')).not.toBeNull();
      expect(ghost.querySelector('[role="tab"]')).toBeNull();
      expect(ghost.getAttribute("aria-hidden")).toBe("true");
      const play = plays.find((item) => item.node === ghost)!;
      expect(play.frames[0]?.width).toBe(`${slotWidth}px`);
      expect(play.frames.at(-1)?.width).toBe("0px");
      finish();
      for (const button of closeButtons()) expect(currentWidth(slotOf(button))).toBe(slotWidth);
    }
    expect(ids).toEqual(["One", "Five"]);
    const remaining = closeButtons()[1]!.getBoundingClientRect();
    expect(x).toBeGreaterThanOrEqual(remaining.left);
    expect(x).toBeLessThanOrEqual(remaining.right);
    expect(host.querySelector("[data-tab-retiring]")).toBeNull();
  });
  it("fills on pointer exit, or after a fresh one-second idle window", () => {
    width = 660;
    click(closeButtons()[1]!);
    finish();
    const retained = currentWidth(slotOf(closeButtons()[0]!));
    const beforeIdle = plays.length;
    act(() => vi.advanceTimersByTime(800));
    act(() =>
      host
        .querySelector('[data-slot="tab-strip"]')!
        .dispatchEvent(new MouseEvent("pointermove", { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(800));
    expect(currentWidth(slotOf(closeButtons()[0]!))).toBe(retained);
    expect(plays).toHaveLength(beforeIdle);
    act(() => vi.advanceTimersByTime(200));
    expect(plays.length).toBeGreaterThan(beforeIdle);
    const refill = plays.at(-1)!;
    expect(Number.parseFloat(String(refill.frames.at(-1)?.width))).toBeGreaterThan(retained);
    finish();
    click(closeButtons()[1]!);
    finish();
    const count = plays.length;
    leave();
    expect(plays.length).toBeGreaterThan(count);
    finish();
    expect(host.querySelectorAll('[style*="flex: 0 0 auto"]')).toHaveLength(0);
  });
  it("retargets an interrupted open from its presented width, ignoring a stale completion", () => {
    click(host.querySelector("[data-new]")!);
    const old = plays.find((play) => play.node.textContent === "One")!;
    Object.assign(old.animation, { currentTime: 135 });
    const presented = currentWidth(old.node);
    const stale = old.animation.onfinish;
    click(host.querySelector("[data-new]")!);
    const replacement = plays.toReversed().find((play) => play.node === old.node)!;
    expect(replacement.frames[0]?.width).toBe(`${presented}px`);
    stale?.call(old.animation, new Event("finish") as AnimationPlaybackEvent);
    expect(replacement.animation.playState).toBe("running");
    finish();
  });
  it("cancels width ownership synchronously on a pane/window resize", () => {
    click(closeButtons()[1]!);
    finish();
    act(() => {
      width = 640;
      for (const notify of resized) notify();
    });
    expect(host.querySelectorAll('[style*="flex: 0 0 auto"]')).toHaveLength(0);
    const count = plays.length;
    let end!: () => void;
    act(() => {
      end = beginPaneResize({});
    });
    click(host.querySelector("[data-new]")!);
    expect(plays).toHaveLength(count);
    act(() => end());
  });
  it("makes keyboard/programmatic operations and reduced motion instant", () => {
    click(host.querySelector("[data-new]")!, false);
    click(closeButtons()[1]!, false);
    act(() => renderIds(ids.slice(0, -1)));
    expect(plays).toHaveLength(0);
    document.documentElement.dataset.motion = "off";
    click(host.querySelector("[data-new]")!);
    click(closeButtons()[1]!);
    expect(plays).toHaveLength(0);
    expect(host.querySelector("[data-tab-retiring]")).toBeNull();
  });
  it("does not retire a close rejected by a dirty-file guard", () => {
    rejected = true;
    click(closeButtons()[1]!);
    expect(ids).toContain("Two");
    expect(host.querySelector("[data-tab-retiring]")).toBeNull();
    act(() => vi.advanceTimersByTime(GLASS_MOTION.tabCloseHold));
    expect(host.querySelectorAll('[style*="flex: 0 0 auto"]')).toHaveLength(0);
  });
});

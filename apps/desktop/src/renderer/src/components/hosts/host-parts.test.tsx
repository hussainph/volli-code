// @vitest-environment jsdom
/**
 * Reduced motion in the host surfaces' shared drawings (VC-700): Motion's
 * `reducedMotion="user"` skips only transforms, so every transition goes
 * through `useMotionTiming`, which lands opacity, blur and a drawn path at
 * once too, and leaves normal motion's timing as it was. The person's
 * preference is mocked: jsdom has none.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const preference = vi.hoisted(() => ({ reduce: true as boolean | null }));

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => preference.reduce,
}));

import { ActiveStepMark, INSTANT, StepMark, SwapText, useMotionTiming } from "./host-parts";

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  preference.reduce = true;
});

function render(node: React.ReactNode): HTMLElement {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  act(() => root!.render(node));
  return container;
}

const frames = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("reduced motion in the host drawings", () => {
  it("lands every transition at once when the person asks for less motion, else keeps its timing", () => {
    const timing = { duration: 0.2, delay: 0.08 };
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useMotionTiming()(timing));
      return null;
    }
    render(<Probe />);
    preference.reduce = false;
    render(<Probe key="normal" />);
    // No preference known yet (Motion's first read) is normal motion too.
    preference.reduce = null;
    render(<Probe key="unknown" />);
    expect(seen[0]).toBe(INSTANT);
    expect(INSTANT).toEqual({ duration: 0, delay: 0 });
    expect(seen.slice(1)).toEqual([timing, timing]);
    expect(seen[1]).toBe(timing);
  });

  it("swaps text with no crossfade: the old words go at once, the new ones show whole", async () => {
    const view = render(<SwapText>Connecting…</SwapText>);
    render(<SwapText>Connected as deploy</SwapText>);
    await frames(60);
    expect(view.textContent).toBe("Connected as deploy");
    const shown = view.querySelector<HTMLElement>("span > span")!;
    expect(shown.style.opacity).not.toBe("0");
    expect(shown.style.filter).not.toContain("blur(3px)");
  });

  it("stills the running ring's spin, and swaps a step's mark at once", async () => {
    const view = render(<ActiveStepMark />);
    expect(view.querySelector("svg")?.getAttribute("class")).toContain(
      "motion-reduce:animate-none",
    );
    render(<StepMark status="active" />);
    render(<StepMark status="done" />);
    await frames(60);
    expect(view.querySelectorAll("[data-slot='step-mark'] > *")).toHaveLength(1);
  });
});

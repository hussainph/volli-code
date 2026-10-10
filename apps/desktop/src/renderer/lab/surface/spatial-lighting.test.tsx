// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { LightHandles, SpatialLayers, useSpatialLighting } from "./spatial-lighting";

const SETTINGS = {
  angle: 135,
  elevation: 20,
  crown: 0.12,
  rim: 0.7,
  shadow: 0.8,
  tint: 0.18,
  workElevation: 6,
  workRim: 0.25,
  workShadow: 0.45,
  workTint: 0.04,
};
function Fixture({ settings = SETTINGS }: { settings?: typeof SETTINGS }) {
  const stage = React.useRef<HTMLDivElement>(null);
  useSpatialLighting(stage, null, settings, false, {
    keyX: 0.22,
    keyY: 0.22,
    returnX: 0.78,
    returnY: 0.78,
  });
  return (
    <div ref={stage} data-testid="stage">
      <LightHandles />
      <div data-spatial-body="6">
        <SpatialLayers />
      </div>
    </div>
  );
}

it("coalesces placement input, caches bounds and writes only leaf transforms/opacity; no idle loop", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  let invalidate: () => void = vi.fn();
  let rigBuilds = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        invalidate = callback;
        rigBuilds++;
      }
      observe() {}
      disconnect() {}
    },
  );
  let objectX = 100;
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const stage = this.dataset.testid === "stage";
      return {
        x: stage ? 0 : objectX,
        y: stage ? 0 : 100,
        width: stage ? 1000 : 200,
        height: stage ? 700 : 100,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      };
    });
  function flush() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Fixture />));
    flush();
    const reads = measure.mock.calls.length;
    const handle = host.querySelector<HTMLButtonElement>('[data-spatial-source="key"]')!;
    const leaf = host.querySelector<HTMLElement>('[data-light="key"][data-part="shadow"]')!;
    const before = leaf.style.transform;
    for (let step = 0; step < 10; step++)
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(frames.size).toBe(1);
    flush();
    expect(leaf.style.transform).not.toBe(before);
    expect(measure.mock.calls.length).toBe(reads);
    expect(frames.size).toBe(0);
    for (const node of host.querySelectorAll<HTMLElement>("[data-light][data-part]")) {
      expect([...node.style]).toEqual(expect.arrayContaining(["opacity"]));
      expect(
        [...node.style].every((property) => property === "transform" || property === "opacity"),
      ).toBe(true);
    }
    const positioned = leaf.style.transform;
    await act(async () =>
      root.render(<Fixture settings={{ ...SETTINGS, rim: 0.2, shadow: 0.4 }} />),
    );
    flush();
    expect(rigBuilds).toBe(1);
    expect(measure.mock.calls.length).toBe(reads);
    expect(leaf.style.transform).toBe(positioned);
    objectX = 700;
    invalidate();
    flush();
    expect(measure.mock.calls.length).toBeGreaterThan(reads);
    expect(leaf.style.transform).not.toBe(positioned);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(frames.size).toBe(1);
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    measure.mockRestore();
    vi.unstubAllGlobals();
  }
});

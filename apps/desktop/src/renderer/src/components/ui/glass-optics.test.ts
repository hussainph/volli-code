// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { attachGlassOptics } from "./glass-optics";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(width = 60, height = 40) {
  const node = document.createElement("div");
  node.style.borderRadius = "12px";
  Object.defineProperty(node, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(node, "offsetHeight", { configurable: true, value: height });
  document.body.append(node);
  return node;
}
function canvas() {
  const make = vi.fn((width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: make,
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,fixture",
  );
  return make;
}
describe("bounded full-tier glass optics", () => {
  it("reuses geometry across remounts and unchanged resize callbacks; never listens to scroll", () => {
    const make = canvas(),
      callbacks: (() => void)[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const node = fixture();
    const stop = attachGlassOptics(node);
    const url = node.style.getPropertyValue("--glass-refraction");
    expect(url).toMatch(/^url\(#volli-glass-optic-/);
    expect(make).toHaveBeenCalledTimes(1);
    node.dispatchEvent(new Event("scroll"));
    callbacks[0]();
    expect(make).toHaveBeenCalledTimes(1);
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(node.style.getPropertyValue("--glass-refraction")).toBe("");
    const stopAgain = attachGlassOptics(node);
    expect(make).toHaveBeenCalledTimes(1);
    expect(node.style.getPropertyValue("--glass-refraction")).toBe(url);
    Object.defineProperty(node, "offsetWidth", { value: 62 });
    callbacks[1]();
    expect(make).toHaveBeenCalledTimes(2);
    expect(node.style.getPropertyValue("--glass-refraction")).not.toBe(url);
    stopAgain();
    node.remove();
  });
  it("keeps oversized overlays and nested/reduced-transparency material out of SVG", () => {
    const make = canvas();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const large = fixture(801, 700);
    const stopLarge = attachGlassOptics(large);
    expect(make).not.toHaveBeenCalled();
    stopLarge();
    large.remove();
    const outer = document.createElement("div");
    outer.className = "glass";
    const nested = fixture(64, 40);
    outer.append(nested);
    document.body.append(outer);
    attachGlassOptics(nested)();
    expect(make).not.toHaveBeenCalled();
    outer.remove();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const reduced = fixture(68, 40);
    attachGlassOptics(reduced)();
    expect(make).not.toHaveBeenCalled();
    reduced.remove();
  });
});

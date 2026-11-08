import { createHash } from "node:crypto";
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
    expect(make).not.toHaveBeenCalled();
    callbacks[0](); // Initial pre-paint observer delivery, not a commit-time DOM read.
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
    callbacks[1]();
    expect(make).toHaveBeenCalledTimes(1);
    expect(node.style.getPropertyValue("--glass-refraction")).toBe(url);
    Object.defineProperty(node, "offsetWidth", { value: 62 });
    callbacks[1]();
    expect(make).toHaveBeenCalledTimes(2);
    expect(node.style.getPropertyValue("--glass-refraction")).not.toBe(url);
    stopAgain();
    Object.defineProperty(node, "offsetWidth", { value: 64 });
    callbacks[1](); // A queued callback after disconnect cannot acquire a map.
    expect(make).toHaveBeenCalledTimes(2);
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

it("preserves the exact displacement bytes while skipping the neutral interior", () => {
  vi.stubGlobal("ResizeObserver", undefined); // Synchronous compatibility path.
  const fixtures = [
    [71, 49, 12, 1, "042068e6bf63432028b4e1e6fb75a9f9aeeb547b47c2b65ddab4a58a91698ada"],
    [173, 217, 12, 2, "3d9f7e241314b89d98cee3086695bc27ab4014b25ba7e31ce2e20aee9dff606d"],
    [340, 500, 12, 2, "bdfea69ddfa75d5db653074b18a117c744ee318db3897df138166c78f1020120"],
    [420, 240, 70, 2, "7674bc81cf8e794674e67c94ad9762c24bd3cd6c9a56fc68484fc409f5b10f17"],
    [84, 84, 42, 2, "ed7573f2269ce1a711870050d2231710fd1e6a3a27a90a695470f973a8d0af9e"],
    [23, 25, 6, 1, "d127d1213a6c7de27550ac70abeb2977cf82df6f3e540177126b12d1c1cd6d21"],
  ] as const;
  for (const [w, h, r, dpr, hash] of fixtures) {
    vi.stubGlobal("devicePixelRatio", dpr);
    const make = canvas();
    const node = fixture(w, h);
    node.style.borderRadius = `${r}px`;
    const stop = attachGlassOptics(node);
    const data = make.mock.results.at(-1)!.value.data;
    expect(createHash("sha256").update(data).digest("hex"), [w, h, r, dpr].join("/")).toBe(hash);
    stop();
    node.remove();
    vi.restoreAllMocks();
  }
});

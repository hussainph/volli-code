import { describe, expect, it } from "vite-plus/test";

import { toTerminalBackend } from "./engine";

describe("toTerminalBackend", () => {
  it("admits the backends the seam knows how to reason about", () => {
    expect(toTerminalBackend("webgpu")).toBe("webgpu");
    expect(toTerminalBackend("webgl2")).toBe("webgl2");
  });

  // A renderer that got neither WebGPU nor WebGL2 still goes ready. That is an
  // answer — zero contexts, forever — and must not read as "still resolving",
  // which would leave a caller waiting on `pending` waiting for good.
  it("keeps 'no backend at all' as a resolved answer rather than an unresolved one", () => {
    expect(toTerminalBackend("none")).toBe("none");
  });

  it("treats an unknown or absent backend as unresolved rather than trusting it", () => {
    expect(toTerminalBackend("webgpu2")).toBeNull();
    expect(toTerminalBackend("")).toBeNull();
    expect(toTerminalBackend(null)).toBeNull();
  });
});

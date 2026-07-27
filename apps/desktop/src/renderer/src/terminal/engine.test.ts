import { describe, expect, it } from "vite-plus/test";

import { toTerminalBackend } from "./engine";

describe("toTerminalBackend", () => {
  it("admits the backends the seam knows how to reason about", () => {
    expect(toTerminalBackend("webgpu")).toBe("webgpu");
    expect(toTerminalBackend("webgl2")).toBe("webgl2");
  });

  it("treats an unknown or absent backend as unresolved rather than trusting it", () => {
    expect(toTerminalBackend("webgpu2")).toBeNull();
    expect(toTerminalBackend("")).toBeNull();
    expect(toTerminalBackend(null)).toBeNull();
  });
});

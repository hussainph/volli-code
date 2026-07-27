import { describe, expect, it } from "vite-plus/test";

import { polledBackend, toTerminalBackend } from "./engine";

describe("toTerminalBackend", () => {
  it("admits the backends the seam knows how to reason about", () => {
    expect(toTerminalBackend("webgpu")).toBe("webgpu");
    expect(toTerminalBackend("webgl2")).toBe("webgl2");
  });

  // An ANNOUNCED "none" means the renderer got neither WebGPU nor WebGL2 and
  // went ready anyway. That is an answer — zero contexts, forever — and must
  // not read as "still resolving", which would leave a caller waiting on
  // `pending` waiting for good.
  it("keeps an announced 'no backend at all' as a resolved answer", () => {
    expect(toTerminalBackend("none")).toBe("none");
  });

  it("treats an unknown or absent backend as unresolved rather than trusting it", () => {
    expect(toTerminalBackend("webgpu2")).toBeNull();
    expect(toTerminalBackend("")).toBeNull();
    expect(toTerminalBackend(null)).toBeNull();
  });
});

describe("polledBackend", () => {
  it("passes a really-resolved backend through unchanged", () => {
    expect(polledBackend("webgpu")).toBe("webgpu");
    expect(polledBackend("webgl2")).toBe("webgl2");
  });

  // The whole reason this converter exists. restty initialises its runtime
  // state to backend "none" synchronously and only overwrites it inside async
  // init, so a POLLED "none" is almost always "hasn't started resolving yet",
  // not "tried everything and got nothing". Trusting it reports free GPU
  // capacity for the entire acquisition window, while every terminal on screen
  // is racing for a context. Unresolved is the safe reading; the renderer's
  // `backend` event delivers the real answer, a genuine "none" included.
  it("refuses to read a polled 'none' as an answer, because it is a placeholder", () => {
    expect(polledBackend("none")).toBeNull();
  });

  it("treats an unknown or absent backend as unresolved, same as the event path", () => {
    expect(polledBackend("webgpu2")).toBeNull();
    expect(polledBackend(null)).toBeNull();
  });
});

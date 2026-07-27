import { describe, expect, it } from "vite-plus/test";

import { polledBackend, sameGpuState, toTerminalBackend } from "./engine";
import type { TerminalBackend, TerminalGpuState } from "./engine";

/** An engine with a live renderer reporting `backend`. */
const live = (backend: TerminalBackend | null): TerminalGpuState => ({
  hasRenderer: true,
  backend,
});
/** No renderer at all — never attached, mid-rebuild, or disposed. */
const gone: TerminalGpuState = { hasRenderer: false, backend: null };

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

describe("sameGpuState", () => {
  it("calls a reading unchanged only when both halves held still", () => {
    expect(sameGpuState({ hasRenderer: true, backend: "webgpu" }, live("webgpu"))).toBe(true);
    expect(sameGpuState({ hasRenderer: false, backend: null }, gone)).toBe(true);
  });

  it("sees a backend resolving under a renderer that stayed live", () => {
    expect(sameGpuState(live(null), live("webgpu"))).toBe(false);
    expect(sameGpuState(live("webgpu"), live("webgl2"))).toBe(false);
    expect(sameGpuState(live("webgl2"), live("none"))).toBe(false);
  });

  // REGRESSION, and the reason this compares the PAIR. A device-loss rebuild
  // destroys the renderer and creates a new one; `polledBackend` folds restty's
  // birth-state "none" to null, so the backend is very often null on BOTH sides
  // of the whole transition. Compared on `backend` alone, the teardown and the
  // re-creation are each "nothing changed" — the engine announces neither, and
  // every pushed GPU-pressure reading stays stale across a GPU process crash.
  it("sees the renderer itself come and go while the backend never moves", () => {
    expect(sameGpuState(live(null), gone)).toBe(false);
    expect(sameGpuState(gone, live(null))).toBe(false);
    // Both fields differ at once — dispose from a resolved renderer.
    expect(sameGpuState(live("webgpu"), gone)).toBe(false);
  });

  // The distinction gpu pressure is built on: same backend value, opposite
  // meanings. Nothing may collapse these two into one reading.
  it("keeps 'never asked' apart from 'asked, still waiting'", () => {
    expect(gone.backend).toBe(live(null).backend);
    expect(sameGpuState(gone, live(null))).toBe(false);
  });
});

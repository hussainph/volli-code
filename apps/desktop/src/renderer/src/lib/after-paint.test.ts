import { afterEach, expect, it, vi } from "vite-plus/test";
import { afterPaint } from "./after-paint";
afterEach(() => vi.unstubAllGlobals());
it("waits across the shell's first paint and cleans its frame on completion", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  const cancel = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancel);
  let ready = false;
  const pending = afterPaint(new AbortController().signal).then(() => {
    ready = true;
  });
  frames[0](0);
  await Promise.resolve();
  expect(ready).toBe(false);
  frames[1](16);
  await pending;
  expect(ready).toBe(true);
  expect(cancel).toHaveBeenCalledWith(2);
});
it("cancels pending work when its transient closes before the second frame", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", () => 7);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const controller = new AbortController();
  const pending = afterPaint(controller.signal);
  controller.abort();
  await pending;
  expect(cancel).toHaveBeenCalledWith(7);
  cancel.mockClear();
  await afterPaint(controller.signal);
  expect(cancel).not.toHaveBeenCalled();
});

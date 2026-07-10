import { describe, expect, it, vi } from "vite-plus/test";
import { createTerminalDataRouter } from "./data-router";

describe("createTerminalDataRouter", () => {
  it("routes an event only to the matching session's handler", () => {
    const router = createTerminalDataRouter();
    const a = vi.fn();
    const b = vi.fn();
    router.register("a", a);
    router.register("b", b);

    router.dispatch({ sessionId: "a", data: "hello" });

    expect(a).toHaveBeenCalledExactlyOnceWith("hello");
    expect(b).not.toHaveBeenCalled();
  });

  it("silently drops events for an unregistered session", () => {
    const router = createTerminalDataRouter();
    expect(() => router.dispatch({ sessionId: "ghost", data: "x" })).not.toThrow();
  });

  it("replaces the handler when a session re-registers", () => {
    const router = createTerminalDataRouter();
    const first = vi.fn();
    const second = vi.fn();
    router.register("a", first);
    router.register("a", second);

    router.dispatch({ sessionId: "a", data: "x" });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("x");
  });

  it("stops routing after unregister and reports membership via has()", () => {
    const router = createTerminalDataRouter();
    const handler = vi.fn();
    router.register("a", handler);
    expect(router.has("a")).toBe(true);

    router.unregister("a");
    expect(router.has("a")).toBe(false);
    router.dispatch({ sessionId: "a", data: "x" });
    expect(handler).not.toHaveBeenCalled();
  });
});

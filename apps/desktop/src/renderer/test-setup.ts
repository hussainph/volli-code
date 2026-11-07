import { beforeEach, vi } from "vite-plus/test";

// Radix measures overlay arrows with ResizeObserver. jsdom has no layout or
// observer; geometry tests supply their own measured implementation instead.
// Install before each test because individual fixtures restore stubbed globals.
beforeEach(() => {
  if (typeof window !== "undefined" && typeof ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
});

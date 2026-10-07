import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { app } = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock("electron", () => ({ app }));

import { assertRendererAppStateKey } from "./app-state-key-guard";

beforeEach(() => {
  app.isPackaged = false;
});

describe("renderer app_state key boundary", () => {
  it("accepts exact live keys and registered prefixes", () => {
    expect(() => assertRendererAppStateKey("volli:ui")).not.toThrow();
    expect(() => assertRendererAppStateKey("volli:vc354-perf:sidebar")).not.toThrow();
  });

  it.each(["volli:unclassified", "theme_editor", "volli:runtime-preferences:old"])(
    "throws for %s in tests/development",
    (key) => {
      expect(() => assertRendererAppStateKey(key)).toThrow(
        "Unregistered or retired app_state write",
      );
    },
  );

  it("only logs in packaged builds, never blocks the historical write", () => {
    app.isPackaged = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => assertRendererAppStateKey("volli:unclassified")).not.toThrow();
      expect(warn).toHaveBeenCalledWith("[app-state] unregistered or retired app_state write", {
        appState: "volli:unclassified",
      });
    } finally {
      warn.mockRestore();
    }
  });
});

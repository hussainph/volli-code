// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { RUNNER_RESIDENT_APP_STATE_KEY } from "@volli/shared";
import { seedAppStateCache } from "@renderer/lib/app-state-storage";
import { RunnerAvailability } from "./runner-availability";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

describe("runner availability control", () => {
  it("defaults on, shows only acknowledged changes, and surfaces a failed save", async () => {
    seedAppStateCache({ [RUNNER_RESIDENT_APP_STATE_KEY]: "true" });
    let finish: ((answer: { ok: true } | { ok: false; error: string }) => void) | undefined;
    const set = vi.fn(
      () =>
        new Promise<{ ok: true } | { ok: false; error: string }>((done) => {
          finish = done;
        }),
    );
    const previous = window.api;
    Object.defineProperty(window, "api", { configurable: true, value: { appState: { set } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RunnerAvailability />));
      const toggle = () => container.querySelector<HTMLButtonElement>("[role=switch]")!;
      expect(toggle().getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle().click());
      expect(set).toHaveBeenCalledWith(RUNNER_RESIDENT_APP_STATE_KEY, "false");
      expect(toggle().getAttribute("aria-checked")).toBe("true");
      expect(toggle().disabled).toBe(true);
      await act(async () => finish!({ ok: true }));
      expect(toggle().getAttribute("aria-checked")).toBe("false");
      await act(async () => toggle().click());
      await act(async () => finish!({ ok: false, error: "Database is read-only" }));
      expect(toggle().getAttribute("aria-checked")).toBe("false");
      expect(toastError).toHaveBeenCalledWith("Database is read-only");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Object.defineProperty(window, "api", { configurable: true, value: previous });
    }
  });
});

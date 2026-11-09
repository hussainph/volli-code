// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AsyncSection } from "./async-section";
const mocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: mocks.success } }));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.error }));

it.each([false, true])(
  "keeps raw errors disclosed and copyable, reporting clipboard failure=%s",
  async (fails) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const copy = vi.fn(async () => {
      if (fails) throw new Error("clipboard refused");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const retry = vi.fn();
    try {
      await act(async () =>
        root.render(
          <AsyncSection
            title="Commands"
            state={{ status: "error", message: "full diagnostic", onRetry: retry }}
          >
            {() => null}
          </AsyncSection>,
        ),
      );
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load commands");
      expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("full diagnostic");
      const detail = host.querySelector("details")!;
      expect(detail.open).toBe(false);
      await act(async () => detail.querySelector("summary")!.click());
      expect(detail.open).toBe(true);
      expect(detail.textContent).toContain("full diagnostic");
      await act(async () => detail.querySelector("button")!.click());
      expect(copy).toHaveBeenCalledWith("full diagnostic");
      if (fails) expect(mocks.error).toHaveBeenCalledWith("Couldn't copy error: clipboard refused");
      else expect(mocks.success).toHaveBeenCalledWith("Copied error");
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Try again"]')!.click(),
      );
      expect(retry).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(navigator, "clipboard");
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  },
);

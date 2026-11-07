// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Toaster } from "./sonner";

vi.mock("@renderer/lib/resolved-appearance", () => ({ useResolvedAppearance: () => "dark" }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Sonner stack integration", () => {
  it("keeps the upstream expanded pseudo-element a hover bridge, separate from the real toast border", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.resolve("sonner")), "utf8");
    const bridge = css.match(
      /\[data-sonner-toast\]\[data-expanded='true'\]::after\s*\{([^}]+)\}/,
    )?.[1];
    expect(bridge).toContain("height: calc(var(--gap) + 1px)");
    expect(bridge).toContain("bottom: 100%");
    expect(bridge).not.toMatch(/background|border|mask/);
    expect(css).toMatch(
      /\[data-sonner-toast\]\[data-styled='true'\]\s*\{[^}]*border: 1px solid var\(--normal-border\)/,
    );
  });

  it("retains all three expanded notices, announcements, actions and close behavior without moving focus", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const editor = document.createElement("input");
    document.body.append(editor, host);
    editor.focus();
    const root = createRoot(host);
    const open = vi.fn();
    try {
      await act(async () => root.render(<Toaster closeButton />));
      await act(async () => {
        for (let i = 0; i < 3; i++) {
          toast(`Session ${i} started`, {
            id: `sonner-stack-test-${i}`,
            duration: Infinity,
            action: { label: "Open session", onClick: () => open(i) },
          });
        }
        vi.advanceTimersByTime(20);
      });
      const stack = host.querySelector<HTMLOListElement>("[data-sonner-toaster]")!;
      expect(stack.querySelectorAll("[data-sonner-toast]")).toHaveLength(3);
      expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
      expect(document.activeElement).toBe(editor);
      await act(async () => stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      const notices = stack.querySelectorAll<HTMLElement>("[data-sonner-toast]");
      for (const notice of notices) {
        expect(notice.dataset.expanded).toBe("true");
        expect(notice.dataset.styled).toBe("true");
        expect(notice.className).toContain("data-[expanded=true]:after:!bg-none");
        expect(notice.querySelector("[data-button]")?.textContent).toBe("Open session");
        expect(notice.querySelector('[aria-label="Close toast"]')).not.toBeNull();
      }
      await act(async () => notices[0].querySelector<HTMLButtonElement>("[data-button]")!.click());
      expect(open).toHaveBeenCalledExactlyOnceWith(2);
      await act(async () =>
        notices[1].querySelector<HTMLButtonElement>('[aria-label="Close toast"]')!.click(),
      );
      expect(notices[1].dataset.removed).toBe("true");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        toast.dismiss();
        vi.advanceTimersByTime(1000);
        root.unmount();
      });
      host.remove();
      editor.remove();
    }
  });
});

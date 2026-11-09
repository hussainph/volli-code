import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vite-plus/test";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

/** Read the real portalled replacement for the retired split creation button. */
export async function withOpenTabChooser(
  element: React.ReactNode,
  check: (menu: HTMLElement) => void | Promise<void>,
): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldApi = window.api;
  if (!oldApi)
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        sessions: { listForTicket: async () => ({ ok: true, sessions: [] }) },
      },
    });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TooltipProvider>{element}</TooltipProvider>));
    const trigger = container.querySelector<HTMLElement>('[aria-label="Open a tab"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.focus();
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    await check(menu!);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (!oldApi) Reflect.deleteProperty(window, "api");
    vi.unstubAllGlobals();
  }
}

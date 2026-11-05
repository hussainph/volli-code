// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CodeIcon } from "./icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuTrigger,
} from "./context-menu";

it("retains context icons and keyboard provenance through a portaled submenu", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ContextMenu>
          <ContextMenuTrigger>File</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem icon={CodeIcon}>Open in VS Code</ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger icon={CodeIcon}>Open in…</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem icon={CodeIcon}>Editor</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>,
      ),
    );
    const trigger = host.querySelector('[data-slot="context-menu-trigger"]')!;
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 0 })),
    );
    expect(
      document.querySelector<HTMLElement>('[data-slot="context-menu-content"]')?.dataset
        .motionOrigin,
    ).toBe("keyboard");
    for (const slot of ["context-menu-item", "context-menu-sub-trigger"]) {
      const row = document.querySelector(`[data-slot="${slot}"]`)!;
      const glyph = row.querySelector("svg")!;
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
      expect(glyph.getAttribute("fill")).toBe("none");
      expect(glyph.getAttribute("stroke")).toBe("currentColor");
      expect(glyph.getAttribute("stroke-width")).toBe("1.5");
      expect(row.textContent).toContain("Open in");
    }
    const sub = document.querySelector<HTMLElement>('[data-slot="context-menu-sub-trigger"]')!;
    await act(async () => {
      sub.focus();
      sub.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(
      document.querySelector<HTMLElement>('[data-slot="context-menu-sub-content"]')?.dataset
        .motionOrigin,
    ).toBe("keyboard");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DeleteIcon } from "@renderer/components/ui/icon";

import { FileSaveGuardDialog } from "../files/save-guard-dialog";
import { ConfirmCloseDialog } from "../sessions/confirm-close-dialog";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { ContextMenuItem } from "./context-menu";

const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));

describe("Glass system surfaces", () => {
  it("keeps source headers at the muted medium UI tier and named tabs readable before scrolling", () => {
    const headers = css.match(/\[data-volli-sidebar\] \.sidebar-band-header h3 \{([^}]+)\}/)?.[1];
    expect(headers).toContain("font-size: var(--text-ui)");
    expect(headers).toContain("font-weight: 500");
    expect(headers).toContain("color: var(--muted-foreground)");
    const tabs = readFileSync(resolve(import.meta.dirname, "tab-strip.css"), "utf8");
    const bare = tabs.match(/\.tab-items > \.workspace-capsule-tab \{([^}]+)\}/)?.[1];
    expect(bare).toContain("min-width: 160px");
    expect(bare).toContain("flex: 1 0 160px");
    expect(tabs).toContain('.tab-items > .workspace-capsule-tab[data-icon-only="true"]');
  });

  it("keeps Save, Discard and Cancel distinct, including the destructive choice", async () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    await act(async () =>
      root.render(
        <FileSaveGuardDialog relPath="src/long-file.ts" onChoose={onChoose} onCancel={onCancel} />,
      ),
    );
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Save changes to long-file.ts?",
    );
    const discard = buttons().find((button) => button.textContent === "Discard")!;
    const save = buttons().find((button) => button.textContent === "Save")!;
    expect(discard.dataset.variant).toBe("destructive");
    expect(save.dataset.variant).toBe("default");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => discard.click());
    expect(onChoose).toHaveBeenCalledWith("discard");
    await act(async () => save.click());
    expect(onChoose).toHaveBeenCalledWith("save");
    await act(async () =>
      buttons()
        .find((button) => button.textContent === "Cancel")
        ?.click(),
    );
    expect(onCancel).toHaveBeenCalled();
  });

  it("retains the running-process consequence and destructive terminal close", async () => {
    const onConfirm = vi.fn();
    await act(async () =>
      root.render(
        <ConfirmCloseDialog
          pending={{ processes: ["node"], run: vi.fn() }}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      ),
    );
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Closing will end it.",
    );
    const confirm = buttons().find((button) => button.textContent === "Close anyway")!;
    expect(confirm.dataset.variant).toBe("destructive");
    await act(async () => confirm.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("uses the shared close button without losing Escape and trigger focus restoration", async () => {
    await act(async () =>
      root.render(
        <Dialog>
          <DialogTrigger>Details</DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Details</DialogTitle>
          </DialogContent>
        </Dialog>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    await act(async () => trigger.click());
    const surface = document.querySelector('[data-slot="dialog-content"]')!;
    expect(surface.className).toContain("duration-(--duration-sheet)");
    const close = buttons().find((button) => button.getAttribute("aria-label") === "Close")!;
    expect(close.dataset.control).toBe("button");
    expect(close.dataset.variant).toBe("ghost");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps context icons while plain menus suppress only direct decorative glyphs", async () => {
    await act(async () =>
      root.render(
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem variant="destructive" disabled>
              <DeleteIcon />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    const row = document.querySelector('[role="menuitem"]')!;
    expect(row.className).toContain("plain-menu-row");
    expect(row.getAttribute("data-disabled")).not.toBeNull();
    expect(row.getAttribute("data-variant")).toBe("destructive");
    expect(css).toContain('.plain-menu-row > svg:not([data-slot="menu-submenu-caret"])');
    const context = ContextMenuItem({ icon: DeleteIcon, children: "Remove" });
    expect(context.props.className).not.toContain("plain-menu-row");
    expect(context.props.children[0].type).toBe(DeleteIcon);
  });

  it("shares sheet timing with its scrim and retargets toast transforms, never layout height", () => {
    expect(css).toContain("--radius-sheet: 14px");
    expect(css).toContain("--duration-sheet: 220ms");
    expect(css).toContain(
      '[data-slot="alert-dialog-overlay"] {\n  animation-duration: var(--duration-sheet);',
    );
    expect(css).toContain("transition-property: transform, opacity");
    expect(css).toContain(':root[data-motion="off"]');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

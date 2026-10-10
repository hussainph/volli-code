// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogCancel,
} from "./alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./context-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Command } from "./command";
import { MENU_SURFACE } from "./menu-classes";

const styles = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
let root: Root;
let host: HTMLDivElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

const cases: [string, string, () => React.ReactNode][] = [
  [
    "dialog",
    "dialog-content",
    () => (
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Details</DialogTitle>
          <span>Unsized content</span>
        </DialogContent>
      </Dialog>
    ),
  ],
  [
    "confirmation",
    "alert-dialog-content",
    () => (
      <AlertDialog open>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
          <span>Unsized content</span>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    ),
  ],
  [
    "popover",
    "popover-content",
    () => (
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Unsized content</PopoverContent>
      </Popover>
    ),
  ],
  [
    "dropdown",
    "dropdown-menu-content",
    () => (
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>Unsized content</DropdownMenuContent>
      </DropdownMenu>
    ),
  ],
  [
    "context menu",
    "context-menu-content",
    () => (
      <ContextMenu modal={false}>
        <ContextMenuTrigger>Context</ContextMenuTrigger>
        <ContextMenuContent forceMount>Unsized content</ContextMenuContent>
      </ContextMenu>
    ),
  ],
  [
    "select",
    "select-content",
    () => (
      <Select open defaultValue="one">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>
    ),
  ],
];

describe("UI typography defaults", () => {
  it("declares the UI rung on body, outside generated colour blocks", () => {
    const body = styles.match(/\bbody\s*\{([^}]+)\}/)?.[1];
    expect(body).toMatch(/@apply\s+text-foreground\s+font-sans\s+text-ui\s*;/);
  });

  it.each(cases)(
    "%s content has its own UI rung even outside a large-font app ancestor",
    async (_name, slot, fixture) => {
      await act(async () => root.render(<div style={{ fontSize: 32 }}>{fixture()}</div>));
      if (slot === "context-menu-content") {
        await act(async () =>
          host
            .querySelector('[data-slot="context-menu-trigger"]')!
            .dispatchEvent(
              new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 10, clientY: 10 }),
            ),
        );
      }
      const content = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
      expect(content).not.toBeNull();
      expect(host.contains(content)).toBe(false);
      expect(content.classList.contains("text-ui")).toBe(true);
    },
  );

  it("centralizes custom menu content and command typography", async () => {
    expect(MENU_SURFACE.split(/\s+/)).toContain("text-ui");
    await act(async () =>
      root.render(
        <Command>
          <span>Unsized command content</span>
        </Command>,
      ),
    );
    expect(host.querySelector('[data-slot="command"]')?.classList.contains("text-ui")).toBe(true);
  });

  it("keeps explicit reading overrides and heading rungs authoritative", async () => {
    await act(async () =>
      root.render(
        <Dialog open>
          <DialogContent className="text-sm" aria-describedby={undefined}>
            <DialogTitle>Details</DialogTitle>
            <p>Reading content</p>
          </DialogContent>
        </Dialog>,
      ),
    );
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content.classList.contains("text-sm")).toBe(true);
    expect(content.classList.contains("text-ui")).toBe(false);
    expect(
      content.querySelector('[data-slot="dialog-title"]')?.classList.contains("text-heading"),
    ).toBe(true);
  });
});

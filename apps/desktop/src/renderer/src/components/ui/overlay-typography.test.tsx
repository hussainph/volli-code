// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "./dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogCancel,
} from "./alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverScrollBody,
  PopoverTrigger,
} from "./popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
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
      expect(content.classList.contains("material-floating")).toBe(true);
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
    expect(
      host.querySelector('[data-slot="command"]')?.classList.contains("material-regular"),
    ).toBe(true);
    expect(
      host.querySelector('[data-slot="command"]')?.classList.contains("material-floating"),
    ).toBe(false);
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

describe("overlay layout contracts", () => {
  it("portals a submenu out of the parent float that would clip it, keeping the floating glass", async () => {
    await act(async () =>
      root.render(
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>Doing</DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    const parent = document.querySelector('[data-slot="dropdown-menu-content"]')!;
    const sub = document.querySelector('[data-slot="dropdown-menu-sub-content"]')!;
    expect(sub).not.toBeNull();
    // `material-floating` contains paint: a descendant submenu is drawn clipped
    // to the parent's box, so it must not be one.
    expect(styles).toMatch(/\.material-floating,[^{]*\{[^}]*contain:\s*paint/);
    expect(parent.contains(sub)).toBe(false);
    expect(sub.classList.contains("material-floating")).toBe(true);
    expect(styles).toMatch(
      /\.material-floating,[^{]*\{[^}]*backdrop-filter:\s*blur\(var\(--glass-blur\)\)/,
    );
    const nested = styles.match(/([^{}]*)\{[^}]*backdrop-filter:\s*none !important/)?.[1] ?? "";
    expect(nested).not.toContain('[data-slot$="menu-sub-content"].material-floating');
    expect(sub.getAttribute("data-slot")?.endsWith("menu-sub-content")).toBe(true);
  });
  it("bounds dialog content and reserves title room for its close action", async () => {
    await act(async () =>
      root.render(
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>A very long dialog title</DialogTitle>
            </DialogHeader>
            <DialogBody>Long content</DialogBody>
            <DialogFooter>Actions</DialogFooter>
          </DialogContent>
        </Dialog>,
      ),
    );
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content.className).toContain("max-h-[min(80svh,40rem)]");
    expect(content.getAttribute("data-close-button")).toBe("true");
    expect(content.querySelector('[data-slot="dialog-title"]')?.className).toContain(
      "[[data-close-button=true]_&]:pr-6",
    );
    expect(content.querySelector('[data-slot="dialog-body"]')?.className).toContain(
      "overflow-y-auto",
    );
    expect(content.querySelector('[data-slot="dialog-header"]')?.className).toContain("shrink-0");
    expect(content.querySelector('[data-slot="dialog-footer"]')?.className).toContain("shrink-0");
  });
  it("gives unsized popovers a reading inset and an edge-aligned capped scroll body", async () => {
    await act(async () =>
      root.render(
        <Popover open>
          <PopoverTrigger>Options</PopoverTrigger>
          <PopoverContent>
            <PopoverHeader>Options</PopoverHeader>
            <PopoverScrollBody>Rows</PopoverScrollBody>
          </PopoverContent>
        </Popover>,
      ),
    );
    const content = document.querySelector('[data-slot="popover-content"]')!;
    expect(content.classList.contains("p-4")).toBe(true);
    expect(content.querySelector('[data-slot="popover-header"]')?.className).toContain("mb-2");
    const heading = content.querySelector('[data-slot="popover-header"]')!;
    expect(heading.tagName).toBe("H3");
    expect(heading.classList.contains("text-ui")).toBe(true);
    expect(heading.classList.contains("text-sm")).toBe(false);
    const body = content.querySelector('[data-slot="popover-scroll-body"]')!;
    for (const token of ["-mx-4", "max-h-60", "overflow-y-auto"])
      expect(body.classList.contains(token)).toBe(true);
  });
});

// @vitest-environment jsdom
/**
 * The floating material as the build ships it, computed on the real overlays.
 *
 * The source stylesheet is not what Chromium reads. Tailwind's optimizer
 * (Lightning CSS) rewrites `globals.css` first, and it folds `backdrop-filter`
 * plus a trailing `-webkit-backdrop-filter` into the prefixed spelling alone.
 * Chromium does not parse that spelling, so a source rule that reads correctly
 * can still leave every menu, popover and dialog computing
 * `backdrop-filter: none`, with crisp text showing through the 90% tint.
 *
 * So this runs the material section through the same `optimize` call the
 * Tailwind Vite plugin makes in a build. Like Chromium, jsdom ignores the
 * prefixed property. Its computed style therefore says what the app computes.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";
import { ArrowRightIcon } from "@renderer/components/ui/icon";

const source = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");

/** The material ladder: plain CSS, bounded by its two section comments. */
function materialSection(): string {
  const start = source.indexOf("/* Glass, tuned material ladder.");
  const end = source.indexOf("/* SEAM GEOMETRY");
  if (start < 0 || end < start) throw new Error("globals.css material section markers moved");
  return source.slice(start, end);
}

/** `@tailwindcss/node`'s `optimize`, reached the way `@tailwindcss/vite` reaches it. */
function tailwindOptimize(): (
  css: string,
  options: { file: string; minify: boolean },
) => {
  code: string;
} {
  const fromDesktop = createRequire(import.meta.url);
  const fromPlugin = createRequire(fromDesktop.resolve("@tailwindcss/vite"));
  return fromPlugin("@tailwindcss/node").optimize;
}

const BLUR = "blur(20px) saturate(1.5)";
const backdrop = (el: Element) =>
  getComputedStyle(el)
    .getPropertyValue("backdrop-filter")
    .replace(/\)(?=\S)/g, ") ");

let shipped = "";
let root: Root;
let host: HTMLDivElement;
let sheet: HTMLStyleElement;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeAll(() => {
  shipped = tailwindOptimize()(materialSection(), { file: "globals.css", minify: true }).code;
});
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
  sheet = document.createElement("style");
  sheet.textContent = shipped;
  document.head.append(sheet);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sheet.remove();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

describe("floating material as shipped", () => {
  it("keeps the standard backdrop-filter spelling through the build's optimizer", () => {
    expect(shipped).toMatch(/[;{]backdrop-filter:\s*blur\(20px\)\s*saturate\(1\.5\)/);
    // The tint stays 90%: jsdom cannot resolve `color-mix` over a variable, so
    // the shipped rule is read as text.
    expect(shipped).toContain("var(--material-solid-fill) 90%, transparent)");
    // Hand-written prefixes are what the optimizer folded away; it adds the
    // prefix itself for any target that needs one.
    const declarations = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/-webkit-backdrop-filter\s*:/);
  });

  it("computes static navigation without blur while stationary peek keeps the live material", async () => {
    await act(async () =>
      root.render(
        <>
          <div className="glass" data-tint="true" data-glass-static="true" data-test="sidebar">
            Navigation
          </div>
          <div data-glass-static="true">
            <div className="glass" data-tint="true" data-test="inspector">
              Inspector
            </div>
          </div>
          <div className="glass" data-tint="true" data-test="peek">
            Peek
          </div>
        </>,
      ),
    );
    for (const name of ["sidebar", "inspector"]) {
      const panel = host.querySelector(`[data-test="${name}"]`)!;
      expect(backdrop(panel)).toBe("none");
      expect(getComputedStyle(panel).contain).toBe("paint");
    }
    const peek = host.querySelector('[data-test="peek"]')!;
    expect(backdrop(peek)).toBe(BLUR);
    peek.setAttribute("data-glass-blur", "off");
    expect(backdrop(peek)).toBe("none");
    peek.removeAttribute("data-glass-blur");
    expect(backdrop(peek)).toBe(BLUR);
  });

  it("pauses hidden pane descendants without pausing its own dismissal", async () => {
    await act(async () =>
      root.render(
        <div data-inspector-panel="" aria-hidden="true">
          <div className="glass" data-tint="true">
            <span className="working">Working</span>
          </div>
        </div>,
      ),
    );
    const panel = host.querySelector("[data-inspector-panel]")!;
    expect(backdrop(panel.firstElementChild!)).toBe("none");
    expect(getComputedStyle(host.querySelector(".working")!).animationPlayState).toBe("paused");
    expect(getComputedStyle(panel).animationPlayState).not.toBe("paused");
  });

  const floats: [string, string, () => React.ReactNode][] = [
    [
      "menu",
      "dropdown-menu-content",
      () => (
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>Rows</DropdownMenuContent>
        </DropdownMenu>
      ),
    ],
    [
      "popover",
      "popover-content",
      () => (
        <Popover open>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Panel</PopoverContent>
        </Popover>
      ),
    ],
    [
      "dialog",
      "dialog-content",
      () => (
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Details</DialogTitle>
          </DialogContent>
        </Dialog>
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

  it.each(floats)("%s computes the 20px backdrop blur", async (_name, slot, ui) => {
    await act(async () => root.render(ui()));
    const surface = document.querySelector(`[data-slot="${slot}"]`)!;
    expect(surface).not.toBeNull();
    expect(backdrop(surface)).toBe(BLUR);
  });

  it("gives a dropdown submenu the same floating blur as its parent", async () => {
    await act(async () =>
      root.render(
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
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
    expect(backdrop(parent)).toBe(BLUR);
    expect(backdrop(sub)).toBe(BLUR);
  });

  it("gives a context submenu the same floating blur as its parent", async () => {
    await act(async () =>
      root.render(
        <ContextMenu modal={false}>
          <ContextMenuTrigger>Open</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuSub open>
              <ContextMenuSubTrigger icon={ArrowRightIcon}>Move to</ContextMenuSubTrigger>
              <ContextMenuSubContent>Doing</ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>,
      ),
    );
    await act(async () =>
      host
        .querySelector('[data-slot="context-menu-trigger"]')!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 10, clientY: 10 }),
        ),
    );
    const parent = document.querySelector('[data-slot="context-menu-content"]')!;
    const sub = document.querySelector('[data-slot="context-menu-sub-content"]')!;
    expect(parent.contains(sub)).toBe(false);
    expect(backdrop(parent)).toBe(BLUR);
    expect(backdrop(sub)).toBe(BLUR);
  });
});

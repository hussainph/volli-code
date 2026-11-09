// @vitest-environment jsdom
/**
 * A cmdk overlay (⌘K, ⌘P) opened over one of the app's own Radix layers must
 * hand the window back when both close.
 *
 * Every modal Radix layer disables pointer events on `body` and the first one
 * saves the value it found, to restore when the last one closes. That only
 * works while every layer shares one layer stack, which means one copy of
 * `@radix-ui/react-dismissable-layer`. cmdk once resolved its own older copy:
 * "Open file…" in an empty pane's menu opened ⌘P while the menu was still
 * leaving, ⌘P's copy saved the menu's `none`, and closing ⌘P put it back.
 * The window stopped taking clicks. The `cmdk>@radix-ui/react-dialog`
 * override in `pnpm-workspace.yaml` keeps the copies one; this fails if they
 * split again.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Command } from "cmdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

let root: Root;
let host: HTMLDivElement;
let setMenuOpen: (open: boolean) => void = () => {};
let setDialogOpen: (open: boolean) => void = () => {};

function Fixture() {
  const [menuOpen, menu] = React.useState(false);
  const [dialogOpen, dialog] = React.useState(false);
  setMenuOpen = menu;
  setDialogOpen = dialog;
  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={menu}>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open file…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Command.Dialog open={dialogOpen} onOpenChange={dialog} label="Search files">
        <Command.Input />
      </Command.Dialog>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(<Fixture />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("overlay stack", () => {
  it("restores body pointer events after a cmdk dialog opened over a menu closes", () => {
    expect(document.body.style.pointerEvents).toBe("");

    act(() => setMenuOpen(true));
    expect(document.body.style.pointerEvents).toBe("none");

    // The menu is still mounted (in the app, its exit animation is running)
    // when the dialog opens over it.
    act(() => setDialogOpen(true));
    act(() => setMenuOpen(false));
    expect(document.body.style.pointerEvents).toBe("none");

    act(() => setDialogOpen(false));
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("restores body pointer events when the menu closes after the dialog", () => {
    act(() => setMenuOpen(true));
    act(() => setDialogOpen(true));
    act(() => setDialogOpen(false));
    expect(document.body.style.pointerEvents).toBe("none");

    act(() => setMenuOpen(false));
    expect(document.body.style.pointerEvents).toBe("");
  });
});

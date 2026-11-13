// @vitest-environment jsdom
/**
 * VC-1222: a menu's glass box never scrolls; its rows scroll in a viewport
 * inside it. The rim is an absolutely placed `::after` on the box, so a box
 * that scrolled carried its own outline away with the first rows.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CodeIcon } from "./icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu";

const LABELS = Array.from({ length: 16 }, (_, i) => `label-${String(i + 1).padStart(2, "0")}`);
LABELS[15] = "worktree";

let host: HTMLDivElement;
let root: Root;

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

function expectFixedBoxScrollingRows(slot: string, viewportSlot: string): HTMLElement {
  const box = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
  expect(box).not.toBeNull();
  // The box carries the glass (and its rim) and is never a scroller.
  for (const token of ["material-floating", "rounded-menu", "overflow-clip", "flex-col"])
    expect(box.classList.contains(token)).toBe(true);
  for (const token of ["overflow-y-auto", "overflow-auto", "overflow-hidden", "p-1"])
    expect(box.classList.contains(token)).toBe(false);
  expect(box.className).toContain("20rem");
  // Exactly one child: the viewport, which owns the scroll and the 4px inset.
  expect(box.children).toHaveLength(1);
  const viewport = box.firstElementChild as HTMLElement;
  expect(viewport.dataset.slot).toBe(viewportSlot);
  for (const token of ["overflow-y-auto", "overscroll-contain", "min-h-0", "p-1"])
    expect(viewport.classList.contains(token)).toBe(true);
  expect(viewport.classList.contains("material-floating")).toBe(false);
  return viewport;
}

/** Radix's roving focus moves on the next task, so each key waits one out. */
async function key(target: Element, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("scrolls a dropdown's rows inside its fixed glass box, keyboard reaching every row", async () => {
  await act(async () =>
    root.render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Labels</DropdownMenuTrigger>
        <DropdownMenuContent>
          {LABELS.map((label) => (
            <DropdownMenuItem key={label}>{label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
  const viewport = expectFixedBoxScrollingRows("dropdown-menu-content", "dropdown-menu-viewport");
  const rows = [...viewport.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(rows.map((row) => row.textContent)).toEqual(LABELS);

  const box = viewport.parentElement!;
  await act(async () => box.focus());
  const reached: string[] = [];
  for (let i = 0; i < LABELS.length; i += 1) {
    await key(document.activeElement!, "ArrowDown");
    reached.push(document.activeElement?.textContent ?? "");
  }
  expect(reached).toEqual(LABELS);
  await key(document.activeElement!, "Home");
  expect(document.activeElement?.textContent).toBe(LABELS[0]);
  await key(document.activeElement!, "End");
  expect(document.activeElement?.textContent).toBe("worktree");
  await key(document.activeElement!, "Home");
  await key(document.activeElement!, "w");
  expect(document.activeElement?.textContent).toBe("worktree");
  expect(viewport.contains(document.activeElement)).toBe(true);
});

it("gives a dropdown sub-menu the same fixed box and scrolling viewport", async () => {
  await act(async () =>
    root.render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>Labels</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {LABELS.map((label) => (
                <DropdownMenuItem key={label}>{label}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
  const viewport = expectFixedBoxScrollingRows(
    "dropdown-menu-sub-content",
    "dropdown-menu-viewport",
  );
  expect(viewport.querySelectorAll('[role="menuitem"]')).toHaveLength(LABELS.length);
});

it("scrolls a context menu and its sub-menu inside fixed boxes, keyboard reaching every row", async () => {
  await act(async () =>
    root.render(
      <ContextMenu modal={false}>
        <ContextMenuTrigger>Card</ContextMenuTrigger>
        <ContextMenuContent>
          {LABELS.map((label) => (
            <ContextMenuItem key={label} icon={CodeIcon}>
              {label}
            </ContextMenuItem>
          ))}
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={CodeIcon}>More</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {LABELS.map((label) => (
                <ContextMenuItem key={label} icon={CodeIcon}>
                  {label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
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
  const viewport = expectFixedBoxScrollingRows("context-menu-content", "context-menu-viewport");
  await act(async () => viewport.parentElement!.focus());
  const reached: string[] = [];
  for (let i = 0; i <= LABELS.length; i += 1) {
    await key(document.activeElement!, "ArrowDown");
    reached.push(document.activeElement?.textContent ?? "");
  }
  expect(reached).toEqual([...LABELS, "More"]);

  await key(document.activeElement!, "ArrowRight");
  const sub = expectFixedBoxScrollingRows("context-menu-sub-content", "context-menu-viewport");
  expect(sub.contains(document.activeElement)).toBe(true);
  await key(document.activeElement!, "End");
  expect(document.activeElement?.textContent).toBe("worktree");
});

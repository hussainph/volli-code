// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ViewportScrollLock } from "./viewport-scroll-lock";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const sheets = () =>
  [...document.head.querySelectorAll("style")].filter((node) =>
    node.textContent?.includes("body[data-scroll-locked]"),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  expect(sheets()).toHaveLength(0);
  vi.unstubAllGlobals();
});
function DialogHarness() {
  return (
    <>
      <ViewportScrollLock />
      <Dialog>
        <DialogTrigger>Compose</DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Draft</DialogTitle>
          <input aria-label="Title" autoFocus />
          <Popover>
            <PopoverTrigger>Choices</PopoverTrigger>
            <PopoverContent>Scrollable choices</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>
    </>
  );
}
it("owns only the fixed viewport scrollbar lock and releases it exactly in StrictMode", async () => {
  await act(async () =>
    root.render(
      <React.StrictMode>
        <ViewportScrollLock />
        <div data-reading-scrollport style={{ overflowY: "auto", height: 100 }}>
          <div style={{ height: 1000 }}>Reading surface</div>
        </div>
      </React.StrictMode>,
    ),
  );
  expect(document.body.getAttribute("data-scroll-locked")).toBe("1");
  expect(document.body.style.pointerEvents).toBe("");
  expect(sheets()).toHaveLength(1);
  const port = host.querySelector<HTMLElement>("[data-reading-scrollport]")!;
  expect(port.style.overflowY).toBe("auto");
  port.scrollTop = 80;
  expect(port.scrollTop).toBe(80);
});
it("reuses the existing sheet across modal opens without weakening Radix pointer or focus guards", async () => {
  await act(async () => root.render(<DialogHarness />));
  const sheet = sheets()[0];
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  for (let n = 0; n < 2; n++) {
    trigger.focus();
    await act(async () => trigger.click());
    expect(document.body.getAttribute("data-scroll-locked")).toBe("2");
    expect(document.body.style.pointerEvents).toBe("none");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Title");
    expect(sheets()).toEqual([sheet]);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.body.getAttribute("data-scroll-locked")).toBe("1");
    expect(document.body.style.pointerEvents).toBe("");
    expect(document.activeElement).toBe(trigger);
    expect(sheets()).toEqual([sheet]);
  }
});
it("retains the nested popover's wheel claim instead of changing modal shard semantics", async () => {
  await act(async () => root.render(<DialogHarness />));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  const choices = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === "Choices",
  )!;
  await act(async () => choices.click());
  const popover = document.querySelector('[data-slot="popover-content"]')!;
  expect(popover).not.toBeNull();
  const documentWheel = vi.fn();
  document.addEventListener("wheel", documentWheel);
  try {
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    popover.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(documentWheel).not.toHaveBeenCalled();
    expect(document.body.getAttribute("data-scroll-locked")).toBe("2");
  } finally {
    document.removeEventListener("wheel", documentWheel);
  }
});

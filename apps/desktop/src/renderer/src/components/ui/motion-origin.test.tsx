// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Dialog, DialogContent, DialogTitle, DialogTrigger, DialogClose } from "./dialog";
import { Tooltip, TooltipProvider } from "./tooltip";
import { Switch } from "./switch";
import { MotionOriginRoot, useMotionOriginProps } from "./motion-origin";

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
  delete document.documentElement.dataset.motion;
  vi.unstubAllGlobals();
});
const surface = () => document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
const trigger = () => host.querySelector<HTMLButtonElement>("button")!;
async function click(node: Element, detail: number) {
  await act(async () => node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
}

function Sheet() {
  return (
    <Dialog>
      <TooltipProvider>
        <Tooltip>
          <DialogTrigger>Details</DialogTrigger>
        </Tooltip>
      </TooltipProvider>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Details</DialogTitle>
        <button type="button">Inspect</button>
        <DialogClose>Done</DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function DeferredBubble({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const motion = useMotionOriginProps("deferred", {});
  return (
    <button
      data-state={open ? "open" : "closed"}
      {...motion}
      onClick={() => queueMicrotask(() => onOpenChange(!open))}
    >
      Toggle
    </button>
  );
}

function Retained({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const motion = useMotionOriginProps("retained", {});
  return (
    <button data-state={open ? "open" : "closed"} {...motion} onClick={() => onOpenChange(!open)}>
      Toggle
    </button>
  );
}

describe("activation-local primitive motion", () => {
  it("records a popup press without rendering the closed subtree, then opens with pointer provenance", async () => {
    const render = vi.fn();
    await act(async () =>
      root.render(
        <MotionOriginRoot scope="retained" deferClosedGesture>
          {(props) => {
            render();
            return <Retained {...props} />;
          }}
        </MotionOriginRoot>,
      ),
    );
    expect(render).toHaveBeenCalledTimes(1);
    await act(async () =>
      trigger().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, detail: 1 })),
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect(trigger().dataset.state).toBe("closed");
    await click(trigger(), 1);
    expect(trigger().dataset.motionOrigin).toBe("pointer");
    expect(trigger().dataset.state).toBe("open");
    await act(async () =>
      trigger().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })),
    );
    expect(trigger().dataset.motionOrigin).toBe("keyboard");
  });

  it("retains pointer provenance across the browser's capture/bubble microtask checkpoint", async () => {
    await act(async () =>
      root.render(
        <MotionOriginRoot scope="deferred">
          {(props) => <DeferredBubble {...props} />}
        </MotionOriginRoot>,
      ),
    );
    await click(trigger(), 1);
    expect(trigger().dataset.state).toBe("open");
    expect(trigger().dataset.motionOrigin).toBe("pointer");
  });
  it("keeps pointer → Escape → keyboard → pointer independent, even through a nested tooltip", async () => {
    await act(async () => root.render(<Sheet />));
    await click(trigger(), 1);
    expect(surface().dataset.motionOrigin).toBe("pointer");
    expect(
      document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')?.dataset.motionOrigin,
    ).toBe("pointer");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
    );
    expect(surface()).toBeNull();
    await click(trigger(), 0);
    expect(surface().dataset.motionOrigin).toBe("keyboard");
    await click(document.querySelector('[data-slot="dialog-close"]')!, 0);
    await click(trigger(), 1);
    expect(surface().dataset.motionOrigin).toBe("pointer");
  });

  it("never replays an entrance on in-surface pointer input or Motion re-enable", async () => {
    await act(async () => root.render(<Sheet />));
    await click(trigger(), 0);
    const inspect = Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent === "Inspect",
    )!;
    await click(inspect, 1);
    expect(surface().dataset.motionOrigin).toBe("keyboard");
    await click(document.querySelector('[data-slot="dialog-close"]')!, 0);
    await click(trigger(), 1);
    expect(surface().dataset.motionOrigin).toBe("pointer");
    await act(async () => {
      document.documentElement.dataset.motion = "off";
      window.dispatchEvent(new Event("volli-motion-change"));
    });
    expect(surface().dataset.motionOrigin).toBe("instant");
    await act(async () => {
      delete document.documentElement.dataset.motion;
      window.dispatchEvent(new Event("volli-motion-change"));
    });
    expect(surface().dataset.motionOrigin).toBe("keyboard");
  });

  it("treats controlled async reopening as unknown, not the previous pointer gesture", async () => {
    let reopen: (() => void) | undefined;
    function Controlled() {
      const [open, setOpen] = useState(false);
      reopen = () => setOpen(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger>Details</DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Details</DialogTitle>
            <DialogClose>Done</DialogClose>
          </DialogContent>
        </Dialog>
      );
    }
    await act(async () => root.render(<Controlled />));
    await click(trigger(), 1);
    expect(surface().dataset.motionOrigin).toBe("pointer");
    await click(document.querySelector('[data-slot="dialog-close"]')!, 1);
    await act(async () => reopen?.());
    expect(surface().dataset.motionOrigin).toBe("keyboard");
  });

  it("retains the closing activation on content that outlives its open state", async () => {
    await act(async () =>
      root.render(
        <MotionOriginRoot scope="retained">{(props) => <Retained {...props} />}</MotionOriginRoot>,
      ),
    );
    await click(trigger(), 1);
    expect(trigger().dataset.motionOrigin).toBe("pointer");
    await click(trigger(), 0);
    expect(trigger().dataset.state).toBe("closed");
    expect(trigger().dataset.motionOrigin).toBe("keyboard");
  });

  it("composes capture handlers and scopes submenu hover provenance", async () => {
    const onKeyDownCapture = vi.fn();
    function Probe() {
      const motion = useMotionOriginProps("submenu", { onKeyDownCapture }, true);
      return <button {...motion}>Submenu</button>;
    }
    await act(async () =>
      root.render(
        <MotionOriginRoot scope="submenu" hover>
          {() => <Probe />}
        </MotionOriginRoot>,
      ),
    );
    const node = trigger();
    await act(async () => node.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
    expect(node.dataset.motionOrigin).toBe("pointer");
    await act(async () =>
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(node.dataset.motionOrigin).toBe("keyboard");
    expect(onKeyDownCapture).toHaveBeenCalledOnce();
  });

  it("snaps switch keyboard activation and settles live app Motion-off", async () => {
    await act(async () => root.render(<Switch aria-label="Motion" />));
    const node = trigger();
    await click(node, 1);
    expect(node.dataset.motionOrigin).toBe("pointer");
    expect(node.getAttribute("aria-checked")).toBe("true");
    await click(node, 0);
    expect(node.dataset.motionOrigin).toBe("keyboard");
    expect(node.getAttribute("aria-checked")).toBe("false");
    await click(node, 1);
    await act(async () => {
      document.documentElement.dataset.motion = "off";
      window.dispatchEvent(new Event("volli-motion-change"));
    });
    expect(node.dataset.motionOrigin).toBe("instant");
  });
});

function RetainedSurface() {
  return <MotionOriginRoot scope="sample">{(state) => <Sample {...state} />}</MotionOriginRoot>;
}
function Sample({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const motion = useMotionOriginProps("sample", {}, false, true);
  return (
    <button {...motion} data-state={open ? "open" : "closed"} onClick={() => onOpenChange(!open)}>
      Toggle
    </button>
  );
}

it("samples the displayed frame before closing Presence or reversing an entrance", async () => {
  await act(async () => root.render(<RetainedSurface />));
  const node = trigger();
  node.style.opacity = "0.4";
  node.style.transform = "matrix(0.98, 0, 0, 0.98, 0, -2)";
  await click(node, 1);
  expect(node.style.getPropertyValue("--overlay-from-opacity")).toBe("0.4");
  expect(node.style.getPropertyValue("--overlay-from-transform")).toBe(
    "matrix(0.98, 0, 0, 0.98, 0, -2)",
  );
  node.style.opacity = "0.7";
  await click(node, 1);
  expect(node.style.getPropertyValue("--overlay-from-opacity")).toBe("0.7");
});

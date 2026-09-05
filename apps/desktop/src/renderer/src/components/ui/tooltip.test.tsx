// @vitest-environment jsdom
/**
 * A tooltip is a label, not a surface (VC-249, promoted from the Activity
 * Island's `LabelTip`). Two facts have to reach the DOM for that to be true
 * over a column of stacked row actions: the content ignores the pointer, and
 * the root does not keep it open for a pointer travelling onto it. The first
 * is a class; the second is a Radix prop with no markup of its own, so it is
 * checked the way it fails — leave the trigger, and the label must be gone.
 *
 * jsdom rather than static markup because Radix portals its content to the
 * body and renders nothing for a portal on the server.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function content(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

describe("Tooltip", () => {
  it("paints its label transparent to the pointer", async () => {
    await act(async () => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <Tooltip open>
            <TooltipTrigger>Pin</TooltipTrigger>
            <TooltipContent>Pin card open</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
    });

    const label = content();
    expect(label).not.toBeNull();
    expect(label?.className).toContain("pointer-events-none");
    expect(label?.className).toContain("select-none");
  });

  it("closes the moment its trigger is left instead of waiting for the pointer to reach it", async () => {
    await act(async () => {
      root?.render(
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger>Pin</TooltipTrigger>
            <TooltipContent>Pin card open</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      );
    });
    const trigger = container?.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      // The open runs through a timer even at zero delay.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(content()).not.toBeNull();

    // Hoverable content keeps the label open past `pointerleave` for a grace
    // period so the pointer can travel onto it; a label has nowhere for the
    // pointer to travel to, so leaving is closing.
    await act(async () => {
      // React derives `onPointerLeave` from the native `pointerout` pair.
      trigger?.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(content()).toBeNull();
  });
});

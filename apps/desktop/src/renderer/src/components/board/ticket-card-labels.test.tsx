// @vitest-environment jsdom
/**
 * The card's label row, wired to real measurements.
 *
 * The packing arithmetic is `label-overflow.test.ts`'s subject and is not
 * repeated here. What this file pins is the part only a render can show: that
 * the row measures its chips, keeps itself to one line, and that the labels it
 * drops are still reachable through the `+n` chip rather than merely gone.
 *
 * jsdom measures nothing, so `getBoundingClientRect` is stubbed to give every
 * chip a fixed width and the row a fixed one — the same seam `tab-strip`'s
 * keyboard test uses for the same reason.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TicketCardLabels } from "./ticket-card-labels";

const CHIP_WIDTH = 60;
const OVERFLOW_WIDTH = 24;

let container: HTMLElement | null = null;
let root: Root | null = null;
const nativeRect = Element.prototype.getBoundingClientRect;
/** The row's width, per test — the whole point of the component is reacting to it. */
let rowWidth = 200;

function rect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 20,
    width,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Element.prototype.getBoundingClientRect = function getRect(this: Element) {
    const key = this.getAttribute("data-measure-key");
    if (key === null) return rect(rowWidth);
    return rect(key.startsWith("\u0000+") ? OVERFLOW_WIDTH : CHIP_WIDTH);
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Element.prototype.getBoundingClientRect = nativeRect;
  vi.unstubAllGlobals();
});

/**
 * The row reads its own width from `clientWidth`, which jsdom always reports as
 * 0 and which is not a `getBoundingClientRect` call — so it is defined here.
 */
function render(labels: string[]): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => rowWidth,
  });
  act(() => {
    root?.render(<TicketCardLabels labels={labels} projectLabels={[]} />);
  });
}

/**
 * The label names the card is actually showing, `+n` excluded. The overflow
 * chip is the popover's trigger and so sits in the row unwrapped, which is why
 * this excludes a child that IS a button as well as one that contains one.
 */
function visibleLabels(): string[] {
  const row = container?.firstElementChild;
  return [...(row?.children ?? [])]
    .filter((child) => child.tagName !== "BUTTON" && child.querySelector("button") === null)
    .map((child) => child.textContent ?? "");
}

function overflowButton(): HTMLButtonElement | null {
  return container?.querySelector("button") ?? null;
}

describe("TicketCardLabels", () => {
  it("draws every label when the row has room for them", () => {
    rowWidth = 400;
    render(["alpha", "beta", "gamma"]);

    expect(visibleLabels()).toEqual(["alpha", "beta", "gamma"]);
    expect(overflowButton()).toBeNull();
  });

  it("keeps to one line and counts what it dropped", () => {
    // 60 + 4 + 60 = 124 fits in 150; a third chip would need 188. Two chips
    // plus the +n chip is 60 + 4 + 60 + 4 + 24 = 152 — over, so one chip shows.
    rowWidth = 150;
    render(["alpha", "beta", "gamma"]);

    expect(visibleLabels()).toEqual(["alpha"]);
    expect(overflowButton()?.textContent).toBe("+2");
  });

  it("names the hidden count for a screen reader, which cannot see the chip", () => {
    rowWidth = 150;
    render(["alpha", "beta", "gamma"]);

    expect(overflowButton()?.getAttribute("aria-label")).toBe("2 more labels");
  });

  it("shows every label, including the ones on screen, when the +n chip is hovered", () => {
    rowWidth = 150;
    render(["alpha", "beta", "gamma"]);

    act(() => {
      overflowButton()?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      overflowButton()?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    });

    // The popover portals to the body, so it is found there rather than in the
    // card. All three, not just the two that were dropped: the chip stands for
    // "see the labels", and a list missing the visible ones would read as a
    // different set rather than the whole one.
    const panel = document.body.querySelector('[data-slot="popover-content"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("alpha");
    expect(panel?.textContent).toContain("beta");
    expect(panel?.textContent).toContain("gamma");
  });

  it("renders nothing at all for a ticket wearing no labels", () => {
    rowWidth = 400;
    render([]);

    expect(container?.firstElementChild).toBeNull();
  });
});

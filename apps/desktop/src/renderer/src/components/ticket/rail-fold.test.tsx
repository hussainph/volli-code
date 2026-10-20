// @vitest-environment jsdom
/**
 * The rail's ONE fold, as a MOTION object (VC-406, requirement 9): that a
 * reversal continues from where the body actually is, that a keyboard press
 * and a reduced-motion reader get the state change with no movement at all,
 * and that a closing body is unreachable while it is still on screen.
 *
 * WHAT A jsdom RUN CAN AND CANNOT SAY. It lays nothing out and runs no
 * transition, so every measurement here is a stub and no assertion below is
 * evidence about pixels, easing or smoothness — those need the lab and a real
 * compositor. What it CAN pin is the mechanism: which height the run starts
 * from, whether a transition was armed at all, what the DOM exposes to a
 * keyboard mid-close, and that the observers are disconnected on unmount.
 */
import { act } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RailFold, RailFoldBody, RailFoldCaret, RailFoldTrigger } from "./rail-panel-parts";

/** How tall the stubs say the body and its measured content are. */
const measured = { body: 0, content: 200 };
/** The one MediaQueryList `prefersReducedMotion` caches, so a test can flip it. */
const media = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
let observers: { targets: Element[]; notify(): void; disconnected: boolean }[] = [];

let container: HTMLElement;
let root: Root | null = null;
const nativeRect = Element.prototype.getBoundingClientRect;

function Fold({ initial = false }: { initial?: boolean }) {
  // The production shape: controlled from outside, exactly as the rail's three
  // folds are controlled from the UI store.
  const [open, setOpen] = React.useState(initial);
  return (
    <RailFold open={open} onOpenChange={setOpen}>
      <RailFoldTrigger asChild>
        <button type="button" data-testid="trigger" aria-label={open ? "Hide" : "Show"}>
          Earlier
          <RailFoldCaret open={open} placement="eyebrow" />
        </button>
      </RailFoldTrigger>
      <RailFoldBody>
        <div data-testid="content">
          <button type="button" data-testid="inside">
            Row
          </button>
        </div>
      </RailFoldBody>
    </RailFold>
  );
}

function render(initial = false): void {
  act(() => {
    root?.render(<Fold initial={initial} />);
  });
}

function body(): HTMLElement {
  const node = container.querySelector<HTMLElement>('[data-slot="rail-fold-body"]');
  if (node === null) throw new Error("no fold body");
  return node;
}

function trigger(): HTMLElement {
  const node = container.querySelector<HTMLElement>('[data-testid="trigger"]');
  if (node === null) throw new Error("no fold trigger");
  return node;
}

/** `detail` is how a browser distinguishes a real click (≥1) from Enter (0). */
function press(detail: number): void {
  act(() => {
    trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  });
}

/**
 * Every value `height` took, in order, from the style attribute's mutations.
 * Consecutive repeats are collapsed: arming the transition is a style write of
 * its own, and what this is asking about is the sequence of HEIGHTS.
 */
function heightTrail(node: HTMLElement, watcher: MutationObserver): string[] {
  const seen = watcher.takeRecords().map((record) => record.oldValue ?? "");
  return [...seen, node.getAttribute("style") ?? ""]
    .map((css) => /height:\s*([^;]+)/.exec(css)?.[1]?.trim() ?? "")
    .filter((value, index, all) => index === 0 || all[index - 1] !== value);
}

function watchStyle(node: HTMLElement): MutationObserver {
  const watcher = new MutationObserver(() => {});
  watcher.observe(node, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  return watcher;
}

/** Let the fallback timer land the resting state (no transition ever runs here). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  media.matches = false;
  vi.stubGlobal("matchMedia", () => media);
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = [];
      disconnected = false;
      constructor(private readonly callback: () => void) {
        observers.push(this as unknown as (typeof observers)[number]);
      }
      observe(element: Element): void {
        this.targets.push(element);
      }
      unobserve(): void {}
      disconnect(): void {
        this.disconnected = true;
      }
      notify(): void {
        this.callback();
      }
    },
  );
  measured.body = 0;
  measured.content = 200;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const self = this as HTMLElement;
    const height =
      self.dataset["slot"] === "rail-fold-body"
        ? measured.body
        : (self.parentElement as HTMLElement | null)?.dataset["slot"] === "rail-fold-body"
          ? measured.content
          : 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      width: 0,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  Element.prototype.getBoundingClientRect = nativeRect;
  vi.unstubAllGlobals();
});

describe("the rail's fold", () => {
  it("wires the trigger to the body it controls, and keeps a mount still", () => {
    render(true);

    // Radix gave this away for free; owning the motion means owning the pair.
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(body().id);
    expect(body().id).not.toBe("");
    // A fold the store remembers as open does not unfold itself on mount: the
    // first frame is a resting state.
    expect(body().style.height).toBe("auto");
    expect(body().style.transition).toBe("");
  });

  it("opens from a pointer press on a height transition, then rests on auto", async () => {
    render();
    const watcher = watchStyle(body());

    press(1);

    // 200ms on the app's own strong ease-out — the token, not a second curve.
    expect(body().style.transition).toBe("height 200ms var(--ease-out)");
    expect(heightTrail(body(), watcher)).toEqual(["0px", "200px"]);
    expect(container.querySelector('[data-testid="content"]')).not.toBeNull();

    await settle();
    // `auto`, so content that lands later is not clipped to a stale number.
    expect(body().style.height).toBe("auto");
    expect(body().style.transition).toBe("");
    watcher.disconnect();
  });

  it("reverses from the height the body is AT, not from the one it was heading to", () => {
    render();
    press(1); // opening: 0 → 200
    // Halfway down the run, which is where a second press actually lands.
    measured.body = 120;
    const watcher = watchStyle(body());

    press(1);

    // 120, not 200 and not 0: the close continues from where the eye is. This
    // is the whole reason the fold is a transition rather than keyframes.
    expect(heightTrail(body(), watcher)).toEqual(["200px", "120px", "0px"]);
    expect(body().style.transition).toBe("height 200ms var(--ease-out)");
    watcher.disconnect();
  });

  it("changes state instantly from the keyboard — body and caret both", () => {
    render();

    press(0); // Enter/Space on the trigger

    expect(body().style.transition).toBe("");
    expect(body().style.height).toBe("auto");
    // The caret is a descendant of the trigger, and it must not be the one
    // thing still moving after a keyboard press.
    const caret = trigger().querySelector("svg");
    expect(caret?.getAttribute("class")).toContain("transition-none");
  });

  it("reads reduced motion at the moment of the press, so a change mid-session lands", () => {
    render();
    // Not reduced when the surface mounted…
    media.matches = true; // …and reduced by the time it is pressed.

    press(1);

    expect(body().style.transition).toBe("");
    expect(body().style.height).toBe("auto");
  });

  it("holds a closing body inert and hands focus back to the trigger", async () => {
    render(true);
    const inside = container.querySelector<HTMLElement>('[data-testid="inside"]');
    inside?.focus();
    expect(document.activeElement).toBe(inside);

    measured.body = 200;
    press(1);

    // Still on screen for the length of the close, and reachable by nothing.
    expect(container.querySelector('[data-testid="content"]')).not.toBeNull();
    expect(body().hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(trigger());

    await settle();
    // Once shut it is gone, not merely clipped — the rows inside stop costing
    // anything, which is what the fold was for.
    expect(container.querySelector('[data-testid="content"]')).toBeNull();
    expect(body().style.height).toBe("0px");
  });

  it("retargets an opening run when the content under it grows, and lets go on unmount", () => {
    render();
    press(1);
    expect(body().style.height).toBe("200px");

    // A read lands while the fold is still moving.
    measured.content = 320;
    act(() => {
      for (const observer of observers) observer.notify();
    });
    expect(body().style.height).toBe("320px");

    const live = observers.filter((observer) => !observer.disconnected);
    expect(live.length).toBeGreaterThan(0);
    act(() => root?.unmount());
    root = null;
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
  });
});

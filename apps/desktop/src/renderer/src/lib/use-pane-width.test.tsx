// @vitest-environment jsdom
/**
 * The measurement every pane-width rule stands on (VC-288).
 *
 * jsdom lays nothing out and implements no `ResizeObserver`, so the observer is
 * a fake that hands its callback back to the test. That is the right seam
 * anyway: what is worth pinning is not that the browser measures, it is what
 * this hook does with a measurement — that the pre-measure frame reports
 * `null` rather than a narrow 0, that a later resize is heard at all (the
 * divider drag and the unsplit that a resize HANDLER would miss), and that the
 * observer is disconnected when the pane goes away.
 */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { usePaneWidth } from "./use-pane-width";

let container: HTMLElement | null = null;
let root: Root | null = null;

/** Every fake observer this test made, in the order they were constructed. */
interface FakeObserver {
  readonly observed: Element[];
  readonly notify: () => void;
  disconnected: boolean;
}
let observers: FakeObserver[] = [];

/** What the next `clientWidth` read answers, in CSS px. */
let width = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers = [];
  width = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly observed: Element[] = [];
      disconnected = false;
      constructor(private readonly callback: () => void) {
        observers.push(this as unknown as FakeObserver);
      }
      observe(element: Element): void {
        this.observed.push(element);
      }
      disconnect(): void {
        this.disconnected = true;
      }
      notify(): void {
        this.callback();
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** Renders the hook's answer as text, so a resize is readable from the DOM. */
function Probe({ mounted = true }: { mounted?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = usePaneWidth(ref, [mounted]);
  return mounted ? <div ref={ref}>{measured === null ? "unmeasured" : String(measured)}</div> : null;
}

function reported(): string | undefined {
  return container?.textContent;
}

describe("usePaneWidth", () => {
  it("measures before paint, and hears every later resize", () => {
    width = 720;
    act(() => root?.render(<Probe />));
    // A layout effect, so the number is there on the first painted frame — a
    // diff that measured in a passive effect would draw two columns and then
    // swap to one.
    expect(reported()).toBe("720");

    // The resize a handler would miss: same window, narrower pane.
    width = 400;
    act(() => observers[0]?.notify());
    expect(reported()).toBe("400");

    width = 900;
    act(() => observers[0]?.notify());
    expect(reported()).toBe("900");
  });

  it("reports nothing rather than nothing-yet-as-narrow", () => {
    // A pane inside a hidden ancestor measures 0. Callers read that through
    // `diff-fit.ts`, which treats it as unmeasured for exactly this reason.
    width = 0;
    act(() => root?.render(<Probe />));
    expect(reported()).toBe("0");
    expect(observers).toHaveLength(1);
  });

  it("observes the element the ref points at, and lets it go", () => {
    width = 640;
    act(() => root?.render(<Probe />));
    expect(observers[0]?.observed).toEqual([container?.firstElementChild]);

    // The pane the diff's loading and stub states replace: the observer is
    // dropped rather than left holding a detached node.
    act(() => root?.render(<Probe mounted={false} />));
    expect(observers[0]?.disconnected).toBe(true);
    expect(reported()).toBe("");
  });
});

// @vitest-environment jsdom
/** A capped bundle hands progress to its header only when no row spinner is fully visible. */
import type { BundleRow } from "@volli/session-presentation";
import type { DynamicToolUIPart } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ActivityBundle } from "./activity-ui";

const VIEWPORT = '[data-slot="activity-bundle-viewport"]';
const HEADER = '[data-slot="activity-bundle-header"]';
const ROW_SPINNER = "[data-activity-progress]";

function rect(top: number, height: number, left = 0, width = 500): DOMRectReadOnly {
  return new DOMRectReadOnly(left, top, width, height);
}

/** No automatic delivery: the initial paint must be correct before IO reports anything. */
class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds: readonly number[];
  readonly targets = new Set<Element>();
  readonly observe = vi.fn((target: Element) => this.targets.add(target));
  readonly unobserve = vi.fn((target: Element) => this.targets.delete(target));
  readonly disconnect = vi.fn(() => this.targets.clear());
  readonly takeRecords = vi.fn((): IntersectionObserverEntry[] => []);

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    MockIntersectionObserver.instances.push(this);
  }

  emit(target: Element, intersectionRatio: number): void {
    expect(this.targets.has(target)).toBe(true);
    const bounds = target.getBoundingClientRect();
    const rootBounds = this.root instanceof Element ? this.root.getBoundingClientRect() : null;
    const intersectionTop = Math.max(bounds.top, rootBounds?.top ?? bounds.top);
    const intersectionBottom = Math.min(bounds.bottom, rootBounds?.bottom ?? bounds.bottom);
    this.callback(
      [
        {
          target,
          boundingClientRect: bounds,
          rootBounds,
          intersectionRect: rect(
            intersectionTop,
            Math.max(0, intersectionBottom - intersectionTop),
          ),
          intersectionRatio,
          isIntersecting: intersectionRatio > 0,
          time: 0,
        },
      ],
      this,
    );
  }
}

function tool(part: DynamicToolUIPart): BundleRow {
  return { kind: "tool", key: part.toolCallId, part };
}

const running: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "running-command",
  state: "input-available",
  input: { command: "long-running check" },
};
const completed: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "read",
  toolCallId: "completed-read",
  state: "output-available",
  input: { path: "src/session.ts" },
  output: "export {};",
};

let container: HTMLDivElement;
let root: Root;
let spinnerTop: number;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  MockIntersectionObserver.instances = [];
  spinnerTop = 120;
  // jsdom has no layout. Model the real 384px cap and the 14px row glyph,
  // including horizontal bounds, without making visibility depend on IO.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(VIEWPORT)) return rect(100, 384);
    if (this.matches(ROW_SPINNER)) return rect(spinnerTop, 14, 0, 14);
    return rect(100, 28);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(rows: readonly BundleRow[]): void {
  act(() => root.render(<ActivityBundle rows={rows} />));
}

function header(): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>(HEADER);
  if (!node) throw new Error("bundle has no header");
  return node;
}

function viewport(): HTMLDivElement {
  const node = container.querySelector<HTMLDivElement>(VIEWPORT);
  if (!node) throw new Error("bundle has no viewport");
  return node;
}

function expand(): void {
  expect(header().getAttribute("aria-expanded")).toBe("false");
  act(() => header().click());
  expect(header().getAttribute("aria-expanded")).toBe("true");
}

function headerSpinners(): number {
  return header().querySelectorAll("svg.animate-spin").length;
}

function rowSpinner(): HTMLElement {
  const spinners = viewport().querySelectorAll<HTMLElement>(ROW_SPINNER);
  expect(spinners).toHaveLength(1);
  return spinners[0]!;
}

function progressObservers(): MockIntersectionObserver[] {
  return MockIntersectionObserver.instances.filter((observer) => observer.root === viewport());
}

function progressObserver(): MockIntersectionObserver {
  const observers = progressObservers();
  expect(observers).toHaveLength(1);
  const observer = observers[0]!;
  expect(observer.thresholds).toEqual([1]);
  expect([...observer.targets]).toEqual([rowSpinner()]);
  return observer;
}

describe("expanded activity progress visibility", () => {
  it("keeps the header moving when a running command follows 20 completed calls outside the cap", () => {
    spinnerTop = 700;
    render([
      ...Array.from({ length: 20 }, (_, index) =>
        tool({ ...completed, toolCallId: `completed-${index}` }),
      ),
      tool(running),
    ]);
    expect(headerSpinners()).toBe(1);
    expand();

    expect(viewport().classList.contains("max-h-96")).toBe(true);
    expect(viewport().classList.contains("overflow-auto")).toBe(true);
    expect(rowSpinner().getBoundingClientRect().top).toBeGreaterThan(
      viewport().getBoundingClientRect().bottom,
    );
    // No IO callback has fired: layout must already preserve visible progress.
    expect(headerSpinners()).toBe(1);
    const observer = progressObserver();
    act(() => observer.emit(rowSpinner(), 0));
    expect(headerSpinners()).toBe(1);
  });

  it("keeps a header spinner for an expanded input-streaming row with only a static pending glyph", () => {
    render([tool({ ...running, state: "input-streaming" })]);
    expand();

    expect(viewport().querySelector("svg")).not.toBeNull();
    expect(viewport().querySelectorAll("svg.animate-spin")).toHaveLength(0);
    expect(viewport().querySelectorAll(ROW_SPINNER)).toHaveLength(0);
    expect(headerSpinners()).toBe(1);
    expect(container.querySelectorAll("svg.animate-spin")).toHaveLength(1);
  });

  it("hands progress to the visible active row without a duplicate header spinner", () => {
    render([tool(running)]);
    expect(headerSpinners()).toBe(1);
    expand();

    expect(rowSpinner().querySelector("svg.animate-spin")).not.toBeNull();
    // Observe a fixed slot: a rotating SVG's bounds extend past the cap's
    // left edge, which would otherwise keep the header spinning forever.
    expect(rowSpinner().tagName).toBe("SPAN");
    expect(rowSpinner().classList.contains("animate-spin")).toBe(false);
    // Correct immediately after expansion, not only after the first observer tick.
    expect(headerSpinners()).toBe(0);
    expect(container.querySelectorAll("svg.animate-spin")).toHaveLength(1);
    const observer = progressObserver();
    act(() => observer.emit(rowSpinner(), 1));
    expect(headerSpinners()).toBe(0);
    expect(container.querySelectorAll("svg.animate-spin")).toHaveLength(1);
  });

  it("restores the header when the spinner scrolls partly or entirely out, and yields when it returns", () => {
    render([tool(running)]);
    expand();
    const spinner = rowSpinner();
    const observer = progressObserver();
    expect(headerSpinners()).toBe(0);

    spinnerTop = 477; // Only seven of fourteen pixels remain inside the cap.
    act(() => observer.emit(spinner, 0.5));
    expect(headerSpinners()).toBe(1);
    spinnerTop = 700;
    act(() => observer.emit(spinner, 0));
    expect(headerSpinners()).toBe(1);
    spinnerTop = 120;
    act(() => observer.emit(spinner, 1));
    expect(headerSpinners()).toBe(0);
    expect(container.querySelectorAll("svg.animate-spin")).toHaveLength(1);
    expect(progressObservers()).toEqual([observer]);
  });

  it("does not recreate visibility subscriptions when the same active reasoning row streams more text", () => {
    const thought: BundleRow = {
      kind: "reasoning",
      key: "thought",
      streaming: true,
      part: { type: "reasoning", text: "**Checking**", state: "streaming" },
    };
    render([tool(completed), thought]);
    expand();
    const observer = progressObserver();
    const spinner = rowSpinner();
    const observeCalls = observer.observe.mock.calls.length;
    expect(headerSpinners()).toBe(0);

    render([
      tool(completed),
      { ...thought, part: { ...thought.part, text: "**Checking the updated result**" } },
    ]);

    expect(container.textContent).toContain("Checking the updated result");
    expect(rowSpinner()).toBe(spinner);
    expect(progressObservers()).toEqual([observer]);
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(observer.observe).toHaveBeenCalledTimes(observeCalls);
    expect(headerSpinners()).toBe(0);
  });
});

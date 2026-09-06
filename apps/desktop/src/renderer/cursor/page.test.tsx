// @vitest-environment jsdom
/**
 * The overlay page against a fake bridge (VC-239): the ack contract main
 * waits on. Main pushes states with a `seq` and holds the next input until
 * the page answers that `seq` — or until its bound runs out. Every push must
 * be answered, including one that moved nothing, or every action after the
 * first pays the whole bound for an answer that never comes.
 *
 * jsdom lays nothing out, so the size report is checked only for its shape
 * and the arrow-only fallback; the label's real measurement is the smoke's.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  CursorOverlayBridge,
  CursorOverlaySize,
  CursorOverlayState,
} from "../../ipc/cursor-contract";
import { ARROW_ONLY_SIZE, CursorOverlayPage } from "./page";

function fakeBridge(): {
  bridge: CursorOverlayBridge;
  push(state: Partial<CursorOverlayState> & { seq: number }): void;
  settled: number[];
  sizes: CursorOverlaySize[];
  pressed: string[];
} {
  const listeners = new Set<(state: CursorOverlayState) => void>();
  const settled: number[] = [];
  const sizes: CursorOverlaySize[] = [];
  const pressed: string[] = [];
  const base: Omit<CursorOverlayState, "seq"> = {
    color: "#d07c00",
    name: "Fix checkout form",
    present: true,
    gesture: null,
    pressKey: 0,
    labelPinned: false,
    handoff: false,
    reducedMotion: false,
  };
  return {
    bridge: {
      onState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      settled: (seq) => settled.push(seq),
      resized: (size) => sizes.push(size),
      takeOver: () => pressed.push("take-over"),
      askToLeave: () => pressed.push("ask-to-leave"),
    },
    push: (state) => {
      for (const listener of listeners) listener({ ...base, ...state });
    },
    settled,
    sizes,
    pressed,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CursorOverlayPage", () => {
  it("answers every seq main pushes, including pushes that moved nothing", () => {
    const fake = fakeBridge();
    act(() => root.render(<CursorOverlayPage bridge={fake.bridge} />));
    expect(container.querySelector('[data-slot="session-cursor"]')).toBeNull();

    act(() => fake.push({ seq: 1 }));
    act(() => vi.runAllTimers());
    expect(fake.settled).toEqual([1]);

    // The tip is pinned at the inset, so nothing about the drawing's position
    // changed between these pushes — main moved the view. Each still lands.
    act(() => fake.push({ seq: 2, gesture: "click", pressKey: 1 }));
    act(() => vi.runAllTimers());
    act(() => fake.push({ seq: 3, gesture: "hover" }));
    act(() => vi.runAllTimers());
    expect(fake.settled).toEqual([1, 2, 3]);
  });

  it("does not answer a push that hides the cursor: nothing is waiting on an exit", () => {
    const fake = fakeBridge();
    act(() => root.render(<CursorOverlayPage bridge={fake.bridge} />));
    act(() => fake.push({ seq: 1 }));
    act(() => vi.runAllTimers());
    act(() => fake.push({ seq: 2, present: false }));
    act(() => vi.runAllTimers());
    expect(fake.settled).toEqual([1]);
    expect(
      container.querySelector('[data-slot="session-cursor"]')?.getAttribute("data-present"),
    ).toBe("false");
  });

  it("draws the pushed holder's colour and name, and reports the arrow-only size while the label is hidden", () => {
    const fake = fakeBridge();
    act(() => root.render(<CursorOverlayPage bridge={fake.bridge} />));
    act(() => fake.push({ seq: 1, color: "#3366cc", name: "Pricing copy pass" }));
    const cursor = container.querySelector<HTMLElement>('[data-slot="session-cursor"]');
    expect(cursor?.style.getPropertyValue("--session-cursor-color")).toBe("#3366cc");
    expect(container.querySelector(".session-cursor-name")?.textContent).toBe("Pricing copy pass");
    expect(fake.sizes.at(-1)).toEqual(ARROW_ONLY_SIZE);
  });

  it("relays the label's two controls to the bridge", () => {
    const fake = fakeBridge();
    act(() => root.render(<CursorOverlayPage bridge={fake.bridge} />));
    act(() => fake.push({ seq: 1, labelPinned: true }));
    // The actions ride the hover label; enter the body to reveal them. React
    // derives `onPointerEnter` from the bubbling pointerover.
    const body = container.querySelector<HTMLElement>(".session-cursor-body")!;
    act(() => {
      body.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".session-cursor-action")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Take over", "Ask to leave"]);
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    expect(fake.pressed).toEqual(["take-over", "ask-to-leave"]);
  });
});

import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  heldAltSides,
  installAltSideTracker,
  optionAsAltSequence,
  resetAltSideTrackerForTests,
  type AltChordKeyEvent,
} from "./option-as-alt";

const chord = (overrides: Partial<AltChordKeyEvent>): AltChordKeyEvent => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: "KeyB",
  key: "∫", // macOS composed character — exactly what must NOT be emitted
  ...overrides,
});

describe("optionAsAltSequence", () => {
  it("is inert when the mode is off or unset", () => {
    expect(optionAsAltSequence(chord({}), null, true, true)).toBeNull();
    expect(optionAsAltSequence(chord({}), false, true, true)).toBeNull();
  });

  it("remaps a pure Option chord to ESC + the base character, not the composed one", () => {
    expect(optionAsAltSequence(chord({}), true, true, false)).toBe("\x1bb");
  });

  it("leaves Ctrl and Cmd chords to the renderer's own encodings", () => {
    expect(optionAsAltSequence(chord({ ctrlKey: true }), true, true, false)).toBeNull();
    expect(optionAsAltSequence(chord({ metaKey: true }), true, true, false)).toBeNull();
    expect(optionAsAltSequence(chord({ altKey: false }), true, false, false)).toBeNull();
  });

  it("gates sided modes on the tracked Option side", () => {
    expect(optionAsAltSequence(chord({}), "left", true, false)).toBe("\x1bb");
    expect(optionAsAltSequence(chord({}), "left", false, true)).toBeNull();
    expect(optionAsAltSequence(chord({}), "right", false, true)).toBe("\x1bb");
    expect(optionAsAltSequence(chord({}), "right", true, false)).toBeNull();
    // Tracker never saw the keydown (focus arrived mid-hold): sided modes
    // fall through rather than guess.
    expect(optionAsAltSequence(chord({}), "left", false, false)).toBeNull();
  });

  it("mode true trusts event.altKey without side tracking", () => {
    expect(optionAsAltSequence(chord({}), true, false, false)).toBe("\x1bb");
  });

  it("applies Shift to letters, digits, and US punctuation", () => {
    expect(optionAsAltSequence(chord({ shiftKey: true }), true, true, false)).toBe("\x1bB");
    expect(optionAsAltSequence(chord({ code: "Digit2" }), true, true, false)).toBe("\x1b2");
    expect(optionAsAltSequence(chord({ code: "Digit2", shiftKey: true }), true, true, false)).toBe(
      "\x1b@",
    );
    expect(optionAsAltSequence(chord({ code: "Period" }), true, true, false)).toBe("\x1b.");
    expect(optionAsAltSequence(chord({ code: "Period", shiftKey: true }), true, true, false)).toBe(
      "\x1b>",
    );
  });

  it("falls through on keys without a US base mapping", () => {
    expect(optionAsAltSequence(chord({ code: "Space" }), true, true, false)).toBeNull();
    expect(optionAsAltSequence(chord({ code: "F1" }), true, true, false)).toBeNull();
    expect(optionAsAltSequence(chord({ code: "ArrowLeft" }), true, true, false)).toBeNull();
  });
});

describe("alt side tracker", () => {
  type Listener = (event: unknown) => void;

  /** Minimal Window stand-in capturing capture-phase listeners. */
  function fakeWindow() {
    const listeners = new Map<string, Listener[]>();
    const target = {
      addEventListener(type: string, listener: Listener) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
    };
    const fire = (type: string, event: unknown): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    return { target: target as unknown as Window, fire };
  }

  beforeEach(() => {
    resetAltSideTrackerForTests();
  });

  it("tracks each Option side independently via keydown location", () => {
    const { target, fire } = fakeWindow();
    installAltSideTracker(target);
    fire("keydown", { key: "Alt", location: 1 });
    expect(heldAltSides()).toEqual({ left: true, right: false });
    fire("keydown", { key: "Alt", location: 2 });
    expect(heldAltSides()).toEqual({ left: true, right: true });
    fire("keyup", { key: "Alt", location: 1 });
    expect(heldAltSides()).toEqual({ left: false, right: true });
  });

  it("ignores non-Alt keys and unknown locations", () => {
    const { target, fire } = fakeWindow();
    installAltSideTracker(target);
    fire("keydown", { key: "Shift", location: 1 });
    fire("keydown", { key: "Alt", location: 0 });
    expect(heldAltSides()).toEqual({ left: false, right: false });
  });

  it("clears both sides on window blur (keyup outside the window never fires)", () => {
    const { target, fire } = fakeWindow();
    installAltSideTracker(target);
    fire("keydown", { key: "Alt", location: 1 });
    fire("keydown", { key: "Alt", location: 2 });
    fire("blur", {});
    expect(heldAltSides()).toEqual({ left: false, right: false });
  });

  it("installs once — a second target gets no listeners", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    installAltSideTracker(first.target);
    installAltSideTracker(second.target);
    second.fire("keydown", { key: "Alt", location: 1 });
    expect(heldAltSides()).toEqual({ left: false, right: false });
    first.fire("keydown", { key: "Alt", location: 1 });
    expect(heldAltSides()).toEqual({ left: true, right: false });
  });
});

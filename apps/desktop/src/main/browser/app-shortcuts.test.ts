import { describe, expect, it } from "vite-plus/test";

import { isCommandPaletteKeyEvent } from "@renderer/lib/command-palette-shortcut";
import { projectIndexForKeyEvent } from "@renderer/lib/project-shortcut";
import { splitShortcutForKeyEvent } from "@renderer/lib/split-shortcut";

import { browserKeyRoute, type BrowserKeyInput } from "./app-shortcuts";

/** A key down with ⌘ alone held, unless a test says otherwise. */
function key(overrides: Partial<BrowserKeyInput>): BrowserKeyInput {
  return {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    ...overrides,
  };
}

const letter = (char: string, overrides: Partial<BrowserKeyInput> = {}): BrowserKeyInput =>
  key({ key: char, code: `Key${char.toUpperCase()}`, ...overrides });

describe("browserKeyRoute — what the app takes", () => {
  it("replays ⌘K, ⌘1–⌘9 and ⌃⌘ + an arrow as the chord they are", () => {
    const pressed = [
      letter("k"),
      key({ key: "1", code: "Digit1" }),
      key({ key: "9", code: "Digit9" }),
      key({ key: "ArrowLeft", code: "ArrowLeft", control: true }),
      key({ key: "ArrowRight", code: "ArrowRight", control: true }),
      key({ key: "ArrowUp", code: "ArrowUp", control: true }),
      key({ key: "ArrowDown", code: "ArrowDown", control: true }),
    ];
    for (const input of pressed) {
      expect(browserKeyRoute(input)).toEqual({
        kind: "app",
        shortcut: {
          kind: "replay",
          chord: {
            key: input.key,
            code: input.code,
            metaKey: true,
            ctrlKey: input.control,
            altKey: false,
            shiftKey: false,
            repeat: false,
          },
        },
      });
    }
  });

  it("matches ⌘K whatever case the layout reports", () => {
    expect(browserKeyRoute(letter("K"))).toMatchObject({ kind: "app" });
  });

  it("carries a replayed chord's repeat, so the renderer's own rule decides", () => {
    expect(
      browserKeyRoute(
        key({ key: "ArrowLeft", code: "ArrowLeft", control: true, isAutoRepeat: true }),
      ),
    ).toMatchObject({ kind: "app", shortcut: { kind: "replay", chord: { repeat: true } } });
  });

  it("names ⌘W as this tab's close and ⌘L as the way back to its address bar", () => {
    expect(browserKeyRoute(letter("w"))).toEqual({
      kind: "app",
      shortcut: { kind: "close-tab" },
    });
    expect(browserKeyRoute(letter("l"))).toEqual({
      kind: "app",
      shortcut: { kind: "focus-address" },
    });
  });

  it("swallows a held ⌘W or ⌘L rather than acting again or falling through to the menu", () => {
    expect(browserKeyRoute(letter("w", { isAutoRepeat: true }))).toEqual({ kind: "swallow" });
    expect(browserKeyRoute(letter("l", { isAutoRepeat: true }))).toEqual({ kind: "swallow" });
  });
});

describe("browserKeyRoute — what the page keeps", () => {
  it.each([
    ["a key up", letter("k", { type: "keyUp" })],
    ["a key mid-composition", letter("k", { isComposing: true })],
    ["a bare key", letter("k", { meta: false })],
    ["Escape", key({ key: "Escape", code: "Escape", meta: false })],
    ["Shift+Tab", key({ key: "Tab", code: "Tab", meta: false, shift: true })],
    ["⌃K, a readline and field binding", letter("k", { meta: false, control: true })],
    ["⇧⌘K", letter("k", { shift: true })],
    ["⌥⌘K", letter("k", { alt: true })],
    ["⌃⌘K", letter("k", { control: true })],
    ["⌘B, bold in a page editor", letter("b")],
    ["⌘C, copy", letter("c")],
    ["⌘V, paste", letter("v")],
    ["⌘A, select all", letter("a")],
    ["⌘Z, undo", letter("z")],
    ["⌘P, the page's print", letter("p")],
    ["⌘[, outdent in a page editor", key({ key: "[", code: "BracketLeft" })],
    ["⌘], indent in a page editor", key({ key: "]", code: "BracketRight" })],
    ["⌘0", key({ key: "0", code: "Digit0" })],
    ["⌘ + an arrow, caret movement in a field", key({ key: "ArrowLeft", code: "ArrowLeft" })],
    ["⇧⌃⌘ + an arrow", key({ key: "ArrowLeft", code: "ArrowLeft", control: true, shift: true })],
    ["⌥⌘ + an arrow", key({ key: "ArrowLeft", code: "ArrowLeft", alt: true, control: true })],
    ["⌃⌘ + a letter", letter("w", { control: true })],
    ["⇧⌘W", letter("w", { shift: true })],
  ])("leaves %s to the page", (_label, input) => {
    expect(browserKeyRoute(input)).toEqual({ kind: "page" });
  });
});

/** The replayed chord a key routes to, or a failure naming the key that was not one. */
function asKeyboardEvent(input: BrowserKeyInput) {
  const route = browserKeyRoute(input);
  if (route.kind !== "app" || route.shortcut.kind !== "replay") {
    throw new Error(`expected a replayed chord for ${input.key}`);
  }
  return route.shortcut.chord;
}

/**
 * Main decides which chords leave the page; the renderer's own predicates decide
 * what they mean. A replayed chord the renderer then ignored would be a key
 * taken from the page for nothing, so every one is checked against the
 * predicate that owns it.
 */
describe("browserKeyRoute agrees with the renderer's chord predicates", () => {
  it("replays a ⌘K the palette's predicate recognises", () => {
    expect(isCommandPaletteKeyEvent(asKeyboardEvent(letter("k")))).toBe(true);
  });

  it("replays ⌘1–⌘9 the project rail's predicate recognises", () => {
    for (let digit = 1; digit <= 9; digit += 1) {
      const chord = asKeyboardEvent(key({ key: String(digit), code: `Digit${digit}` }));
      expect(projectIndexForKeyEvent(chord)).toBe(digit - 1);
    }
  });

  it("replays ⌃⌘ + an arrow the split view's predicate reads as pane focus", () => {
    const directions = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    for (const [code, direction] of Object.entries(directions)) {
      const chord = asKeyboardEvent(key({ key: code, code, control: true }));
      expect(splitShortcutForKeyEvent(chord)).toEqual({ kind: "focus", direction });
    }
  });
});

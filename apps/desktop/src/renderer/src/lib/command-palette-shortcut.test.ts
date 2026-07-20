import { describe, expect, it } from "vite-plus/test";
import { isCommandPaletteKeyEvent, type CommandPaletteKeyEvent } from "./command-palette-shortcut";

function keyEvent(overrides: Partial<CommandPaletteKeyEvent>): CommandPaletteKeyEvent {
  return { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "k", ...overrides };
}

describe("isCommandPaletteKeyEvent", () => {
  it("accepts a bare ⌘K", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ key: "k" }))).toBe(true);
  });

  it("accepts uppercase K (shift-less caps)", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ key: "K" }))).toBe(true);
  });

  it("returns false without the meta key held", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ metaKey: false }))).toBe(false);
  });

  it("returns false when ctrl is also held", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ ctrlKey: true }))).toBe(false);
  });

  it("returns false when alt is also held", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ altKey: true }))).toBe(false);
  });

  it("returns false when shift is also held", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ shiftKey: true }))).toBe(false);
  });

  it("returns false for a non-K key", () => {
    expect(isCommandPaletteKeyEvent(keyEvent({ key: "j" }))).toBe(false);
  });
});

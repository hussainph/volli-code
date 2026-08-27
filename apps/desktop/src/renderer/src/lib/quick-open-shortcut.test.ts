import { describe, expect, it } from "vite-plus/test";
import { isQuickOpenKeyEvent, type QuickOpenKeyEvent } from "./quick-open-shortcut";

function keyEvent(overrides: Partial<QuickOpenKeyEvent>): QuickOpenKeyEvent {
  return { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "p", ...overrides };
}

describe("isQuickOpenKeyEvent", () => {
  it("accepts a bare ⌘P", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ key: "p" }))).toBe(true);
  });

  it("accepts uppercase P (shift-less caps)", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ key: "P" }))).toBe(true);
  });

  it("returns false without the meta key held", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ metaKey: false }))).toBe(false);
  });

  it("leaves Ctrl+P to the terminal", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ ctrlKey: true }))).toBe(false);
  });

  it("returns false when alt is also held", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ altKey: true }))).toBe(false);
  });

  it("leaves ⇧⌘P free", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ shiftKey: true }))).toBe(false);
  });

  it("returns false for a non-P key", () => {
    expect(isQuickOpenKeyEvent(keyEvent({ key: "k" }))).toBe(false);
  });
});

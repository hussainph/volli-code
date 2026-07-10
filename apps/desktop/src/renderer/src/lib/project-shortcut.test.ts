import { describe, expect, it } from "vite-plus/test";
import { projectIndexForKeyEvent, type ProjectShortcutKeyEvent } from "./project-shortcut";

function keyEvent(overrides: Partial<ProjectShortcutKeyEvent>): ProjectShortcutKeyEvent {
  return { metaKey: true, ctrlKey: false, altKey: false, key: "1", ...overrides };
}

describe("projectIndexForKeyEvent", () => {
  it("maps ⌘1 to index 0", () => {
    expect(projectIndexForKeyEvent(keyEvent({ key: "1" }))).toBe(0);
  });

  it("maps ⌘9 to index 8", () => {
    expect(projectIndexForKeyEvent(keyEvent({ key: "9" }))).toBe(8);
  });

  it("returns null for ⌘0", () => {
    expect(projectIndexForKeyEvent(keyEvent({ key: "0" }))).toBeNull();
  });

  it("returns null for a non-digit key", () => {
    expect(projectIndexForKeyEvent(keyEvent({ key: "a" }))).toBeNull();
  });

  it("returns null without the meta key held", () => {
    expect(projectIndexForKeyEvent(keyEvent({ metaKey: false }))).toBeNull();
  });

  it("returns null when ctrl is also held", () => {
    expect(projectIndexForKeyEvent(keyEvent({ ctrlKey: true }))).toBeNull();
  });

  it("returns null when alt is also held", () => {
    expect(projectIndexForKeyEvent(keyEvent({ altKey: true }))).toBeNull();
  });
});

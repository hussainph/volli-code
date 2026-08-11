import { describe, expect, it } from "vite-plus/test";

import {
  newSessionKindForKeyEvent,
  newSessionLandingForChrome,
  type NewSessionKeyEvent,
} from "./new-session-shortcut";

/** ⌘T as the OS delivers it, before any override. */
function keyEvent(overrides: Partial<NewSessionKeyEvent> = {}): NewSessionKeyEvent {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: "t",
    code: "KeyT",
    repeat: false,
    ...overrides,
  };
}

describe("newSessionKindForKeyEvent", () => {
  it("reads ⌘T as a chat", () => {
    expect(newSessionKindForKeyEvent(keyEvent())).toBe("chat");
  });

  it("reads ⌥⌘T as a terminal", () => {
    // Option remaps the character on macOS, so the physical key is all that's left.
    expect(newSessionKindForKeyEvent(keyEvent({ altKey: true, key: "†" }))).toBe("terminal");
  });

  it("accepts a ⌘T whose key survived but whose code did not", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ code: "Unidentified" }))).toBe("chat");
  });

  it("accepts a ⌘T whose code survived but whose key did not", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ key: "†" }))).toBe("chat");
  });

  it("accepts an uppercase T without shift (CapsLock)", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ key: "T", code: "Unidentified" }))).toBe("chat");
  });

  it("ignores ⌘ with any other key", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ key: "k", code: "KeyK" }))).toBeNull();
  });

  it("ignores ⌥⌘ with any other physical key", () => {
    expect(
      newSessionKindForKeyEvent(keyEvent({ altKey: true, key: "b", code: "KeyB" })),
    ).toBeNull();
  });

  it("ignores a bare T", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ metaKey: false }))).toBeNull();
  });

  it("leaves ⌃T to the shell", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ ctrlKey: true }))).toBeNull();
  });

  it("reserves ⌘⇧T", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ shiftKey: true }))).toBeNull();
  });

  it("refuses a key-repeat, so a held ⌘T starts one Session and not a hundred", () => {
    expect(newSessionKindForKeyEvent(keyEvent({ repeat: true }))).toBeNull();
    expect(newSessionKindForKeyEvent(keyEvent({ altKey: true, repeat: true }))).toBeNull();
  });
});

describe("newSessionLandingForChrome", () => {
  it("mints on the selected project and moves to Sessions", () => {
    expect(newSessionLandingForChrome({ selectedProjectId: "p1", nav: "board" })).toEqual({
      projectId: "p1",
      navigateTo: "sessions",
    });
  });

  it("stays put when Sessions is already the page", () => {
    expect(newSessionLandingForChrome({ selectedProjectId: "p1", nav: "sessions" })).toEqual({
      projectId: "p1",
      navigateTo: null,
    });
  });

  it("stays global with a ticket open — the chord has one meaning everywhere", () => {
    // Ticket detail is a STATE of the board nav (`openTicketWorkspace` patches
    // `{ nav: "board", openTicketId }`), so this IS the in-a-ticket chrome.
    expect(newSessionLandingForChrome({ selectedProjectId: "p1", nav: "board" })).toEqual({
      projectId: "p1",
      navigateTo: "sessions",
    });
  });

  it("starts nothing with no project selected", () => {
    expect(newSessionLandingForChrome({ selectedProjectId: null, nav: "board" })).toBeNull();
  });
});

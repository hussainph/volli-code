import { describe, expect, it } from "vite-plus/test";

import {
  newSessionKindForKeyEvent,
  newSessionLandingForChrome,
  type NewSessionChrome,
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

/** The plain board of a selected project: nothing in front but the cards. */
function chrome(overrides: Partial<NewSessionChrome> = {}): NewSessionChrome {
  return {
    selectedProjectId: "p1",
    nav: "board",
    settingsOpen: false,
    newTicketOpen: false,
    openTicketId: null,
    ...overrides,
  };
}

describe("newSessionLandingForChrome", () => {
  it("mints on the project and moves to Sessions from the bare board", () => {
    expect(newSessionLandingForChrome(chrome())).toEqual({
      projectId: "p1",
      ticketId: null,
      navigateTo: "sessions",
    });
  });

  it("stays put when Sessions is already the page", () => {
    expect(newSessionLandingForChrome(chrome({ nav: "sessions" }))).toEqual({
      projectId: "p1",
      ticketId: null,
      navigateTo: null,
    });
  });

  it("mints on the OPEN TICKET, without moving the page under it", () => {
    // Ticket detail is a STATE of the board nav (`openTicketWorkspace` patches
    // `{ nav: "board", openTicketId }`), so this IS the in-a-ticket chrome — and
    // the ticket is already the surface in front, so there is nowhere to go.
    expect(newSessionLandingForChrome(chrome({ openTicketId: "t1" }))).toEqual({
      projectId: "p1",
      ticketId: "t1",
      navigateTo: null,
    });
  });

  it("ignores a ticket left open behind another page", () => {
    // `setNav` deliberately does NOT clear `openTicketId`, so a ticket you
    // opened is still recorded while you stand on Files or Sessions. Minting
    // onto it from there would put a Session somewhere nobody is looking.
    for (const nav of ["files", "sessions", "configure"] as const) {
      expect(newSessionLandingForChrome(chrome({ nav, openTicketId: "t1" }))).toEqual({
        projectId: "p1",
        ticketId: null,
        navigateTo: nav === "sessions" ? null : "sessions",
      });
    }
  });

  it("starts nothing under an open Settings sheet, ticket behind it or not", () => {
    // Settings is chrome layered OVER the workspace, so nothing behind it is the
    // surface in front — the same reading `terminalFocusTargetForChrome` makes.
    // Falling through to a project landing minted a Session and navigated to
    // Sessions UNDERNEATH the sheet, where its tab cannot be seen and nothing
    // here dismisses the sheet.
    expect(
      newSessionLandingForChrome(chrome({ openTicketId: "t1", settingsOpen: true })),
    ).toBeNull();
    expect(newSessionLandingForChrome(chrome({ settingsOpen: true }))).toBeNull();
  });

  it("starts nothing while the New-ticket dialog is up", () => {
    // The modal owns the keyboard, exactly as `use-new-ticket-shortcut` reads it
    // for "c" — and a Session minted behind it lands where nobody is looking.
    expect(newSessionLandingForChrome(chrome({ newTicketOpen: true }))).toBeNull();
    expect(
      newSessionLandingForChrome(chrome({ openTicketId: "t1", newTicketOpen: true })),
    ).toBeNull();
  });

  it("starts nothing with no project selected", () => {
    expect(newSessionLandingForChrome(chrome({ selectedProjectId: null }))).toBeNull();
    expect(
      newSessionLandingForChrome(chrome({ selectedProjectId: null, openTicketId: "t1" })),
    ).toBeNull();
  });
});

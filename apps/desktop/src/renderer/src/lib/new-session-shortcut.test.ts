import { describe, expect, it } from "vite-plus/test";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import {
  isNewSessionGuardedTarget,
  NEW_SESSION_GUARD_SELECTOR,
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

describe("isNewSessionGuardedTarget", () => {
  it("treats a target with no DOM shape as safe", () => {
    expect(isNewSessionGuardedTarget(null)).toBe(false);
    expect(isNewSessionGuardedTarget("not-an-element")).toBe(false);
    expect(isNewSessionGuardedTarget({})).toBe(false);
  });

  it("guards the inline rename box that reported this — an input", () => {
    // Double-click a tab, press ⌘T, and without this a chat Session booted
    // behind a rename box still waiting on Enter.
    const target = { closest: (selector: string) => (selector.includes("input") ? {} : null) };
    expect(isNewSessionGuardedTarget(target)).toBe(true);
  });

  it("guards an editable region exposed only by the property", () => {
    expect(isNewSessionGuardedTarget({ closest: () => null, isContentEditable: true })).toBe(true);
    expect(isNewSessionGuardedTarget({ closest: () => null, isContentEditable: false })).toBe(
      false,
    );
    expect(isNewSessionGuardedTarget({ closest: () => null })).toBe(false);
  });

  it("keeps closest a method call, so a real DOM node cannot throw on it", () => {
    // A detached `const closest = el.closest` loses `this` and real DOM methods
    // throw "Illegal invocation".
    const target = {
      closest(this: unknown, _selector: string) {
        expect(this).toBe(target);
        return null;
      },
    };
    isNewSessionGuardedTarget(target);
  });

  it("covers form controls, contenteditable and Monaco — and nothing else", () => {
    for (const token of ["input", "textarea", "select", "[contenteditable]", ".monaco-editor"]) {
      expect(NEW_SESSION_GUARD_SELECTOR).toContain(token);
    }
    // A live terminal is NOT guarded: a pty is sent Ctrl chords, not Cmd chords,
    // so ⌘T means nothing to a shell and suppressing it there would break the
    // chord exactly where a second Session is most often wanted. A modal is not
    // guarded either — `newSessionLandingForChrome` already refuses the whole
    // chord while one is up, and a second DOM-shaped copy could only drift.
    expect(NEW_SESSION_GUARD_SELECTOR).not.toContain("data-terminal-renderer");
    expect(NEW_SESSION_GUARD_SELECTOR).not.toContain("dialog");
  });
});

/** Home's plain board for a selected project: nothing in front but the cards. */
function chrome(overrides: Partial<NewSessionChrome> = {}): NewSessionChrome {
  return {
    selectedProjectId: "p1",
    nav: "home",
    homeActiveTab: HOME_BOARD_TAB_ID,
    settingsOpen: false,
    newTicketOpen: false,
    openTicketId: null,
    ...overrides,
  };
}

describe("newSessionLandingForChrome", () => {
  it("mints on the project and stays on Home from the bare board", () => {
    expect(newSessionLandingForChrome(chrome())).toEqual({
      projectId: "p1",
      ticketId: null,
      navigateTo: null,
    });
  });

  it("moves to Home from another page", () => {
    expect(newSessionLandingForChrome(chrome({ nav: "configure" }))).toEqual({
      projectId: "p1",
      ticketId: null,
      navigateTo: "home",
    });
  });

  it("stays put on a Home Session tab", () => {
    expect(newSessionLandingForChrome(chrome({ homeActiveTab: "chat:c1" }))).toEqual({
      projectId: "p1",
      ticketId: null,
      navigateTo: null,
    });
  });

  it("mints on the OPEN TICKET, without moving the page under it", () => {
    // Ticket detail is a state of Home's BOARD TAB (`openTicketWorkspace`
    // patches `{ nav: "home", homeActiveTab: board, openTicketId }`), so this IS
    // the in-a-ticket chrome — and the ticket is already the surface in front,
    // so there is nowhere to go.
    expect(newSessionLandingForChrome(chrome({ openTicketId: "t1" }))).toEqual({
      projectId: "p1",
      ticketId: "t1",
      navigateTo: null,
    });
  });

  it("mints a PROJECT Session from a Home chat tab, even with a ticket open behind it", () => {
    // The fact that used to be `nav === "board"` is now WHICH HOME TAB is in
    // front: a Session tab keeps the ticket remembered behind it (VC-54
    // decision 1), and a chord fired there must not mint onto a ticket that is
    // nowhere on screen.
    expect(
      newSessionLandingForChrome(chrome({ homeActiveTab: "chat:c1", openTicketId: "t1" })),
    ).toEqual({ projectId: "p1", ticketId: null, navigateTo: null });
  });

  it("ignores a ticket left open behind Configure", () => {
    // `setNav` clears `openTicketId` only when Home's Board tab is in front, so
    // a ticket you opened is still recorded while you stand on Configure.
    // Minting onto it from there would put a Session somewhere nobody is
    // looking.
    expect(newSessionLandingForChrome(chrome({ nav: "configure", openTicketId: "t1" }))).toEqual({
      projectId: "p1",
      ticketId: null,
      navigateTo: "home",
    });
  });

  it("starts nothing under an open Settings sheet, ticket behind it or not", () => {
    // Settings is chrome layered OVER the workspace, so nothing behind it is the
    // surface in front — the same reading `terminalFocusTargetForChrome` makes.
    // Falling through to a project landing minted a Session and navigated to
    // Home UNDERNEATH the sheet, where its tab cannot be seen and nothing
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

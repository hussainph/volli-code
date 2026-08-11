import { describe, expect, it } from "vite-plus/test";

import {
  activeTerminalSessionId,
  isTerminalFocusKeyEvent,
  terminalFocusTargetForChrome,
  type TerminalFocusChrome,
  type TerminalFocusKeyEvent,
} from "./terminal-focus";

/** ⌥⌘Return as macOS delivers it. */
function keyEvent(overrides: Partial<TerminalFocusKeyEvent> = {}): TerminalFocusKeyEvent {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    key: "Enter",
    code: "Enter",
    repeat: false,
    ...overrides,
  };
}

/** A ticket open on Board with a terminal Session tab in front. */
function chrome(overrides: Partial<TerminalFocusChrome> = {}): TerminalFocusChrome {
  return {
    selectedProjectId: "p1",
    nav: "board",
    settingsOpen: false,
    openTicketId: "t1",
    activeSessionId: "s1",
    ...overrides,
  };
}

describe("isTerminalFocusKeyEvent", () => {
  it("reads ⌥⌘Return", () => {
    expect(isTerminalFocusKeyEvent(keyEvent())).toBe(true);
  });

  it("accepts the numeric keypad's Enter, whose code is not 'Enter'", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ code: "NumpadEnter" }))).toBe(true);
  });

  it("accepts a Return whose key did not survive but whose code did", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ key: "Unidentified" }))).toBe(true);
  });

  it("ignores ⌘Return, which composers already own", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ altKey: false }))).toBe(false);
  });

  it("ignores a bare Return", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ metaKey: false, altKey: false }))).toBe(false);
  });

  it("ignores ⌥Return", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ metaKey: false }))).toBe(false);
  });

  it("leaves ⌃⌥⌘Return alone", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ ctrlKey: true }))).toBe(false);
  });

  it("leaves ⇧⌥⌘Return alone", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ shiftKey: true }))).toBe(false);
  });

  it("ignores ⌥⌘ with any other key", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ key: "b", code: "KeyB" }))).toBe(false);
  });

  it("refuses a held chord, which would strobe the whole canvas", () => {
    expect(isTerminalFocusKeyEvent(keyEvent({ repeat: true }))).toBe(false);
  });
});

describe("terminalFocusTargetForChrome", () => {
  it("names the Session the active tab holds", () => {
    expect(terminalFocusTargetForChrome(chrome())).toEqual({
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
    });
  });

  it("refuses when no project is selected", () => {
    expect(terminalFocusTargetForChrome(chrome({ selectedProjectId: null }))).toBeNull();
  });

  it("refuses off Board, where the open ticket is not on screen", () => {
    // `setNav` deliberately keeps `openTicketId`, so every non-board page would
    // otherwise offer to focus a terminal nobody can see.
    expect(terminalFocusTargetForChrome(chrome({ nav: "files" }))).toBeNull();
    expect(terminalFocusTargetForChrome(chrome({ nav: "sessions" }))).toBeNull();
    expect(terminalFocusTargetForChrome(chrome({ nav: "configure" }))).toBeNull();
  });

  it("refuses behind app-wide Settings, which is chrome over the workspace", () => {
    expect(terminalFocusTargetForChrome(chrome({ settingsOpen: true }))).toBeNull();
  });

  it("refuses on the plain board", () => {
    expect(terminalFocusTargetForChrome(chrome({ openTicketId: null }))).toBeNull();
  });

  it("refuses when the ticket's active tab is not a terminal", () => {
    expect(terminalFocusTargetForChrome(chrome({ activeSessionId: null }))).toBeNull();
  });
});

describe("activeTerminalSessionId", () => {
  const tabs = [{ sessionId: "s1" }, { sessionId: "s2" }];

  it("resolves a tab id that names a live Session", () => {
    expect(activeTerminalSessionId("s2", tabs)).toBe("s2");
  });

  it("rejects the Ticket Body, whose id shares the strip's id space", () => {
    expect(activeTerminalSessionId("doc", tabs)).toBeNull();
  });

  it("rejects a chat tab, which is a Session but not a terminal", () => {
    expect(activeTerminalSessionId("chat:s1", tabs)).toBeNull();
  });

  it("rejects a stale active id whose Session has closed", () => {
    expect(activeTerminalSessionId("s3", tabs)).toBeNull();
  });

  it("treats a ticket that never had a Session as having none", () => {
    expect(activeTerminalSessionId("s1", undefined)).toBeNull();
  });
});

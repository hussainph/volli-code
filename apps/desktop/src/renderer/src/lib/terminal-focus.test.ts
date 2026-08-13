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

/**
 * A ticket open on Board with a terminal Session tab in front — and, at the same
 * time, a terminal in front on the project's own Sessions page. Both are stocked
 * deliberately: the two surfaces are told apart by `nav` alone, so a fixture that
 * only ever held one of them could not catch the resolver reading the wrong one.
 */
function chrome(overrides: Partial<TerminalFocusChrome> = {}): TerminalFocusChrome {
  return {
    selectedProjectId: "p1",
    nav: "board",
    settingsOpen: false,
    openTicketId: "t1",
    ticketSessionId: "s1",
    scratchSessionId: "scratch1",
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
  it("names the Session the open ticket's active tab holds", () => {
    expect(terminalFocusTargetForChrome(chrome())).toEqual({
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
    });
  });

  it("names the project's OWN terminal on the Sessions page", () => {
    // The parity fix: zen mode was ticket-only for no reason other than that the
    // target type demanded a ticketId. A ticketless Session fills a canvas just
    // as well, and `ticketId: null` is the durable fact rather than a gap.
    expect(terminalFocusTargetForChrome(chrome({ nav: "sessions" }))).toEqual({
      projectId: "p1",
      ticketId: null,
      sessionId: "scratch1",
    });
  });

  it("reads the surface in front, not whichever terminal exists", () => {
    // Both surfaces hold a terminal in the fixture; only the one on the current
    // page may answer. A resolver that fell back to the other would focus a
    // terminal nobody can see.
    expect(terminalFocusTargetForChrome(chrome({ ticketSessionId: null }))).toBeNull();
    expect(
      terminalFocusTargetForChrome(chrome({ nav: "sessions", scratchSessionId: null })),
    ).toBeNull();
  });

  it("refuses when no project is selected", () => {
    expect(terminalFocusTargetForChrome(chrome({ selectedProjectId: null }))).toBeNull();
    expect(
      terminalFocusTargetForChrome(chrome({ selectedProjectId: null, nav: "sessions" })),
    ).toBeNull();
  });

  it("refuses on pages that host no terminal at all", () => {
    // `setNav` deliberately keeps `openTicketId`, so Files and Configure would
    // otherwise offer to focus the ticket terminal behind them.
    expect(terminalFocusTargetForChrome(chrome({ nav: "files" }))).toBeNull();
    expect(terminalFocusTargetForChrome(chrome({ nav: "configure" }))).toBeNull();
  });

  it("refuses behind app-wide Settings on EITHER surface", () => {
    expect(terminalFocusTargetForChrome(chrome({ settingsOpen: true }))).toBeNull();
    expect(
      terminalFocusTargetForChrome(chrome({ nav: "sessions", settingsOpen: true })),
    ).toBeNull();
  });

  it("refuses on the plain board", () => {
    expect(terminalFocusTargetForChrome(chrome({ openTicketId: null }))).toBeNull();
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

  it("treats an owner that never had a Session as having none", () => {
    expect(activeTerminalSessionId("s1", undefined)).toBeNull();
  });

  it("treats a surface with nothing in front as having no terminal", () => {
    // The Sessions page records `null` for a project whose strip has never had a
    // tab in front, where a ticket always has at least its Body.
    expect(activeTerminalSessionId(null, tabs)).toBeNull();
    expect(activeTerminalSessionId(null, undefined)).toBeNull();
  });
});

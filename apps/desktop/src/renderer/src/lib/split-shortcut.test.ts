import { describe, expect, it } from "vite-plus/test";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import {
  isSplitGuardedTarget,
  splitShortcutForKeyEvent,
  splitSurfaceForChrome,
  SPLIT_GUARD_SELECTOR,
  type SplitKeyEvent,
  type SplitShortcutChrome,
} from "./split-shortcut";

/** ⌘\ as the OS delivers it, before any override. */
function keyEvent(overrides: Partial<SplitKeyEvent> = {}): SplitKeyEvent {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: "Backslash",
    repeat: false,
    ...overrides,
  };
}

describe("splitShortcutForKeyEvent", () => {
  it("reads ⌘\\ as a split to the right and ⇧⌘\\ as a split downward", () => {
    expect(splitShortcutForKeyEvent(keyEvent())).toEqual({ kind: "split", edge: "right" });
    expect(splitShortcutForKeyEvent(keyEvent({ shiftKey: true }))).toEqual({
      kind: "split",
      edge: "down",
    });
  });

  it("reads ⌃⌘ + an arrow as a move between panes", () => {
    for (const [code, direction] of [
      ["ArrowLeft", "left"],
      ["ArrowRight", "right"],
      ["ArrowUp", "up"],
      ["ArrowDown", "down"],
    ] as const) {
      expect(splitShortcutForKeyEvent(keyEvent({ ctrlKey: true, code }))).toEqual({
        kind: "focus",
        direction,
      });
    }
  });

  it("refuses a held ⌘\\ — one press, one pane", () => {
    expect(splitShortcutForKeyEvent(keyEvent({ repeat: true }))).toBeNull();
  });

  it("lets a held ⌃⌘arrow walk across the panes", () => {
    expect(
      splitShortcutForKeyEvent(keyEvent({ ctrlKey: true, code: "ArrowRight", repeat: true })),
    ).toEqual({ kind: "focus", direction: "right" });
  });

  it("leaves ⌥⌘ alone — that is the terminal tab's own pane navigation", () => {
    expect(splitShortcutForKeyEvent(keyEvent({ altKey: true }))).toBeNull();
    expect(
      splitShortcutForKeyEvent(keyEvent({ altKey: true, ctrlKey: true, code: "ArrowUp" })),
    ).toBeNull();
  });

  it("needs the Command key, and needs the physical backslash", () => {
    expect(splitShortcutForKeyEvent(keyEvent({ metaKey: false }))).toBeNull();
    expect(splitShortcutForKeyEvent(keyEvent({ code: "Slash" }))).toBeNull();
    expect(splitShortcutForKeyEvent(keyEvent({ ctrlKey: true, code: "KeyK" }))).toBeNull();
  });

  it("reserves ⇧⌃⌘arrow rather than answering to it", () => {
    expect(
      splitShortcutForKeyEvent(keyEvent({ ctrlKey: true, shiftKey: true, code: "ArrowRight" })),
    ).toBeNull();
  });
});

/** A structural stand-in for an Element, as the predicate actually reads one. */
function target(matches: string | null) {
  return {
    closest(selector: string) {
      return matches !== null && selector === matches ? {} : null;
    },
  };
}

describe("isSplitGuardedTarget", () => {
  it("refuses the chord inside modal chrome", () => {
    expect(isSplitGuardedTarget(target(SPLIT_GUARD_SELECTOR))).toBe(true);
  });

  it("allows it everywhere else — an editor is where a split is most wanted", () => {
    expect(isSplitGuardedTarget(target(null))).toBe(false);
  });

  it("treats anything that is not an element as safe", () => {
    expect(isSplitGuardedTarget(null)).toBe(false);
    expect(isSplitGuardedTarget("window")).toBe(false);
    expect(isSplitGuardedTarget({})).toBe(false);
  });
});

function chrome(overrides: Partial<SplitShortcutChrome> = {}): SplitShortcutChrome {
  return {
    selectedProjectId: "proj-1",
    nav: "home",
    homeActiveTab: "chat:s1",
    settingsOpen: false,
    newTicketOpen: false,
    openTicketId: null,
    terminalFocused: false,
    ...overrides,
  };
}

describe("splitSurfaceForChrome", () => {
  it("splits Home when Home is what is in front", () => {
    expect(splitSurfaceForChrome(chrome())).toEqual({ projectId: "proj-1", ticketId: null });
  });

  it("splits the TICKET when its workspace has taken Home over", () => {
    expect(
      splitSurfaceForChrome(chrome({ homeActiveTab: HOME_BOARD_TAB_ID, openTicketId: "tick-1" })),
    ).toEqual({ projectId: "proj-1", ticketId: "tick-1" });
  });

  it("splits HOME when a ticket is merely remembered behind a Home tab", () => {
    // The ticket is open in the record but a Session tab is on screen — the
    // same distinction ⌘T makes, and it must be the same answer.
    expect(splitSurfaceForChrome(chrome({ openTicketId: "tick-1" }))).toEqual({
      projectId: "proj-1",
      ticketId: null,
    });
  });

  it("does nothing with no project, on Settings' page, or behind modal chrome", () => {
    expect(splitSurfaceForChrome(chrome({ selectedProjectId: null }))).toBeNull();
    expect(splitSurfaceForChrome(chrome({ nav: "configure" }))).toBeNull();
    expect(splitSurfaceForChrome(chrome({ settingsOpen: true }))).toBeNull();
    expect(splitSurfaceForChrome(chrome({ newTicketOpen: true }))).toBeNull();
  });

  it("does nothing while a terminal owns the whole canvas", () => {
    expect(splitSurfaceForChrome(chrome({ terminalFocused: true }))).toBeNull();
  });
});

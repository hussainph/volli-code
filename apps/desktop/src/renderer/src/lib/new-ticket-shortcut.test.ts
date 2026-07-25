import { describe, expect, it } from "vite-plus/test";
import {
  isNewTicketKeyEvent,
  isTextEntryTarget,
  NEW_TICKET_GUARD_SELECTOR,
  type NewTicketKeyEvent,
} from "./new-ticket-shortcut";

function keyEvent(overrides: Partial<NewTicketKeyEvent>): NewTicketKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: "c",
    repeat: false,
    isComposing: false,
    ...overrides,
  };
}

describe("isNewTicketKeyEvent", () => {
  it("accepts a bare lowercase c", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c" }))).toBe(true);
  });

  it("accepts an uppercase C without shift (CapsLock)", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "C", shiftKey: false }))).toBe(true);
  });

  it("rejects shift+c", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c", shiftKey: true }))).toBe(false);
  });

  it("rejects meta+c", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c", metaKey: true }))).toBe(false);
  });

  it("rejects ctrl+c", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c", ctrlKey: true }))).toBe(false);
  });

  it("rejects alt+c", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c", altKey: true }))).toBe(false);
  });

  it("rejects a key-repeat", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c", repeat: true }))).toBe(false);
  });

  it("rejects a keydown mid IME composition", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "c", isComposing: true }))).toBe(false);
  });

  it("rejects any other key", () => {
    expect(isNewTicketKeyEvent(keyEvent({ key: "v" }))).toBe(false);
  });
});

describe("isTextEntryTarget", () => {
  it("returns false for a null target", () => {
    expect(isTextEntryTarget(null)).toBe(false);
  });

  it("returns false for a non-object target", () => {
    expect(isTextEntryTarget("not-an-element")).toBe(false);
  });

  it("returns false for an object with no closest function", () => {
    expect(isTextEntryTarget({})).toBe(false);
  });

  it("returns true when closest matches the guard selector", () => {
    const target = { closest: (_selector: string) => ({}) };
    expect(isTextEntryTarget(target)).toBe(true);
  });

  it("returns true when isContentEditable is true, even if closest finds nothing", () => {
    const target = { closest: () => null, isContentEditable: true };
    expect(isTextEntryTarget(target)).toBe(true);
  });

  it("returns false when closest finds nothing and isContentEditable is not true", () => {
    const target = { closest: () => null };
    expect(isTextEntryTarget(target)).toBe(false);
  });

  it("invokes closest as a this-bound method, like a real DOM element", () => {
    // Real Element#closest throws "Illegal invocation" when called detached
    // from its element; this fake does the same, so a regression to an
    // unbound call fails here instead of only in the live app.
    const target = {
      closest(this: unknown, _selector: string) {
        if (this !== target) throw new TypeError("Illegal invocation");
        return null;
      },
    };
    expect(isTextEntryTarget(target)).toBe(false);
  });

  it("passes NEW_TICKET_GUARD_SELECTOR through to closest", () => {
    let received: string | null = null;
    const target = {
      closest: (selector: string) => {
        received = selector;
        return null;
      },
    };
    isTextEntryTarget(target);
    expect(received).toBe(NEW_TICKET_GUARD_SELECTOR);
  });
});

describe("NEW_TICKET_GUARD_SELECTOR", () => {
  it("covers form controls, contenteditable, live terminals, and open modals", () => {
    expect(NEW_TICKET_GUARD_SELECTOR).toContain("input");
    expect(NEW_TICKET_GUARD_SELECTOR).toContain("textarea");
    expect(NEW_TICKET_GUARD_SELECTOR).toContain("select");
    expect(NEW_TICKET_GUARD_SELECTOR).toContain("[contenteditable]");
    expect(NEW_TICKET_GUARD_SELECTOR).toContain("[data-terminal-renderer]");
    expect(NEW_TICKET_GUARD_SELECTOR).toContain('[role="dialog"]');
    expect(NEW_TICKET_GUARD_SELECTOR).toContain('[role="alertdialog"]');
  });

  it("covers the Monaco source editor by its own root AND our host attribute", () => {
    // Two anchors on purpose: `.monaco-editor` is Monaco's editor root (it
    // wraps whichever input surface the build uses), `[data-monaco-status]` is
    // ours. Either alone would be a single point of failure — this is the
    // regression guard for the bug where typing "c" in a file tab opened the
    // New-ticket dialog, because Monaco's `div.native-edit-context` input
    // surface is neither a textarea nor contenteditable.
    expect(NEW_TICKET_GUARD_SELECTOR).toContain(".monaco-editor");
    expect(NEW_TICKET_GUARD_SELECTOR).toContain("[data-monaco-status]");
  });
});

/**
 * A stand-in for a keydown target sitting inside `ancestors`. Real
 * `Element#closest` matches when ANY comma-separated compound in the selector
 * hits the element or one of its ancestors, so matching by token membership is
 * a faithful (node-environment) model of that — these tests run without a DOM.
 */
function targetWithin(...ancestors: string[]) {
  const target = {
    closest(this: unknown, selector: string) {
      if (this !== target) throw new TypeError("Illegal invocation");
      const compounds = new Set(selector.split(",").map((part) => part.trim()));
      return ancestors.some((ancestor) => compounds.has(ancestor)) ? {} : null;
    },
  };
  return target;
}

describe("isTextEntryTarget over the real guard selector", () => {
  it("guards a keydown from inside Monaco's editor root", () => {
    expect(isTextEntryTarget(targetWithin(".monaco-editor"))).toBe(true);
  });

  it("guards a keydown from inside our Monaco host, even without Monaco's own root", () => {
    expect(isTextEntryTarget(targetWithin("[data-monaco-status]"))).toBe(true);
  });

  it("guards the CodeMirror body editor (contenteditable) and a live terminal", () => {
    expect(isTextEntryTarget(targetWithin("[contenteditable]"))).toBe(true);
    expect(isTextEntryTarget(targetWithin("[data-terminal-renderer]"))).toBe(true);
  });

  it("still lets the shortcut through from ordinary chrome", () => {
    expect(isTextEntryTarget(targetWithin("main", "article"))).toBe(false);
  });
});

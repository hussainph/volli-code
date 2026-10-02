/**
 * Which windows may suppress an alert (VC-295 rule 5). The narrowness is the
 * feature: an open window that is not focused is a window nobody is looking at.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { NotificationTarget } from "@volli/shared";

import { createActiveTargetRegistry, type ActiveTargetWindow } from "./active-targets";

const target = (sessionId: string): NotificationTarget => ({
  kind: "session",
  projectId: "p1",
  ticketId: "t1",
  sessionId,
  interactionId: null,
  attentionId: null,
});

function fakeWindow(
  id: number,
  state: { focused?: boolean; destroyed?: boolean } = {},
): ActiveTargetWindow {
  return {
    id,
    isFocused: () => state.focused ?? false,
    isDestroyed: () => state.destroyed ?? false,
  };
}

describe("createActiveTargetRegistry", () => {
  it("reports what a focused window is showing", () => {
    const windows = [fakeWindow(1, { focused: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(1, target("s1"));
    expect(registry.focusedTargets()).toEqual([target("s1")]);
  });

  it("says nothing about an open but unfocused window", () => {
    const windows = [fakeWindow(1, { focused: false })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(1, target("s1"));
    expect(registry.focusedTargets()).toEqual([]);
  });

  it("keeps each window's own answer", () => {
    const windows = [fakeWindow(1, { focused: true }), fakeWindow(2, { focused: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(1, target("s1"));
    registry.report(2, target("s2"));
    expect(registry.focusedTargets()).toEqual([target("s1"), target("s2")]);
  });

  it("forgets a window that navigated away from every target", () => {
    const windows = [fakeWindow(1, { focused: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(1, target("s1"));
    registry.report(1, null);
    expect(registry.focusedTargets()).toEqual([]);
  });

  it("ignores a window that never reported anything", () => {
    const windows = [fakeWindow(1, { focused: true }), fakeWindow(2, { focused: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(2, target("s2"));
    expect(registry.focusedTargets()).toEqual([target("s2")]);
  });

  it("drops a destroyed window's last answer", () => {
    const windows = [fakeWindow(1, { focused: true, destroyed: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(1, target("s1"));
    expect(registry.focusedTargets()).toEqual([]);
  });

  it("releases what a closed window was showing", () => {
    const windows = [fakeWindow(1, { focused: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });
    registry.report(1, target("s1"));
    registry.forget(1);
    expect(registry.focusedTargets()).toEqual([]);
  });
});

/**
 * The same reading, narrowed to Sessions, plus the announcement the read rule
 * hangs off (VC-30 A1): a Session that becomes visible in a focused window is
 * a Session somebody is looking at.
 */
describe("createActiveTargetRegistry — focused Sessions (VC-30)", () => {
  const ticket: NotificationTarget = { kind: "ticket", projectId: "p1", ticketId: "t1" };

  it("names only the Sessions in front of a focused window", () => {
    const windows = [
      fakeWindow(1, { focused: true }),
      fakeWindow(2, { focused: false }),
      fakeWindow(3, { focused: true }),
    ];
    const registry = createActiveTargetRegistry({ windows: () => windows });

    registry.report(1, target("s1"));
    registry.report(2, target("s2"));
    // A ticket in front is not the Session beside it.
    registry.report(3, ticket);

    expect(registry.focusedSessionIds()).toEqual(new Set(["s1"]));
  });

  it("announces the set when a window changes what it shows", () => {
    const windows = [fakeWindow(1, { focused: true })];
    const onFocusedSessions = vi.fn();
    const registry = createActiveTargetRegistry({ windows: () => windows, onFocusedSessions });

    registry.report(1, target("s1"));

    expect(onFocusedSessions).toHaveBeenCalledExactlyOnceWith(new Set(["s1"]));
  });

  it("announces nothing when the set did not move", () => {
    const windows = [fakeWindow(1, { focused: true }), fakeWindow(2, { focused: true })];
    const onFocusedSessions = vi.fn();
    const registry = createActiveTargetRegistry({ windows: () => windows, onFocusedSessions });
    registry.report(1, target("s1"));
    onFocusedSessions.mockClear();

    // The same Session, re-reported with a different item in it, and a second
    // window showing the same one: neither changes which Sessions are in front.
    registry.report(1, {
      kind: "session",
      projectId: "p1",
      ticketId: "t1",
      sessionId: "s1",
      interactionId: "i1",
      attentionId: null,
    });
    registry.report(2, target("s1"));
    registry.noteFocusChanged();

    expect(onFocusedSessions).not.toHaveBeenCalled();
  });

  it("announces when focus itself moves, with nothing on screen changing", () => {
    const state = { focused: false };
    const windows = [
      { id: 1, isFocused: () => state.focused, isDestroyed: () => false },
    ] satisfies ActiveTargetWindow[];
    const onFocusedSessions = vi.fn();
    const registry = createActiveTargetRegistry({ windows: () => windows, onFocusedSessions });
    registry.report(1, target("s1"));
    expect(onFocusedSessions).not.toHaveBeenCalled();

    // The person came back to a window that was already showing the Session.
    state.focused = true;
    registry.noteFocusChanged();

    expect(onFocusedSessions).toHaveBeenCalledExactlyOnceWith(new Set(["s1"]));

    // And away again: the set empties, which is a change like any other.
    state.focused = false;
    registry.noteFocusChanged();
    expect(onFocusedSessions).toHaveBeenLastCalledWith(new Set());
  });

  it("announces the emptied set when the window showing it goes away", () => {
    const windows = [fakeWindow(1, { focused: true })];
    const onFocusedSessions = vi.fn();
    const registry = createActiveTargetRegistry({ windows: () => windows, onFocusedSessions });
    registry.report(1, target("s1"));

    registry.forget(1);

    expect(onFocusedSessions).toHaveBeenLastCalledWith(new Set());
  });

  it("works with no listener at all", () => {
    const windows = [fakeWindow(1, { focused: true })];
    const registry = createActiveTargetRegistry({ windows: () => windows });

    expect(() => {
      registry.report(1, target("s1"));
      registry.noteFocusChanged();
      registry.forget(1);
    }).not.toThrow();
  });
});

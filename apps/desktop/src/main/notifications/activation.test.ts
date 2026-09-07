/**
 * What a click on an alert does (VC-295 rule 6): bring Volli forward, then hand
 * the target to a window that can route to it — or park it when there is no
 * window yet, because a send into a page that has not subscribed is a click
 * that silently did nothing.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { NotificationTarget } from "@volli/shared";

import { createNotificationActivation, type ActivationWindow } from "./activation";

const TARGET: NotificationTarget = {
  kind: "session",
  projectId: "p1",
  ticketId: "t1",
  sessionId: "s1",
  interactionId: "i1",
  attentionId: null,
};

function fakeWindow(state: { focused?: boolean; minimized?: boolean; destroyed?: boolean } = {}) {
  const acts: string[] = [];
  const sent: NotificationTarget[] = [];
  const window: ActivationWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    isFocused: () => state.focused ?? false,
    restore: () => acts.push("restore"),
    show: () => acts.push("show"),
    focus: () => acts.push("focus"),
    send: (target) => sent.push(target),
  };
  return { window, acts, sent };
}

describe("createNotificationActivation", () => {
  it("focuses the app and routes the target to the focused window", () => {
    const focused = fakeWindow({ focused: true });
    const other = fakeWindow();
    let appFocused = 0;
    const activation = createNotificationActivation({
      windows: () => [other.window, focused.window],
      focusApp: () => (appFocused += 1),
      openWindow: () => expect.unreachable("a window already exists"),
    });
    activation.activate(TARGET);
    expect(appFocused).toBe(1);
    expect(focused.sent).toEqual([TARGET]);
    expect(other.sent).toEqual([]);
  });

  it("uses the first live window when none is focused", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const activation = createNotificationActivation({
      windows: () => [first.window, second.window],
      focusApp: () => {},
      openWindow: () => {},
    });
    activation.activate(TARGET);
    expect(first.sent).toEqual([TARGET]);
    expect(first.acts).toContain("focus");
  });

  it("restores a minimized window before showing it", () => {
    const minimized = fakeWindow({ minimized: true });
    const activation = createNotificationActivation({
      windows: () => [minimized.window],
      focusApp: () => {},
      openWindow: () => {},
    });
    activation.activate(TARGET);
    expect(minimized.acts).toEqual(["restore", "show", "focus"]);
  });

  it("never routes through a destroyed window", () => {
    const dead = fakeWindow({ destroyed: true });
    const live = fakeWindow();
    const activation = createNotificationActivation({
      windows: () => [dead.window, live.window],
      focusApp: () => {},
      openWindow: () => {},
    });
    activation.activate(TARGET);
    expect(dead.sent).toEqual([]);
    expect(live.sent).toEqual([TARGET]);
  });

  it("brings a window forward without routing when the alert had no target", () => {
    // A free-form `volli notify` names nothing, so nothing is opened — but the
    // click still does the one thing every notification click does.
    const window = fakeWindow({ focused: true });
    let appFocused = 0;
    const activation = createNotificationActivation({
      windows: () => [window.window],
      focusApp: () => (appFocused += 1),
      openWindow: () => {},
    });
    activation.activate(null);
    expect(appFocused).toBe(1);
    expect(window.sent).toEqual([]);
    expect(window.acts).toContain("focus");
  });

  it("parks the target and opens a window when every window is closed", () => {
    // macOS keeps the app alive with no windows; the click is what asks for one.
    let opened = 0;
    const activation = createNotificationActivation({
      windows: () => [],
      focusApp: () => {},
      openWindow: () => (opened += 1),
    });
    activation.activate(TARGET);
    expect(opened).toBe(1);
    expect(activation.takePending()).toEqual(TARGET);
  });

  it("hands a parked target over exactly once", () => {
    const activation = createNotificationActivation({
      windows: () => [],
      focusApp: () => {},
      openWindow: () => {},
    });
    activation.activate(TARGET);
    expect(activation.takePending()).toEqual(TARGET);
    expect(activation.takePending()).toBeNull();
  });

  it("has nothing parked until a click without a window", () => {
    const activation = createNotificationActivation({
      windows: () => [],
      focusApp: () => {},
      openWindow: () => {},
    });
    expect(activation.takePending()).toBeNull();
  });

  it("keeps the newest parked target when a second alert is clicked first", () => {
    const activation = createNotificationActivation({
      windows: () => [],
      focusApp: () => {},
      openWindow: () => {},
    });
    activation.activate(TARGET);
    activation.activate({ kind: "update" });
    expect(activation.takePending()).toEqual({ kind: "update" });
  });

  it("parks nothing for a target-less click with no window", () => {
    let opened = 0;
    const activation = createNotificationActivation({
      windows: () => [],
      focusApp: () => {},
      openWindow: () => (opened += 1),
    });
    activation.activate(null);
    expect(opened).toBe(1);
    expect(activation.takePending()).toBeNull();
  });

  it("swallows a failure from the window and reports it", () => {
    const errors: unknown[] = [];
    const activation = createNotificationActivation({
      windows: () => {
        throw new Error("no window list");
      },
      focusApp: () => {},
      openWindow: () => {},
      onError: (error) => errors.push(error),
    });
    activation.activate(TARGET);
    expect(errors).toHaveLength(1);
  });

  it("defaults its diagnostics seam to the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const activation = createNotificationActivation({
      windows: () => {
        throw new Error("no window list");
      },
      focusApp: () => {},
      openWindow: () => {},
    });
    activation.activate(TARGET);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

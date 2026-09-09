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

let nextWindowId = 1;

function fakeWindow(
  state: { focused?: boolean; minimized?: boolean; destroyed?: boolean; id?: number } = {},
) {
  const acts: string[] = [];
  const sent: NotificationTarget[] = [];
  const id = state.id ?? nextWindowId++;
  const window: ActivationWindow = {
    id,
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    isFocused: () => state.focused ?? false,
    restore: () => acts.push("restore"),
    show: () => acts.push("show"),
    focus: () => acts.push("focus"),
    send: (target) => sent.push(target),
  };
  return { window, acts, sent, id };
}

/**
 * An activation whose windows have all announced their renderer. Most cases are
 * about WHICH window a click reaches; the subscription rule has its own block
 * below.
 */
function withReadyWindows(
  ports: Parameters<typeof createNotificationActivation>[0],
  windows: readonly { id: number }[],
) {
  const activation = createNotificationActivation(ports);
  for (const window of windows) activation.markRendererReady(window.id);
  return activation;
}

describe("createNotificationActivation", () => {
  it("focuses the app and routes the target to the focused window", () => {
    const focused = fakeWindow({ focused: true });
    const other = fakeWindow();
    let appFocused = 0;
    const activation = withReadyWindows(
      {
        windows: () => [other.window, focused.window],
        focusApp: () => (appFocused += 1),
        openWindow: () => expect.unreachable("a window already exists"),
      },
      [other, focused],
    );
    activation.activate(TARGET);
    expect(appFocused).toBe(1);
    expect(focused.sent).toEqual([TARGET]);
    expect(other.sent).toEqual([]);
  });

  it("uses the first live window when none is focused", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const activation = withReadyWindows(
      { windows: () => [first.window, second.window], focusApp: () => {}, openWindow: () => {} },
      [first, second],
    );
    activation.activate(TARGET);
    expect(first.sent).toEqual([TARGET]);
    expect(first.acts).toContain("focus");
  });

  it("restores a minimized window before showing it", () => {
    const minimized = fakeWindow({ minimized: true });
    const activation = withReadyWindows(
      { windows: () => [minimized.window], focusApp: () => {}, openWindow: () => {} },
      [minimized],
    );
    activation.activate(TARGET);
    expect(minimized.acts).toEqual(["restore", "show", "focus"]);
  });

  it("never routes through a destroyed window", () => {
    const dead = fakeWindow({ destroyed: true });
    const live = fakeWindow();
    const activation = withReadyWindows(
      { windows: () => [dead.window, live.window], focusApp: () => {}, openWindow: () => {} },
      [dead, live],
    );
    activation.activate(TARGET);
    expect(dead.sent).toEqual([]);
    expect(live.sent).toEqual([TARGET]);
  });

  it("brings a window forward without routing when the alert had no target", () => {
    // A free-form `volli notify` names nothing, so nothing is opened — but the
    // click still does the one thing every notification click does.
    const window = fakeWindow({ focused: true });
    let appFocused = 0;
    const activation = withReadyWindows(
      { windows: () => [window.window], focusApp: () => (appFocused += 1), openWindow: () => {} },
      [window],
    );
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

describe("a window whose renderer has not subscribed yet (round 2)", () => {
  /**
   * The listener installs after `await boot()`, so a window can exist for
   * hundreds of milliseconds with nothing listening. A push into that gap is
   * simply lost — the click did nothing, and the person is left looking at
   * whatever was already on screen.
   */
  it("parks the target rather than pushing into a window nobody is listening in", () => {
    const window = fakeWindow({ focused: true });
    const activation = createNotificationActivation({
      windows: () => [window.window],
      focusApp: () => {},
      openWindow: () => expect.unreachable("a window already exists"),
    });

    activation.activate(TARGET);

    expect(window.sent).toEqual([]);
    // The window still comes forward: the click asked for Volli.
    expect(window.acts).toContain("focus");
    expect(activation.takePending()).toEqual(TARGET);
  });

  it("routes to it as soon as its renderer announces itself", () => {
    const window = fakeWindow({ focused: true });
    const activation = createNotificationActivation({
      windows: () => [window.window],
      focusApp: () => {},
      openWindow: () => {},
    });

    activation.markRendererReady(window.id);
    activation.activate(TARGET);

    expect(window.sent).toEqual([TARGET]);
    expect(activation.takePending()).toBeNull();
  });

  it("prefers a subscribed window over the focused one that is still booting", () => {
    // Two windows, and only one can receive: pushing at the focused-but-deaf
    // one would drop the click entirely.
    const booting = fakeWindow({ focused: true });
    const ready = fakeWindow();
    const activation = createNotificationActivation({
      windows: () => [booting.window, ready.window],
      focusApp: () => {},
      openWindow: () => {},
    });

    activation.markRendererReady(ready.id);
    activation.activate(TARGET);

    expect(ready.sent).toEqual([TARGET]);
    expect(booting.sent).toEqual([]);
  });

  it("brings forward the window it routes to, not a different one (round 5)", () => {
    // The focused window is still booting; the subscribed one is minimized.
    // Restoring the first and routing into the second would leave the person
    // looking at a blank window while a hidden one navigated.
    const booting = fakeWindow({ focused: true });
    const ready = fakeWindow({ minimized: true });
    const activation = createNotificationActivation({
      windows: () => [booting.window, ready.window],
      focusApp: () => {},
      openWindow: () => {},
    });

    activation.markRendererReady(ready.id);
    activation.activate(TARGET);

    expect(ready.sent).toEqual([TARGET]);
    expect(ready.acts).toEqual(["restore", "show", "focus"]);
    expect(booting.acts).toEqual([]);
  });

  it("still takes the focused window for a target-less click, listener or not", () => {
    // Nothing to route, so nothing to wait for: the click asked for Volli.
    const booting = fakeWindow({ focused: true });
    const ready = fakeWindow();
    const activation = createNotificationActivation({
      windows: () => [booting.window, ready.window],
      focusApp: () => {},
      openWindow: () => {},
    });

    activation.markRendererReady(ready.id);
    activation.activate(null);

    expect(booting.acts).toContain("focus");
    expect(ready.acts).toEqual([]);
    expect(ready.sent).toEqual([]);
  });

  it("parks again after the renderer reloads, until the fresh page subscribes", () => {
    // The window id survives a reload; the page that subscribed does not.
    const window = fakeWindow({ focused: true });
    const activation = createNotificationActivation({
      windows: () => [window.window],
      focusApp: () => {},
      openWindow: () => {},
    });

    activation.markRendererReady(window.id);
    activation.forgetRenderer(window.id);
    activation.activate(TARGET);

    expect(window.sent).toEqual([]);
    expect(window.acts).toContain("focus");
    expect(activation.takePending()).toEqual(TARGET);

    activation.markRendererReady(window.id);
    activation.activate({ kind: "update" });
    expect(window.sent).toEqual([{ kind: "update" }]);
  });

  it("forgets a window's subscription when it closes", () => {
    // Window ids are reused by nothing here, but a stale "ready" would make the
    // next click push into a window that no longer has a renderer.
    const window = fakeWindow({ focused: true });
    const activation = createNotificationActivation({
      windows: () => [window.window],
      focusApp: () => {},
      openWindow: () => {},
    });

    activation.markRendererReady(window.id);
    activation.forgetWindow(window.id);
    activation.activate(TARGET);

    expect(window.sent).toEqual([]);
    expect(activation.takePending()).toEqual(TARGET);
  });
});

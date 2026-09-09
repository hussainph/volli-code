/**
 * Which windows may suppress an alert (VC-295 rule 5). The narrowness is the
 * feature: an open window that is not focused is a window nobody is looking at.
 */
import { describe, expect, it } from "vite-plus/test";
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

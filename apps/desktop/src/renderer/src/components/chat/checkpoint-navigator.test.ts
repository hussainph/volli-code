import { describe, expect, it, vi } from "vite-plus/test";

import { createCheckpointNavigator } from "./checkpoint-navigator";

describe("createCheckpointNavigator", () => {
  it("tells subscribers when the current checkpoint changes, and only then", () => {
    const navigator = createCheckpointNavigator();
    const listener = vi.fn();
    const unsubscribe = navigator.subscribe(listener);
    expect(navigator.current()).toBeNull();

    navigator.publish("a");
    navigator.publish("a");
    expect(navigator.current()).toBe("a");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    navigator.publish("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands a jump to the attached transcript, and drops it once detached", () => {
    const navigator = createCheckpointNavigator();
    navigator.jump("before");
    const jump = vi.fn();
    const detach = navigator.attach(jump);
    navigator.jump("a");
    expect(jump).toHaveBeenCalledWith("a");

    detach();
    navigator.jump("b");
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer transcript's jump when an older one detaches late", () => {
    const navigator = createCheckpointNavigator();
    const older = vi.fn();
    const newer = vi.fn();
    const detachOlder = navigator.attach(older);
    navigator.attach(newer);
    detachOlder();
    navigator.jump("a");
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledWith("a");
  });
});

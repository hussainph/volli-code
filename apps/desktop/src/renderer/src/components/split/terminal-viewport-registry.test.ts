/**
 * The map between a pane that wants to draw a terminal and the host that owns
 * it.
 *
 * What is asserted is what `useSyncExternalStore` demands and what a pane's
 * effects do to it: a snapshot that only changes when the SET does (a publish
 * that says nothing new must not notify, or the host re-renders every terminal
 * in the app on every layout tick), and a clear that is honest about a tab
 * nobody published.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  publishTerminalViewport,
  resetTerminalViewports,
  subscribeTerminalViewports,
  terminalViewportSnapshot,
} from "./terminal-viewport-registry";

/** A stand-in for the pane's placeholder — nothing here reads the element. */
function anchor(name: string): HTMLElement {
  return { name } as unknown as HTMLElement;
}

afterEach(() => {
  resetTerminalViewports();
});

describe("terminal viewport registry", () => {
  it("starts empty and publishes one box per terminal tab", () => {
    expect(terminalViewportSnapshot().size).toBe(0);

    const home = anchor("home");
    const ticket = anchor("ticket");
    publishTerminalViewport("tab-1", { ownerId: "project-1", anchor: home });
    publishTerminalViewport("tab-2", { ownerId: "ticket-1", anchor: ticket });

    // Both at once: this is the whole reason the single slot became a map.
    expect(terminalViewportSnapshot().get("tab-1")).toEqual({
      ownerId: "project-1",
      anchor: home,
    });
    expect(terminalViewportSnapshot().get("tab-2")?.ownerId).toBe("ticket-1");
  });

  it("replaces the snapshot rather than mutating it", () => {
    const before = terminalViewportSnapshot();
    publishTerminalViewport("tab-1", { ownerId: "p", anchor: anchor("a") });

    expect(terminalViewportSnapshot()).not.toBe(before);
    expect(before.size).toBe(0);
  });

  it("notifies once per real change and stays silent on a re-publish", () => {
    const listener = vi.fn();
    const stop = subscribeTerminalViewports(listener);
    const box = anchor("a");

    publishTerminalViewport("tab-1", { ownerId: "p", anchor: box });
    expect(listener).toHaveBeenCalledTimes(1);

    // The same pane republishing the same element — an anchor's effect re-runs
    // whenever its inputs are re-derived, and a notify here would re-render
    // every hosted terminal for nothing.
    publishTerminalViewport("tab-1", { ownerId: "p", anchor: box });
    expect(listener).toHaveBeenCalledTimes(1);

    // A different element for the same tab IS a change: the tab moved panes.
    publishTerminalViewport("tab-1", { ownerId: "p", anchor: anchor("b") });
    expect(listener).toHaveBeenCalledTimes(2);

    // So is the same element under a different owner.
    publishTerminalViewport("tab-1", { ownerId: "other", anchor: anchor("b") });
    expect(listener).toHaveBeenCalledTimes(3);

    stop();
    publishTerminalViewport("tab-2", { ownerId: "p", anchor: anchor("c") });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("clears a published tab and says nothing about one it never held", () => {
    const listener = vi.fn();
    const stop = subscribeTerminalViewports(listener);
    publishTerminalViewport("tab-1", { ownerId: "p", anchor: anchor("a") });

    publishTerminalViewport("tab-1", null);
    expect(terminalViewportSnapshot().has("tab-1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    // A pane unmounting after something else already cleared it.
    publishTerminalViewport("tab-1", null);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("resets to the same empty snapshot, and only when it holds something", () => {
    const listener = vi.fn();
    const stop = subscribeTerminalViewports(listener);
    const empty = terminalViewportSnapshot();

    resetTerminalViewports();
    expect(listener).not.toHaveBeenCalled();

    publishTerminalViewport("tab-1", { ownerId: "p", anchor: anchor("a") });
    resetTerminalViewports();
    expect(terminalViewportSnapshot()).toBe(empty);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

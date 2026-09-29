import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConnectivityPort, ONLINE_POLL_MS } from "./connectivity";

function platform(initiallyOnline: boolean) {
  const powerMonitor = new EventEmitter();
  const state = { online: initiallyOnline };
  return {
    state,
    powerMonitor,
    port: createConnectivityPort({ net: { isOnline: () => state.online }, powerMonitor }),
  };
}

describe("createConnectivityPort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the platform's own opinion of the network", () => {
    const host = platform(true);
    expect(host.port.isOnline()).toBe(true);
    host.state.online = false;
    expect(host.port.isOnline()).toBe(false);
  });

  it("does not wait when the network is already there", async () => {
    const host = platform(true);
    await expect(host.port.waitUntilOnline(new AbortController().signal)).resolves.toBe(undefined);
    expect(host.powerMonitor.listenerCount("resume")).toBe(0);
  });

  it("notices the network come back on its next poll", async () => {
    const host = platform(false);
    let back = false;
    const waiting = host.port.waitUntilOnline(new AbortController().signal).then(() => {
      back = true;
    });
    await vi.advanceTimersByTimeAsync(ONLINE_POLL_MS);
    expect(back).toBe(false);

    host.state.online = true;
    await vi.advanceTimersByTimeAsync(ONLINE_POLL_MS);
    await waiting;
    expect(back).toBe(true);
    // Nothing is left polling or listening once the wait is over.
    expect(host.powerMonitor.listenerCount("resume")).toBe(0);
    expect(host.powerMonitor.listenerCount("unlock-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resume", "unlock-screen"] as const)(
    "re-asks at once on %s rather than at the next poll",
    async (event) => {
      const host = platform(false);
      const waiting = host.port.waitUntilOnline(new AbortController().signal);
      host.state.online = true;
      host.powerMonitor.emit(event);
      await expect(waiting).resolves.toBe(undefined);
    },
  );

  it("keeps waiting through a wake that found no network", async () => {
    const host = platform(false);
    let back = false;
    void host.port.waitUntilOnline(new AbortController().signal).then(() => {
      back = true;
    });
    host.powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(0);
    expect(back).toBe(false);
    expect(host.powerMonitor.listenerCount("resume")).toBe(1);
  });

  it("stops waiting, and cleans up, when the turn is stopped", async () => {
    const host = platform(false);
    const stop = new AbortController();
    const waiting = host.port.waitUntilOnline(stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow("Stopped waiting for the network.");
    expect(host.powerMonitor.listenerCount("resume")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to start a wait that was already stopped", async () => {
    const host = platform(false);
    const stop = new AbortController();
    stop.abort();
    await expect(host.port.waitUntilOnline(stop.signal)).rejects.toThrow(
      "Stopped waiting for the network.",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds one platform listener per event however many attachments and waits listen", async () => {
    const host = platform(false);
    const woken = vi.fn();
    const unsubscribes = Array.from({ length: 20 }, () => host.port.onResume(woken));
    const stops = Array.from({ length: 20 }, () => new AbortController());
    const waits = stops.map((stop) =>
      host.port.waitUntilOnline(stop.signal).catch(() => undefined),
    );
    expect(host.powerMonitor.listenerCount("resume")).toBe(1);
    expect(host.powerMonitor.listenerCount("unlock-screen")).toBe(1);

    host.powerMonitor.emit("resume");
    expect(woken).toHaveBeenCalledTimes(20);

    for (const stop of stops) stop.abort();
    await Promise.all(waits);
    expect(host.powerMonitor.listenerCount("unlock-screen")).toBe(0);
    for (const unsubscribe of unsubscribes) unsubscribe();
    // A second unsubscribe is harmless.
    unsubscribes[0]!();
    expect(host.powerMonitor.listenerCount("resume")).toBe(0);
  });

  it("reports wakes until unsubscribed", () => {
    const host = platform(true);
    const listener = vi.fn();
    const unsubscribe = host.port.onResume(listener);
    host.powerMonitor.emit("resume");
    // Unlocking is not waking: sockets survive a locked screen.
    host.powerMonitor.emit("unlock-screen");
    unsubscribe();
    host.powerMonitor.emit("resume");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

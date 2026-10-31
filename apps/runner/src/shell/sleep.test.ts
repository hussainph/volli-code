import { getEventListeners } from "node:events";
import { describe, expect, it } from "vite-plus/test";

import { abortableSleep } from "./sleep";

describe("an abortable sleep", () => {
  it("waits its time, then leaves no listener behind", async () => {
    const interrupt = new AbortController();
    const started = Date.now();
    await abortableSleep(20, interrupt.signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(getEventListeners(interrupt.signal, "abort")).toHaveLength(0);
  });

  it("ends early when interrupted mid-wait, and at once when already interrupted", async () => {
    const interrupt = new AbortController();
    const started = Date.now();
    const waiting = abortableSleep(60_000, interrupt.signal);
    expect(getEventListeners(interrupt.signal, "abort")).toHaveLength(1);
    interrupt.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(getEventListeners(interrupt.signal, "abort")).toHaveLength(0);
    await abortableSleep(60_000, interrupt.signal);
  });
});

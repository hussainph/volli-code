import { EventEmitter } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import type { PowerEvent, PowerPort } from "../ports/power";
import { createRunnerPowerCycle, watchSleep } from "./wake";

function parts(overrides: { setState?: (state: string) => Promise<void> } = {}) {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const cycle = createRunnerPowerCycle({
    link: { reconnectNow: () => void calls.push("reconnect") },
    token: async ({ forceRefreshToken }) => {
      calls.push(`token force=${forceRefreshToken}`);
      return "t";
    },
    presence: {
      setState:
        overrides.setState ??
        (async (state) => {
          calls.push(`state ${state}`);
        }),
      beatNow: async () => void calls.push("beat"),
    },
    suspendBudgetMs: 20,
    onError: (error) => errors.push(error),
  });
  return { cycle, calls, errors };
}

describe("runner power cycle", () => {
  it("reports asleep on suspend", async () => {
    const p = parts();
    await p.cycle.suspend();
    expect(p.calls).toEqual(["state asleep"]);
  });

  it("gives up on the asleep report after its budget, and never rejects", async () => {
    const hung = parts({ setState: () => new Promise<void>(() => {}) });
    await hung.cycle.suspend();
    const failing = parts({ setState: async () => Promise.reject(new Error("offline")) });
    await failing.cycle.suspend();
    expect(failing.errors).toHaveLength(1);
  });

  it("wakes in order: reconnect, fresh token, online, beat", async () => {
    const p = parts();
    await p.cycle.resume();
    expect(p.calls).toEqual(["reconnect", "state online", "token force=true", "beat"]);
  });

  it("keeps waking when the token exchange fails offline", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const cycle = createRunnerPowerCycle({
      link: { reconnectNow: () => void calls.push("reconnect") },
      token: async () => Promise.reject(new Error("unavailable")),
      presence: {
        setState: async (state) => void calls.push(`state ${state}`),
        beatNow: async () => Promise.reject(new Error("still offline")),
      },
      onError: (error) => errors.push(error),
    });
    await cycle.resume();
    expect(calls).toEqual(["reconnect", "state online"]);
    expect(errors).toHaveLength(2);
  });
});

describe("watchSleep", () => {
  it("wakes once per sleep, on the first proof of wake", () => {
    const power = new EventEmitter() as EventEmitter & PowerPort;
    const seen: string[] = [];
    const off = watchSleep(power, {
      onSleep: () => seen.push("sleep"),
      onWake: () => seen.push("wake"),
    });
    const emit = (event: PowerEvent) => power.emit(event);
    emit("unlock-screen");
    emit("suspend");
    emit("resume");
    emit("unlock-screen");
    emit("suspend");
    emit("user-did-become-active");
    expect(seen).toEqual(["sleep", "wake", "sleep", "wake"]);
    off();
    emit("suspend");
    emit("resume");
    expect(seen).toHaveLength(4);
    expect(power.listenerCount("suspend")).toBe(0);
  });
});

/**
 * Settings → Runners' status words (VC-895): each status the backend writes,
 * this Mac's own states, and the one recovery a blocked Mac offers.
 */
import { describe, expect, it } from "vite-plus/test";
import { THIS_MAC_RUNNER_OFF, type ThisMacRunnerSnapshot } from "@volli/shared";

import { runnerStatus, sinceLabel, thisMacRecovery, thisMacStatus } from "./use-runners";

const NOW = new Date(2026, 9, 25, 16, 30).getTime();
const EARLIER_TODAY = new Date(2026, 9, 25, 14, 2).getTime();
const YESTERDAY = new Date(2026, 9, 24, 9, 0).getTime();

const at = (status: string, statusReason: string | null = null, statusChangedAt = EARLIER_TODAY) =>
  runnerStatus({ status, statusReason, statusChangedAt }, NOW);

const mac = (patch: Partial<ThisMacRunnerSnapshot>): ThisMacRunnerSnapshot => ({
  ...THIS_MAC_RUNNER_OFF,
  ...patch,
});

describe("a runner's status", () => {
  it("says each status the backend writes in a short phrase, with its dot", () => {
    const time = sinceLabel(EARLIER_TODAY, NOW);
    expect(at("online")).toEqual({ state: "ready", label: "Online" });
    expect(at("offline")).toEqual({ state: "idle", label: `Offline since ${time}` });
    expect(at("asleep")).toEqual({ state: "parked", label: `Asleep since ${time}` });
    expect(at("stopped")).toEqual({ state: "exited", label: "Volli is closed" });
    expect(at("updating")).toEqual({ state: "starting", label: "Updating" });
    expect(at("revoked", "credential_reuse")).toEqual({
      state: "error",
      label: "Used from two places",
    });
    expect(at("revoked", "removed")).toEqual({ state: "error", label: "Removed" });
  });

  it("shows a status this build does not name as the backend wrote it", () => {
    expect(at("hibernating")).toEqual({ state: "idle", label: "hibernating" });
    expect(at("draining")).toEqual({ state: "idle", label: "draining" });
  });

  it("names the time today and the date before that", () => {
    const today = sinceLabel(EARLIER_TODAY, NOW);
    expect(today).toBe(
      new Date(EARLIER_TODAY).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
    expect(sinceLabel(YESTERDAY, NOW)).toBe(
      new Date(YESTERDAY).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(sinceLabel(NOW)).toBe(
      new Date(NOW).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
  });
});

describe("this Mac's own state", () => {
  it("speaks for itself only while being added, connecting, or out of reach", () => {
    expect(thisMacStatus(mac({ state: "unregistered" }))).toEqual({
      state: "starting",
      label: "Adding…",
    });
    expect(thisMacStatus(mac({ state: "registering" }))).toEqual({
      state: "starting",
      label: "Adding…",
    });
    expect(thisMacStatus(mac({ state: "connecting" }))).toEqual({
      state: "starting",
      label: "Connecting…",
    });
    expect(thisMacStatus(mac({ state: "offline", since: EARLIER_TODAY }), NOW)).toEqual({
      state: "idle",
      label: `Offline since ${sinceLabel(EARLIER_TODAY, NOW)}`,
    });
    expect(thisMacStatus(mac({ state: "offline" }))).toEqual({ state: "idle", label: "Offline" });
    for (const state of ["off", "online", "asleep", "removed", "failed"] as const) {
      expect(thisMacStatus(mac({ state })), state).toBeNull();
    }
  });

  it("offers one recovery when blocked, and none otherwise", () => {
    expect(thisMacRecovery(mac({ state: "removed" }))).toEqual({
      label: "Add this Mac again",
      failed: false,
    });
    expect(thisMacRecovery(mac({ state: "failed" }))).toEqual({ label: "Try again", failed: true });
    for (const state of ["off", "registering", "connecting", "online", "offline"] as const) {
      expect(thisMacRecovery(mac({ state })), state).toBeNull();
    }
  });
});

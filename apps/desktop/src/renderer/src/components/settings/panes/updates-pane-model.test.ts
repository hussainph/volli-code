import { describe, expect, it } from "vite-plus/test";

import type { UpdateLastCheck, UpdateUiState } from "../../../../../ipc/contract";
import { updateStatus } from "./updates-pane-model";

const NOW = 10 * 60 * 60 * 1000;
const THREE_HOURS_AGO = NOW - 3 * 60 * 60 * 1000;

function snapshot(overrides: Partial<UpdateUiState> = {}): UpdateUiState {
  return {
    supported: true,
    phase: "idle",
    currentVersion: "0.2.0",
    targetVersion: null,
    percent: null,
    error: null,
    lastCheck: null,
    ...overrides,
  };
}

function checked(overrides: Partial<UpdateLastCheck>): UpdateLastCheck {
  return { at: THREE_HOURS_AGO, result: "up-to-date", version: null, error: null, ...overrides };
}

describe("updateStatus", () => {
  it("says a dev build has no updater, rather than offering a check", () => {
    expect(updateStatus(snapshot({ supported: false }), NOW)).toEqual({
      state: "exited",
      label: "Off in development builds",
      detail: null,
      action: "Check now",
    });
  });

  it("tells never-checked apart from up to date — the conflation idle used to carry", () => {
    expect(updateStatus(snapshot(), NOW)).toMatchObject({
      state: "idle",
      label: "Not checked yet",
    });
    expect(updateStatus(snapshot({ lastCheck: checked({}) }), NOW)).toEqual({
      state: "ready",
      label: "Up to date · 3h ago",
      detail: null,
      action: "Check now",
    });
  });

  it("keeps a failure readable with a retry, this run or after a relaunch", () => {
    const failed = checked({ result: "error", error: "offline" });
    // This run: the phase carries the failure.
    expect(
      updateStatus(snapshot({ phase: "error", error: "offline", lastCheck: failed }), NOW),
    ).toEqual({
      state: "error",
      label: "Check failed · 3h ago",
      detail: "offline",
      action: "Retry",
    });
    // A relaunch: idle again, and the stored check still says what happened.
    expect(updateStatus(snapshot({ lastCheck: failed }), NOW)).toEqual({
      state: "error",
      label: "Check failed · 3h ago",
      detail: "offline",
      action: "Retry",
    });
    // An error phase with no stored check (a broken db's run) still reads.
    expect(updateStatus(snapshot({ phase: "error", error: "offline" }), NOW)).toMatchObject({
      label: "Check failed",
      detail: "offline",
      action: "Retry",
    });
  });

  it("shows the phase while something is happening", () => {
    expect(updateStatus(snapshot({ phase: "checking" }), NOW)).toMatchObject({
      state: "working",
      label: "Checking…",
    });
    expect(
      updateStatus(snapshot({ phase: "downloading", targetVersion: "0.3.0", percent: 41.6 }), NOW),
    ).toMatchObject({ state: "working", label: "Downloading Volli 0.3.0 · 42%" });
    expect(updateStatus(snapshot({ phase: "downloading" }), NOW)).toMatchObject({
      label: "Downloading update",
    });
  });

  it("names a staged download as ready to restart", () => {
    expect(
      updateStatus(snapshot({ phase: "downloaded", targetVersion: "0.3.0" }), NOW),
    ).toMatchObject({ state: "ready", label: "Volli 0.3.0 ready to restart", action: "Check now" });
    expect(updateStatus(snapshot({ phase: "downloaded" }), NOW)).toMatchObject({
      label: "Ready to restart",
    });
  });

  it("reads an earlier run's unfinished find as available — unless it is what runs now", () => {
    expect(
      updateStatus(
        snapshot({ lastCheck: checked({ result: "available", version: "0.3.0" }) }),
        NOW,
      ),
    ).toEqual({
      state: "waiting",
      label: "Volli 0.3.0 available · 3h ago",
      detail: null,
      action: "Check now",
    });
    expect(
      updateStatus(snapshot({ lastCheck: checked({ result: "available", version: null }) }), NOW),
    ).toMatchObject({ label: "Update available · 3h ago" });
    // Installed since: the running build IS the version that check found.
    expect(
      updateStatus(
        snapshot({ lastCheck: checked({ result: "available", version: "0.2.0" }) }),
        NOW,
      ),
    ).toMatchObject({ state: "ready", label: "Up to date · 3h ago" });
  });
});

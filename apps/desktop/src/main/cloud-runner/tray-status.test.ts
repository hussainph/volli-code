import { describe, expect, it } from "vite-plus/test";
import { THIS_MAC_RUNNER_OFF, type ThisMacRunnerState } from "@volli/shared";
import { runnerTrayStatus } from "./tray-status";

const status = (state: ThisMacRunnerState, waitingFacts = 0) =>
  runnerTrayStatus({ ...THIS_MAC_RUNNER_OFF, state, runnerName: "studio", waitingFacts });

describe("cloud runner Tray status", () => {
  it("names the connection and retained updates, never ids", () => {
    expect(status("online")).toBe("Connected to Volli Cloud as studio");
    expect(status("offline", 1)).toBe("Offline — 1 update waiting");
    expect(status("offline", 12)).toBe("Offline — 12 updates waiting");
    expect(status("asleep")).toBe("studio is asleep");
    expect(status("removed")).toBe("studio was removed from your account");
    expect(status("failed")).toBe("This Mac could not connect");
    expect(
      runnerTrayStatus({ ...THIS_MAC_RUNNER_OFF, state: "failed", message: "Unlock credentials" }),
    ).toBe("Unlock credentials");
    expect(status("off")).toBe("This Mac is not connected to Volli Cloud");
    expect(status("connecting")).toBe("Connecting studio to Volli Cloud…");
    expect(runnerTrayStatus({ ...THIS_MAC_RUNNER_OFF, state: "connecting" })).toContain("this Mac");
  });
});

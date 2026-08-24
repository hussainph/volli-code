import { describe, expect, it } from "vite-plus/test";
import type { AgentObservabilityView } from "../../../../ipc/contract";

import { agentObservabilityPanel } from "./agent-observability-model";

const view = (overrides: Partial<AgentObservabilityView> = {}): AgentObservabilityView => ({
  enabled: false,
  endpoint: "http://localhost:4318",
  status: "off",
  problem: null,
  ...overrides,
});

describe("agentObservabilityPanel", () => {
  it("says nothing at all when export is off", () => {
    expect(agentObservabilityPanel(view())).toEqual({
      enabled: false,
      stateLabel: "Off",
      dotState: "idle",
      problem: null,
    });
  });

  it("keeps quiet about a stale problem once export has been turned off", () => {
    // Nothing is being exported, so there is nothing failing to be explained.
    expect(
      agentObservabilityPanel(view({ enabled: false, status: "failed", problem: "no answer" }))
        .problem,
    ).toBeNull();
  });

  it("reads as exporting when telemetry is landing", () => {
    expect(agentObservabilityPanel(view({ enabled: true, status: "exporting" }))).toEqual({
      enabled: true,
      stateLabel: "Exporting",
      dotState: "ready",
      problem: null,
    });
  });

  it("distinguishes enabled-and-not-landing from off, and carries the one sentence", () => {
    expect(
      agentObservabilityPanel(
        view({ enabled: true, status: "failed", problem: "Nothing is answering at this address." }),
      ),
    ).toEqual({
      enabled: true,
      stateLabel: "Not delivering",
      dotState: "error",
      problem: "Nothing is answering at this address.",
    });
  });

  it("still shows the failed state when main named no sentence for it", () => {
    expect(agentObservabilityPanel(view({ enabled: true, status: "failed" }))).toEqual({
      enabled: true,
      stateLabel: "Not delivering",
      dotState: "error",
      problem: null,
    });
  });

  it("never restates the switch position as a problem", () => {
    for (const status of ["off", "exporting", "failed"] as const) {
      const panel = agentObservabilityPanel(view({ enabled: true, status }));
      expect(panel.enabled).toBe(true);
      if (status !== "failed") expect(panel.problem).toBeNull();
    }
  });
});

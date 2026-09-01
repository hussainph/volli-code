import { describe, expect, it } from "vite-plus/test";

import { runAutomationAction } from "./run-automation-model";

describe("runAutomationAction", () => {
  it("exposes the fresh Session for the success toast without choosing navigation", () => {
    expect(
      runAutomationAction({
        ok: true,
        run: {
          id: "run-1",
          automationId: "automation-1",
          automationName: "Review",
          ticketId: "t1",
          sessionId: "session-1",
          model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
          attendance: "attended",
          createdAt: 1,
        },
        projectId: "p1",
        receipt: {
          id: "00000000-0000-4000-8000-000000000001",
          commandId: "00000000-0000-4000-8000-000000000002",
          status: "completed",
          recordedAt: 1,
        },
      }),
    ).toEqual({
      kind: "session-started",
      sessionId: "session-1",
      projectId: "p1",
      automationName: "Review",
    });
  });

  it("opens Model Access for the missing-default refusal — recovery, not an error", () => {
    expect(
      runAutomationAction({ ok: false, code: "MODEL_REQUIRED", error: "Choose a default model." }),
    ).toEqual({ kind: "open-model-access" });
  });

  it("toasts every other refusal, coded or enveloped", () => {
    expect(
      runAutomationAction({ ok: false, code: "RUN_IN_FLIGHT", error: "A Run is already working." }),
    ).toEqual({ kind: "toast", message: "Couldn't run automation: A Run is already working." });
    expect(runAutomationAction({ ok: false, error: "Invalid automation run request" })).toEqual({
      kind: "toast",
      message: "Couldn't run automation: Invalid automation run request",
    });
  });
});

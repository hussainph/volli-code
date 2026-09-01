import { describe, expect, it } from "vite-plus/test";

import { automationTicketIdsFromDrop, runAutomationAction } from "./run-automation-model";

describe("automationTicketIdsFromDrop", () => {
  it("accepts and de-duplicates a multi-ticket board payload", () => {
    expect(
      automationTicketIdsFromDrop({
        kind: "tickets",
        projectId: "p1",
        ticketIds: ["ticket-a", "ticket-b", "ticket-a"],
      }),
    ).toEqual(["ticket-a", "ticket-b"]);
  });

  it("rejects empty or unrelated drag payloads", () => {
    expect(
      automationTicketIdsFromDrop({ kind: "tickets", projectId: "p1", ticketIds: [] }),
    ).toBeNull();
    expect(automationTicketIdsFromDrop({ kind: "file", path: "a.ts" })).toBeNull();
  });
});

describe("runAutomationAction", () => {
  it("navigates to the fresh Session on success", () => {
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
    ).toEqual({ kind: "open-session", sessionId: "session-1", projectId: "p1" });
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

import { describe, expect, it } from "vite-plus/test";

import { buildMutationPlan, isAgentMutationPlan, verbEntry } from "./index";

describe("side-effect preview contract", () => {
  it("builds one host-neutral plan shape from a verb's canonical effects", () => {
    const entry = verbEntry("ticket.comment");
    expect(entry).toBeDefined();
    const plan = buildMutationPlan(entry!, {
      kind: "ticket",
      id: "VC-91",
      label: "VC-91",
    });

    expect(plan).toEqual({
      v: 1,
      kind: "mutation-plan",
      dryRun: true,
      verb: "ticket.comment",
      target: { kind: "ticket", id: "VC-91", label: "VC-91" },
      durableWrites: [
        {
          resource: "ticket-comment",
          operation: "create",
          summary: "Create one attributed Ticket comment and its Ticket activity event.",
        },
      ],
      humanVisibleEffects: ["The comment appears in the Ticket activity feed."],
      nonEffects: ["The Ticket does not move and no Session starts."],
      caveat:
        "Preview only: no state changed. A later real call repeats validation and can lose a race.",
    });
    expect(isAgentMutationPlan(plan)).toBe(true);
  });

  it("can represent a validated no-op without inventing a write", () => {
    const entry = verbEntry("ticket.move")!;
    const plan = buildMutationPlan(
      entry,
      { kind: "ticket", id: "ticket-1", label: "VC-1" },
      {
        durableWrites: [],
        humanVisibleEffects: [],
        nonEffects: ["The Ticket is already in Doing; no row or Ticket event would be created."],
      },
    );

    expect(plan.durableWrites).toEqual([]);
    expect(plan.humanVisibleEffects).toEqual([]);
    expect(plan.nonEffects).toEqual([
      "The Ticket is already in Doing; no row or Ticket event would be created.",
    ]);
  });

  it("rejects values that only resemble a plan", () => {
    expect(isAgentMutationPlan({ kind: "mutation-plan", dryRun: true })).toBe(false);
    expect(isAgentMutationPlan(null)).toBe(false);
  });
});

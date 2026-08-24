import { describe, expect, it } from "vite-plus/test";

import {
  buildMutationPlan,
  declaredPreviewContract,
  isAgentMutationPlan,
  MUTATION_PLAN_CONTRACT,
  verbEntry,
} from "./index";

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

  // The socket refuses an undeclared preview before a handler runs, so this
  // throw guards the other door: a registry-projected tool that assembles a
  // plan itself. Inventing an empty contract there would let a preview promise
  // non-effects nobody ever wrote down.
  it("refuses to invent a contract for a verb that declares no effects", () => {
    const entry = verbEntry("ticket.brief")!;
    expect(entry.effects).toBeUndefined();
    expect(() =>
      buildMutationPlan(entry, { kind: "ticket", id: "VC-91", label: "VC-91" }),
    ).toThrowError("Verb ticket.brief has no declared side-effect contract");
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

  // The last thing standing between "the app answered something else" and the
  // CLI printing that answer under a Side-effect preview heading, so every
  // field it claims to check is checked one at a time.
  it("rejects values that only resemble a plan", () => {
    const valid = buildMutationPlan(verbEntry("ticket.comment")!, {
      kind: "ticket",
      id: "VC-91",
      label: "VC-91",
    });
    expect(isAgentMutationPlan(valid)).toBe(true);
    expect(isAgentMutationPlan({ ...valid, target: { ...valid.target, id: null } })).toBe(true);

    for (const wrong of [
      null,
      "mutation-plan",
      [valid],
      { kind: "mutation-plan", dryRun: true },
      { ...valid, v: 2 },
      { ...valid, kind: "ticket" },
      { ...valid, dryRun: false },
      { ...valid, verb: 91 },
      { ...valid, target: null },
      { ...valid, target: [valid.target] },
      { ...valid, target: { ...valid.target, kind: 1 } },
      { ...valid, target: { ...valid.target, id: 91 } },
      { ...valid, target: { ...valid.target, label: null } },
      { ...valid, durableWrites: "one write" },
      { ...valid, durableWrites: [null] },
      { ...valid, durableWrites: [["resource"]] },
      { ...valid, durableWrites: [{ ...valid.durableWrites[0], resource: 1 }] },
      { ...valid, durableWrites: [{ ...valid.durableWrites[0], operation: 1 }] },
      { ...valid, durableWrites: [{ ...valid.durableWrites[0], summary: 1 }] },
      { ...valid, humanVisibleEffects: "a toast" },
      { ...valid, humanVisibleEffects: [1] },
      { ...valid, nonEffects: [null] },
      { ...valid, caveat: "Preview only." },
    ]) {
      expect(isAgentMutationPlan(wrong)).toBe(false);
    }
  });

  it("reads a declared preview contract only from a well-formed identify answer", () => {
    expect(declaredPreviewContract({ previewContract: MUTATION_PLAN_CONTRACT })).toBe(
      MUTATION_PLAN_CONTRACT,
    );
    expect(declaredPreviewContract({ appVersion: "0.1.1" })).toBeNull();
    expect(declaredPreviewContract({ previewContract: "1" })).toBeNull();
    expect(declaredPreviewContract(null)).toBeNull();
    expect(declaredPreviewContract([1])).toBeNull();
    expect(declaredPreviewContract("previewContract")).toBeNull();
  });
});

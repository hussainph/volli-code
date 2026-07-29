import { describe, expect, it } from "vite-plus/test";

import {
  appendStep,
  blankStep,
  freshStepId,
  removeStep,
  renameStep,
  replaceStep,
  setJoin,
  toStages,
  type AutomationStep,
} from "./model";

/**
 * `a |b c` — steps in order, with `|` marking the ones that start alongside the
 * step before them. It reads the way the connector labels in the editor do.
 */
function spine(spec: string): AutomationStep[] {
  const steps: AutomationStep[] = [];
  for (const [index, token] of spec.split(" ").entries()) {
    const step = blankStep("claude-code", token.replace("|", ""));
    if (token.startsWith("|") && index > 0) step.join = "with";
    steps.push(step);
  }
  return steps;
}

function shape(steps: AutomationStep[]): string {
  return steps
    .map((step, index) => (step.join === "with" && index > 0 ? `|${step.id}` : step.id))
    .join(" ");
}

describe("toStages", () => {
  it("groups a `with` step onto the one above it", () => {
    expect(toStages(spine("codex |cursor triage")).map((stage) => stage.map((s) => s.id))).toEqual([
      ["codex", "cursor"],
      ["triage"],
    ]);
  });

  it("gives every step its own stage when nothing is joined", () => {
    expect(toStages(spine("a b c"))).toHaveLength(3);
  });

  it("ignores `with` on the first step, which has nothing above it", () => {
    const leading: AutomationStep[] = [{ ...blankStep("codex", "a"), join: "with" }];
    expect(toStages(leading)).toHaveLength(1);
  });
});

describe("list edits", () => {
  it("appends at the end, running after everything", () => {
    expect(shape(appendStep(spine("a |b"), blankStep("codex", "c")))).toBe("a |b c");
  });

  it("appends as `then` even when the new step arrives marked otherwise", () => {
    const stray: AutomationStep = { ...blankStep("codex", "c"), join: "with" };
    expect(shape(appendStep(spine("a"), stray))).toBe("a c");
  });

  it("flips one connector and leaves the rest alone", () => {
    expect(shape(setJoin(spine("a b c"), "b", "with"))).toBe("a |b c");
    expect(shape(setJoin(spine("a |b |c"), "c", "then"))).toBe("a |b c");
  });

  it("refuses to join the first step to something above it", () => {
    // There is nothing above it, and accepting would put the model in a state
    // the file cannot spell.
    expect(shape(setJoin(spine("a b"), "a", "with"))).toBe("a b");
  });

  it("removes a step", () => {
    expect(shape(removeStep(spine("a b c"), "b"))).toBe("a c");
  });

  it("promotes whatever becomes first, so nothing waits on a step that is gone", () => {
    // Under `after` pointers this was the hard case — the deleted step's
    // children had to be re-parented or they would dangle.
    expect(shape(removeStep(spine("a |b c"), "a"))).toBe("b c");
  });

  it("renaming touches one id and nothing else", () => {
    expect(shape(renameStep(spine("a |b"), "a", "grill"))).toBe("grill |b");
  });

  it("replaces a step in place", () => {
    const before = spine("a b");
    const after = replaceStep(before, { ...before[1], instructions: "hello" });
    expect(after[1].instructions).toBe("hello");
    expect(after[0].instructions).toBe("");
  });
});

describe("freshStepId", () => {
  it("uses the base when it is free", () => {
    expect(freshStepId(spine("a"), "codex")).toBe("codex");
  });

  it("suffixes past every taken id rather than the first one", () => {
    expect(freshStepId(spine("codex codex-2 codex-3"), "codex")).toBe("codex-4");
  });
});

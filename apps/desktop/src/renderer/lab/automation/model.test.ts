import { describe, expect, it } from "vite-plus/test";

import {
  addToStage,
  blankStep,
  freshStepId,
  insertStage,
  removeStep,
  renameStep,
  replaceStep,
  type Stage,
} from "./model";

/** Ids only, because the structure is the whole thing under test. */
function shape(stages: Stage[]): string[][] {
  return stages.map((stage) => stage.map((step) => step.id));
}

function spine(...groups: string[][]): Stage[] {
  return groups.map((ids) => ids.map((id) => blankStep("claude-code", id)));
}

describe("stage edits", () => {
  it("inserts a stage between the two it was asked to sit between", () => {
    const before = spine(["a"], ["c"]);
    const after = insertStage(before, 1, blankStep("codex", "b"));
    expect(shape(after)).toEqual([["a"], ["b"], ["c"]]);
    // Pure: the caller's array is the one React compares against.
    expect(shape(before)).toEqual([["a"], ["c"]]);
  });

  it("appends a stage at the end", () => {
    expect(shape(insertStage(spine(["a"]), 1, blankStep("codex", "b")))).toEqual([["a"], ["b"]]);
  });

  it("adds a step alongside the ones already in a stage", () => {
    expect(shape(addToStage(spine(["a"], ["b"]), 1, blankStep("codex", "c")))).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });

  it("removes a step and keeps its stage when others remain", () => {
    expect(shape(removeStep(spine(["a", "b"], ["c"]), "a"))).toEqual([["b"], ["c"]]);
  });

  it("removes the stage with the last step in it", () => {
    // Under `after` pointers this was the hard case — the deleted step's
    // children had to be re-parented or they would dangle. A stage has nothing
    // pointing at it, so it just goes.
    expect(shape(removeStep(spine(["a"], ["b"], ["c"]), "b"))).toEqual([["a"], ["c"]]);
  });

  it("renaming touches one id and nothing else", () => {
    const renamed = renameStep(spine(["a", "b"], ["c"]), "a", "grill");
    expect(shape(renamed)).toEqual([["grill", "b"], ["c"]]);
  });

  it("replaces a step in place", () => {
    const before = spine(["a", "b"]);
    const edited = { ...before[0][1], instructions: "hello" };
    const after = replaceStep(before, edited);
    expect(after[0][1].instructions).toBe("hello");
    expect(after[0][0].instructions).toBe("");
  });
});

describe("freshStepId", () => {
  it("uses the base when it is free", () => {
    expect(freshStepId(spine(["a"]), "codex")).toBe("codex");
  });

  it("suffixes past every taken id rather than the first one", () => {
    expect(freshStepId(spine(["codex", "codex-2"], ["codex-3"]), "codex")).toBe("codex-4");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  appendStep,
  blankStep,
  composeCommand,
  defaultRuntime,
  freshStepId,
  removeStep,
  renameStep,
  replaceStep,
  setJoin,
  switchHarness,
  tokenizeInstructions,
  toStages,
  triggerSummary,
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
  it("appends at the end, launching alongside everything already there", () => {
    expect(shape(appendStep(spine("a |b"), blankStep("codex", "c")))).toBe("a |b |c");
  });

  it("appends as `with` even when the new step arrives marked otherwise", () => {
    const stray: AutomationStep = { ...blankStep("codex", "c"), join: "then" };
    expect(shape(appendStep(spine("a"), stray))).toBe("a |c");
  });

  it("keeps a first step as `then` when the list was empty", () => {
    expect(shape(appendStep([], blankStep("codex", "a")))).toBe("a");
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

/** `text(...)`, `brace(name)`, `skill(/name)` — the token stream as one readable line. */
function kinds(text: string): string[] {
  return tokenizeInstructions(text).map((token) =>
    token.kind === "text"
      ? `text(${token.value})`
      : `${token.kind}(${token.kind === "brace" ? token.token : token.name})`,
  );
}

/** The composed command flattened back to a command line. */
function flags(runtime: Parameters<typeof composeCommand>[0]): string {
  return composeCommand(runtime)
    .map((part) => (part.value === undefined ? part.flag : `${part.flag} ${part.value}`))
    .join(" ");
}

describe("tokenizeInstructions", () => {
  it("leaves plain prose as one run of text", () => {
    expect(kinds("Implement this ticket.")).toEqual(["text(Implement this ticket.)"]);
  });

  it("finds a skill at the start of the text", () => {
    expect(kinds("/tdd and then stop")).toEqual(["skill(/tdd)", "text( and then stop)"]);
  });

  it("finds a skill after whitespace but not mid-word", () => {
    // The lookbehind is the whole point: `and/or` is prose, not a reference.
    expect(kinds("run /tdd now")).toEqual(["text(run )", "skill(/tdd)", "text( now)"]);
    expect(kinds("either and/or both")).toEqual(["text(either and/or both)"]);
  });

  it("marks a skill Volli cannot see as unverified rather than dropping it", () => {
    const found = tokenizeInstructions("/tdd then /nope");
    const skills = found.filter((token) => token.kind === "skill");
    expect(skills.map((token) => token.kind === "skill" && token.known)).toEqual([true, false]);
  });

  it("still recognises `{{braces}}`, so the editor can paint them as wrong", () => {
    // Placeholders mode is gone. Not recognising them would render the mistake
    // as ordinary prose, which is the one outcome that guarantees it ships.
    expect(kinds("Review {{change_set}} now")).toEqual([
      "text(Review )",
      "brace(change_set)",
      "text( now)",
    ]);
  });

  it("carries each token's offset, so the editor keys on data not on index", () => {
    const found = tokenizeInstructions("ab /tdd");
    expect(found.map((token) => token.at)).toEqual([0, 3]);
  });
});

describe("switchHarness", () => {
  it("keeps the model when the harness changes", () => {
    const from = { ...defaultRuntime("claude-code"), model: "claude-opus-5", effort: "high" };
    const to = switchHarness(from, "opencode");
    expect(to.harnessId).toBe("opencode");
    expect(to.model).toBe("claude-opus-5");
  });

  it("keeps an effort token the new scale still names", () => {
    const from = { ...defaultRuntime("claude-code"), effort: "high" };
    expect(switchHarness(from, "codex").effort).toBe("high");
  });

  it("remaps effort by relative position when names disagree", () => {
    // Claude: low medium high xhigh max (index 4 = max). Opencode: minimal high max.
    const from = { ...defaultRuntime("claude-code"), effort: "max" };
    expect(switchHarness(from, "opencode").effort).toBe("max");
  });

  it("drops effort when the destination has no dial", () => {
    const from = { ...defaultRuntime("claude-code"), effort: "high" };
    expect(switchHarness(from, "cursor").effort).toBeNull();
  });
});

describe("composeCommand", () => {
  it("spells each adapter's dialect rather than normalising them", () => {
    expect(
      flags({ ...defaultRuntime("claude-code"), model: "claude-opus-5", effort: "high" }),
    ).toContain("--effort high");
    expect(flags({ ...defaultRuntime("codex"), model: "gpt-5.1-codex", effort: "high" })).toContain(
      "-c model_reasoning_effort=high",
    );
    expect(flags({ ...defaultRuntime("opencode"), effort: "high" })).toContain("--variant high");
    expect(flags({ ...defaultRuntime("pi"), effort: "high" })).toContain("--thinking high");
  });

  it("omits an approval flag whose stop is the absence of a flag", () => {
    // opencode's "ask" is spelled by passing nothing; inventing a token for it
    // would put a flag in the command that the binary does not accept.
    const parts = composeCommand({ ...defaultRuntime("opencode"), approvals: "ask" });
    expect(parts.every((part) => part.flag !== "")).toBe(true);
  });

  it("writes no effort fragment for an adapter that has no effort dial", () => {
    const parts = composeCommand({ ...defaultRuntime("cursor"), approvals: "sandbox" });
    expect(parts.map((part) => part.flag)).not.toContain("--effort");
  });
});

describe("triggerSummary", () => {
  it("names the one column it fires in", () => {
    expect(triggerSummary({ kind: "enters-column", columns: ["doing"] })).toBe(
      "Ticket enters Doing",
    );
  });

  it("counts rather than lists once there is more than one", () => {
    expect(triggerSummary({ kind: "enters-column", columns: ["backlog", "todo"] })).toBe(
      "Ticket enters 2 columns",
    );
  });

  it("says `any column` rather than nothing when the list is empty", () => {
    expect(triggerSummary({ kind: "leaves-column", columns: [] })).toBe("Ticket leaves any column");
  });

  it("has no operand to state for a manual trigger", () => {
    expect(triggerSummary({ kind: "manual" })).toBe("Run by hand");
  });

  it("names a schedule without inventing columns", () => {
    expect(triggerSummary({ kind: "schedule" })).toBe("On a schedule");
  });
});

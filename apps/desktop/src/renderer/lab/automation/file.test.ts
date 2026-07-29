import { describe, expect, it } from "vite-plus/test";

import { automationFilePath, formatAutomationFile, parseAutomationFile, slugify } from "./file";
import { allSteps, SEEDED_AUTOMATIONS, type Automation } from "./model";

/** Only the messages, so a test reads as the complaint a person would get. */
function messages(text: string): string[] {
  return parseAutomationFile(text).diagnostics.map((diagnostic) => diagnostic.message);
}

const ONE_STEP = `---
name: Implement
on:
  enters-column: [doing]
steps:
  - id: implement
    harness: claude-code
    model: claude-opus-5
    effort: high
    approvals: acceptEdits
---

Implement this ticket. Match the conventions of the code you are changing.
`;

const TWO_STEP = `---
name: Two-opinion review
on:
  enters-column: [needs_review]
steps:
  - id: codex
    harness: codex
    model: gpt-5.1-codex
    effort: high
    approvals: read-only
    mode: placeholders
  - id: cursor
    also: true
    harness: cursor
    model: sonnet-4-thinking
    approvals: sandbox
    mode: placeholders
---

## codex

Review {{change_set}} on {{branch}}.

## cursor

Read {{change_set}} looking only for what it BREAKS.
`;

describe("parseAutomationFile", () => {
  it("reads a one-step file, treating the unheaded body as the prompt", () => {
    const { automation, diagnostics } = parseAutomationFile(ONE_STEP);

    expect(diagnostics).toEqual([]);
    expect(automation.name).toBe("Implement");
    expect(automation.scope).toBe("project");
    expect(automation.trigger).toEqual({ kind: "enters-column", columns: ["doing"] });
    expect(automation.stages).toHaveLength(1);
    expect(automation.stages[0]).toHaveLength(1);
    expect(automation.stages[0][0].id).toBe("implement");
    expect(automation.stages[0][0].runtime).toEqual({
      harnessId: "claude-code",
      model: "claude-opus-5",
      effort: "high",
      approvals: "acceptEdits",
    });
    expect(automation.stages[0][0].mode).toBe("prose");
    expect(automation.stages[0][0].instructions).toBe(
      "Implement this ticket. Match the conventions of the code you are changing.",
    );
  });

  it("maps `## id` sections onto steps", () => {
    const { automation, diagnostics } = parseAutomationFile(TWO_STEP);

    expect(diagnostics).toEqual([]);
    expect(allSteps(automation).map((step) => step.id)).toEqual(["codex", "cursor"]);
    expect(automation.stages[0][0].instructions).toBe("Review {{change_set}} on {{branch}}.");
    expect(automation.stages[0][1].instructions).toBe(
      "Read {{change_set}} looking only for what it BREAKS.",
    );
    expect(allSteps(automation).every((step) => step.mode === "placeholders")).toBe(true);
  });

  it("puts an `also` step in the same stage as the one above it", () => {
    // The whole point of the two-opinion seed: two readers running at once, not
    // one reading after the other. Under the old `join` model this was the case
    // that silently became a chain.
    const { automation } = parseAutomationFile(TWO_STEP);
    expect(automation.stages).toHaveLength(1);
    expect(automation.stages[0].map((step) => step.id)).toEqual(["codex", "cursor"]);
  });

  it("opens a new stage for a step with no `also`", () => {
    const { automation, diagnostics } = parseAutomationFile(
      TWO_STEP.replace("    also: true\n", ""),
    );
    expect(diagnostics).toEqual([]);
    expect(automation.stages.map((stage) => stage.map((step) => step.id))).toEqual([
      ["codex"],
      ["cursor"],
    ]);
  });

  it("reads `run-by-hand` as the manual trigger", () => {
    const { automation, diagnostics } = parseAutomationFile(`---
name: TDD loop
scope: global
on:
  run-by-hand:
steps:
  - id: tdd
    harness: pi
    model: anthropic/claude-opus-5
    effort: high
---

Red, green, refactor.
`);
    expect(diagnostics).toEqual([]);
    expect(automation.trigger).toEqual({ kind: "manual" });
    expect(automation.scope).toBe("global");
    expect(automation.stages).toHaveLength(1);
  });

  it("ignores comments and blank lines in frontmatter", () => {
    const { automation, diagnostics } = parseAutomationFile(
      ONE_STEP.replace("on:", "# when it fires\n\non:"),
    );
    expect(diagnostics).toEqual([]);
    expect(automation.trigger).toEqual({ kind: "enters-column", columns: ["doing"] });
  });
});

describe("parseAutomationFile diagnostics", () => {
  it("rejects a file that does not open with ---", () => {
    expect(messages("name: Nope\n")).toContain("File must open with `---`");
  });

  it("reports unclosed frontmatter", () => {
    expect(messages("---\nname: Nope\n")).toContain("Frontmatter is never closed");
  });

  it("names an unknown column rather than dropping it", () => {
    expect(messages(ONE_STEP.replace("[doing]", "[doing, shipping]"))).toContain(
      "`shipping` is not a column",
    );
  });

  it("names an unknown harness", () => {
    expect(messages(ONE_STEP.replace("harness: claude-code", "harness: aider"))).toContain(
      "Unknown harness `aider`",
    );
  });

  it("rejects a dial the adapter does not have", () => {
    // cursor-agent carries effort inside the model string; there is no flag to
    // bind, so a file asking for one believes in something that is not there.
    const cursor = ONE_STEP.replace("harness: claude-code", "harness: cursor").replace(
      "approvals: acceptEdits",
      "approvals: sandbox",
    );
    expect(messages(cursor)).toContain("Cursor has no effort dial — ignored");
  });

  it("rejects a value outside the adapter's own scale", () => {
    expect(messages(ONE_STEP.replace("effort: high", "effort: ludicrous"))).toContain(
      "`ludicrous` is not one of Claude Code's efforts",
    );
  });

  it("rejects an `also` that is not true or false", () => {
    expect(
      messages(ONE_STEP.replace("    effort: high", "    also: yes\n    effort: high")),
    ).toContain("`also` is true or false, not `yes`");
  });

  it("warns when the first step claims to run alongside something", () => {
    // There is nothing above it. Silently promoting it to a stage of its own is
    // right, saying nothing about it is not.
    const { automation, diagnostics } = parseAutomationFile(
      ONE_STEP.replace("    effort: high", "    also: true\n    effort: high"),
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toContain(
      "`implement` is the first step — there is nothing above it to run alongside",
    );
    expect(automation.stages).toHaveLength(1);
  });

  it("catches duplicate ids", () => {
    expect(messages(TWO_STEP.replace("  - id: cursor", "  - id: codex"))).toContain(
      "Duplicate step id `codex`",
    );
  });

  it("warns rather than silently dropping an unknown key", () => {
    expect(messages(ONE_STEP.replace("name: Implement", "name: Implement\nretries: 3"))).toContain(
      "Ignored unknown key `retries`",
    );
    expect(
      messages(ONE_STEP.replace("    effort: high", "    timeout: 30\n    effort: high")),
    ).toContain("Ignored unknown step key `timeout`");
  });

  it("refuses to guess when two steps share one unheaded body", () => {
    const headless = TWO_STEP.slice(0, TWO_STEP.indexOf("## codex")) + "Do the thing.\n";
    expect(messages(headless)).toContain(
      "2 steps but no `## <id>` sections — only the first gets a prompt",
    );
  });

  it("flags a section that matches no step, and a step with no section", () => {
    const renamed = TWO_STEP.replace("## cursor", "## claude");
    expect(messages(renamed)).toContain(
      "`cursor` has no `## cursor` section — it would run with no prompt",
    );
    expect(messages(renamed)).toContain("`## claude` matches no step — its prose is unused");
  });

  it("rejects a tab in indentation", () => {
    expect(messages(ONE_STEP.replace("  enters-column", "\tenters-column"))).toContain(
      "Tab in indentation — use spaces",
    );
  });

  it("reports the missing pieces of an almost-empty file", () => {
    const found = messages("---\n---\n");
    expect(found).toContain("No `name`");
    expect(found).toContain("No `on:` — nothing fires this");
    expect(found).toContain("No `steps`");
  });

  it("says so when a trigger is designed for but not built", () => {
    expect(messages(ONE_STEP.replace("enters-column", "checks-pass"))).toContain(
      "`checks-pass` is designed for but not built — this will not fire",
    );
  });
});

describe("formatAutomationFile", () => {
  it("round-trips every seeded automation", () => {
    for (const automation of SEEDED_AUTOMATIONS) {
      const { automation: reparsed, diagnostics } = parseAutomationFile(
        formatAutomationFile(automation),
      );
      expect(diagnostics, automation.name).toEqual([]);
      expect(reparsed.name).toBe(automation.name);
      expect(reparsed.scope).toBe(automation.scope);
      expect(reparsed.trigger).toEqual(automation.trigger);
      expect(reparsed.stages).toEqual(automation.stages);
    }
  });

  it("omits defaults so a simple automation stays a short file", () => {
    const text = formatAutomationFile(SEEDED_AUTOMATIONS[1]);
    expect(text).not.toContain("scope:");
    expect(text).not.toContain("mode:");
    expect(text).not.toContain("also:");
    expect(text).not.toContain("## ");
  });

  it("writes `## id` sections only once there is more than one step", () => {
    const text = formatAutomationFile(SEEDED_AUTOMATIONS[2]);
    expect(text).toContain("## codex");
    expect(text).toContain("## cursor");
    expect(text).toContain("## triage");
  });

  it("marks every step but the first of a stage with `also`", () => {
    const text = formatAutomationFile(SEEDED_AUTOMATIONS[2]);
    // Exactly one: codex opens the stage, cursor joins it, triage opens the next.
    expect(text.match(/also: true/g)).toHaveLength(1);
    expect(text).toContain("  - id: cursor\n    also: true\n");
  });

  it("does not write a dial the adapter does not have", () => {
    const cursorOnly: Automation = {
      ...SEEDED_AUTOMATIONS[2],
      stages: [[SEEDED_AUTOMATIONS[2].stages[0][1]]],
    };
    expect(formatAutomationFile(cursorOnly)).not.toContain("effort:");
  });
});

describe("paths", () => {
  it("slugifies a name into a filename", () => {
    expect(slugify("Two-opinion review")).toBe("two-opinion-review");
    expect(slugify("  Wrap up!  ")).toBe("wrap-up");
    expect(slugify("???")).toBe("untitled");
  });

  it("puts project automations in the repo and global ones in config", () => {
    expect(automationFilePath(SEEDED_AUTOMATIONS[2])).toBe(
      ".volli/automations/two-opinion-review.md",
    );
    expect(automationFilePath(SEEDED_AUTOMATIONS[4])).toBe(
      "~/.config/volli/automations/tdd-loop.md",
    );
  });
});

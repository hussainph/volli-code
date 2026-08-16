import { describe, expect, it } from "vite-plus/test";

import {
  expandCommandInvocation,
  formatPromptTemplateInvocation,
  mergePromptTemplates,
  parseCommandArgs,
  findCommandInvocations,
  promptTemplateDescription,
  promptTemplateTakesArgs,
  substituteArgs,
  type PromptTemplate,
} from "./prompt-template";

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { name: "review", description: "Review a file", content: "Review $1.", ...overrides };
}

describe("parseCommandArgs", () => {
  it("splits on runs of whitespace and drops the empties between them", () => {
    expect(parseCommandArgs("a  b\tc")).toEqual(["a", "b", "c"]);
    expect(parseCommandArgs("")).toEqual([]);
    expect(parseCommandArgs("   ")).toEqual([]);
  });

  it("keeps a quoted run together and consumes the quotes", () => {
    expect(parseCommandArgs(`"two words" 'and more'`)).toEqual(["two words", "and more"]);
    expect(parseCommandArgs(`src/a.ts "the tricky one"`)).toEqual(["src/a.ts", "the tricky one"]);
  });

  it("treats the other quote character as ordinary text inside a quote", () => {
    expect(parseCommandArgs(`"it's here"`)).toEqual(["it's here"]);
  });

  it("closes an unterminated quote at end of input rather than dropping it", () => {
    expect(parseCommandArgs(`"never closed`)).toEqual(["never closed"]);
  });
});

describe("substituteArgs", () => {
  it("fills positional placeholders and blanks the ones with no argument", () => {
    expect(substituteArgs("$1 then $2", ["first"])).toBe("first then ");
    expect(substituteArgs("$1", [])).toBe("");
  });

  it("expands $@ and $ARGUMENTS to every argument, space-joined", () => {
    expect(substituteArgs("$ARGUMENTS", ["a", "b"])).toBe("a b");
    expect(substituteArgs("$@", ["a", "b"])).toBe("a b");
    expect(substituteArgs("$@", [])).toBe("");
  });

  it("slices with ${@:N} and ${@:N:L}, counting from one", () => {
    const args = ["a", "b", "c", "d"];
    expect(substituteArgs("${@:2}", args)).toBe("b c d");
    expect(substituteArgs("${@:2:2}", args)).toBe("b c");
  });

  it("clamps a zero start to the first argument", () => {
    expect(substituteArgs("${@:0}", ["a", "b"])).toBe("a b");
  });

  it("leaves text with no placeholders untouched", () => {
    expect(substituteArgs("plain prose", ["a"])).toBe("plain prose");
  });
});

describe("formatPromptTemplateInvocation", () => {
  it("substitutes into the template body", () => {
    expect(formatPromptTemplateInvocation(template(), ["src/app.ts"])).toBe("Review src/app.ts.");
  });

  it("defaults to no arguments", () => {
    expect(formatPromptTemplateInvocation(template({ content: "Ship it." }))).toBe("Ship it.");
  });
});

describe("promptTemplateTakesArgs", () => {
  it.each([
    ["Review $1.", true],
    ["Review $ARGUMENTS.", true],
    ["Review $@.", true],
    ["Review ${@:2}.", true],
    ["Review ${@:2:3}.", true],
    ["Summarise the diff.", false],
    ["Costs $5 and change.", true],
    ["An $ alone.", false],
  ])("reads %s as %s", (content, expected) => {
    expect(promptTemplateTakesArgs(template({ content }))).toBe(expected);
  });
});

describe("promptTemplateDescription", () => {
  it("prefers a declared frontmatter description", () => {
    expect(
      promptTemplateDescription({ body: "Body line", frontmatterDescription: "Declared" }),
    ).toBe("Declared");
  });

  it("falls back to the first non-blank body line", () => {
    expect(
      promptTemplateDescription({
        body: "\n  \nFirst real line\nsecond",
        frontmatterDescription: "",
      }),
    ).toBe("First real line");
  });

  it("elides a first line past sixty characters", () => {
    const long = "x".repeat(75);
    expect(promptTemplateDescription({ body: long, frontmatterDescription: undefined })).toBe(
      `${"x".repeat(60)}...`,
    );
  });

  it("keeps a first line of exactly sixty characters whole", () => {
    const exact = "y".repeat(60);
    expect(promptTemplateDescription({ body: exact, frontmatterDescription: null })).toBe(exact);
  });

  it("is empty when neither source can supply one", () => {
    expect(promptTemplateDescription({ body: "   \n\n", frontmatterDescription: 42 })).toBe("");
  });
});

describe("mergePromptTemplates", () => {
  it("lets the project's name replace the global one outright", () => {
    const merged = mergePromptTemplates({
      project: [template({ name: "review", content: "project body" })],
      global: [template({ name: "review", content: "global body" })],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("project body");
  });

  it("keeps both tiers when the names differ, sorted by name", () => {
    const merged = mergePromptTemplates({
      project: [template({ name: "zeta" })],
      global: [template({ name: "alpha" }), template({ name: "middle" })],
    });

    expect(merged.map((entry) => entry.name)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("is an empty list when neither tier has anything", () => {
    expect(mergePromptTemplates({ project: [], global: [] })).toEqual([]);
  });
});

describe("findCommandInvocations", () => {
  it("splits a leading slash-name from its argument string", () => {
    expect(findCommandInvocations("/review src/app.ts")).toEqual([
      { name: "review", argsString: "src/app.ts", start: 0, end: 18 },
    ]);
  });

  it("reads a bare name with no arguments", () => {
    expect(findCommandInvocations("/ship")).toEqual([
      { name: "ship", argsString: "", start: 0, end: 5 },
    ]);
  });

  it("finds an invocation mid-text when the slash sits at a word boundary", () => {
    expect(findCommandInvocations("please /review src/app.ts")).toEqual([
      { name: "review", argsString: "src/app.ts", start: 7, end: 25 },
    ]);
  });

  it("accepts the name characters a file basename can carry", () => {
    expect(findCommandInvocations("/pr:review-2 x")[0]?.name).toBe("pr:review-2");
  });

  it("finds nothing in text that glues its slashes inside words", () => {
    expect(findCommandInvocations("and/or")).toEqual([]);
    expect(findCommandInvocations("look at src/app.ts")).toEqual([]);
    expect(findCommandInvocations("plain prose")).toEqual([]);
  });

  it("finds nothing after a bare slash with no name", () => {
    expect(findCommandInvocations("/")).toEqual([]);
    expect(findCommandInvocations("/ spaced")).toEqual([]);
  });

  it("finds nothing when the name runs straight into a character it cannot contain", () => {
    expect(findCommandInvocations("/review.md")).toEqual([]);
  });

  it("scopes an invocation's arguments to its own line", () => {
    expect(findCommandInvocations("/review src/app.ts\nmore prose")).toEqual([
      { name: "review", argsString: "src/app.ts", start: 0, end: 18 },
    ]);
  });

  it("finds an invocation on each line that starts one", () => {
    expect(findCommandInvocations("/ship\nprose\n/review a.ts").map((i) => i.name)).toEqual([
      "ship",
      "review",
    ]);
  });
});

describe("expandCommandInvocation", () => {
  const templates = [
    template({ name: "review", content: "Review $1 for $2." }),
    template({ name: "ship", content: "Ship it." }),
  ];

  it("expands a known command with its arguments", () => {
    expect(expandCommandInvocation("/review src/app.ts bugs", templates)).toBe(
      "Review src/app.ts for bugs.",
    );
  });

  it("expands a known command that takes nothing", () => {
    expect(expandCommandInvocation("/ship", templates)).toBe("Ship it.");
  });

  it("honours quoting when splitting the arguments", () => {
    expect(expandCommandInvocation(`/review "the file" style`, templates)).toBe(
      "Review the file for style.",
    );
  });

  it("passes an unknown command through rather than losing the message", () => {
    expect(expandCommandInvocation("/unknown thing", templates)).toBe("/unknown thing");
  });

  it("passes ordinary prose through untouched", () => {
    expect(expandCommandInvocation("just a message", templates)).toBe("just a message");
  });

  it("expands a command mid-sentence, in place, keeping the prose before it", () => {
    expect(expandCommandInvocation("please /review src/app.ts bugs", templates)).toBe(
      "please Review src/app.ts for bugs.",
    );
  });

  it("never mistakes a slash inside a word for a command", () => {
    expect(expandCommandInvocation("look at src/review", templates)).toBe("look at src/review");
  });

  it("stops a command's arguments at its own line", () => {
    expect(expandCommandInvocation("/ship\nAlso check tests", templates)).toBe(
      "Ship it.\nAlso check tests",
    );
  });

  it("expands one command per line, each on its own line", () => {
    expect(expandCommandInvocation("/ship\n/review a.ts bugs", templates)).toBe(
      "Ship it.\nReview a.ts for bugs.",
    );
  });

  it("lets a known command consume the rest of its line — a second slash there is an argument", () => {
    expect(expandCommandInvocation("/review a.ts bugs /ship", templates)).toBe(
      "Review a.ts for bugs.",
    );
  });

  it("lets a known command follow an unknown one on the same line", () => {
    expect(expandCommandInvocation("/nope /ship", templates)).toBe("/nope Ship it.");
  });

  describe("with skills", () => {
    const skills = [
      {
        name: "logos",
        description: "Design logos",
        body: "# Logos\n\nRun `awk '{print $1}'` first.",
        userInvokeOnly: false,
        root: ".agents/skills/logos",
      },
      {
        name: "ship",
        description: "Shadowed by the template",
        body: "never delivered",
        userInvokeOnly: false,
        root: ".agents/skills/ship",
      },
    ];
    const block = [
      "--- BEGIN RESOURCE: logos ---",
      "Skill directory: .agents/skills/logos/ — file references in this skill resolve relative to it.",
      "",
      "# Logos\n\nRun `awk '{print $1}'` first.",
      "--- END RESOURCE: logos ---",
    ].join("\n");

    it("expands a skill reference into its delimited RESOURCE block", () => {
      expect(expandCommandInvocation("/logos", templates, skills)).toBe(block);
    });

    it("keeps the invocation line's own words after the block", () => {
      expect(expandCommandInvocation("/logos make a wordmark", templates, skills)).toBe(
        `${block}\n\nmake a wordmark`,
      );
    });

    it("leaves the skill body's placeholders alone — no argument substitution", () => {
      expect(expandCommandInvocation("/logos arg", templates, skills)).toContain(
        "awk '{print $1}'",
      );
    });

    it("lets a template win a name a skill also claims", () => {
      expect(expandCommandInvocation("/ship", templates, skills)).toBe("Ship it.");
    });

    it("consumes the skill's whole line, like any known command", () => {
      expect(expandCommandInvocation("/logos then /ship", templates, skills)).toBe(
        `${block}\n\nthen /ship`,
      );
    });

    it("expands mid-draft, keeping prose before it and later lines after it", () => {
      expect(expandCommandInvocation("please /logos\nthanks", templates, skills)).toBe(
        `please ${block}\nthanks`,
      );
    });
  });
});

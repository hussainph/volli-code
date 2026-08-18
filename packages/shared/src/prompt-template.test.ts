import { describe, expect, it } from "vite-plus/test";

import { skillPromptResource } from "./skill";
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
    expect(expandCommandInvocation("/review src/app.ts bugs", templates)).toEqual({
      text: "Review src/app.ts for bugs.",
      resources: [],
    });
  });

  it("expands a known command that takes nothing", () => {
    expect(expandCommandInvocation("/ship", templates).text).toBe("Ship it.");
  });

  it("honours quoting when splitting the arguments", () => {
    expect(expandCommandInvocation(`/review "the file" style`, templates).text).toBe(
      "Review the file for style.",
    );
  });

  it("passes an unknown command through rather than losing the message", () => {
    expect(expandCommandInvocation("/unknown thing", templates)).toEqual({
      text: "/unknown thing",
      resources: [],
    });
  });

  it("never expands a built-in verb's name, whoever claims it", () => {
    const own = template({ name: "compact", content: "Please summarize this chat." });
    const installed = {
      name: "compact",
      description: "Shadowed by the verb",
      body: "never delivered",
      userInvokeOnly: false,
      root: ".agents/skills/compact",
    };

    // The one that matters: a `commands/compact.md` on disk must not turn the
    // verb into a message. Nothing is expanded, nothing rides beside it, and
    // the text reaches the press exactly as typed, where `composerPress`
    // claims it and runs the compaction instead.
    expect(expandCommandInvocation("/compact keep the API work", [own], [installed])).toEqual({
      text: "/compact keep the API work",
      resources: [],
    });
  });

  it("passes ordinary prose through untouched", () => {
    expect(expandCommandInvocation("just a message", templates).text).toBe("just a message");
  });

  it("expands a command mid-sentence, in place, keeping the prose before it", () => {
    expect(expandCommandInvocation("please /review src/app.ts bugs", templates).text).toBe(
      "please Review src/app.ts for bugs.",
    );
  });

  it("never mistakes a slash inside a word for a command", () => {
    expect(expandCommandInvocation("look at src/review", templates).text).toBe(
      "look at src/review",
    );
  });

  it("stops a command's arguments at its own line", () => {
    expect(expandCommandInvocation("/ship\nAlso check tests", templates).text).toBe(
      "Ship it.\nAlso check tests",
    );
  });

  it("expands one command per line, each on its own line", () => {
    expect(expandCommandInvocation("/ship\n/review a.ts bugs", templates).text).toBe(
      "Ship it.\nReview a.ts for bugs.",
    );
  });

  it("lets a known command consume the rest of its line — a second slash there is an argument", () => {
    expect(expandCommandInvocation("/review a.ts bugs /ship", templates).text).toBe(
      "Review a.ts for bugs.",
    );
  });

  it("lets a known command follow an unknown one on the same line", () => {
    expect(expandCommandInvocation("/nope /ship", templates).text).toBe("/nope Ship it.");
  });

  describe("with skills", () => {
    const logos = {
      name: "logos",
      description: "Design logos",
      body: "# Logos\n\nRun `awk '{print $1}'` first.",
      userInvokeOnly: false,
      root: ".agents/skills/logos",
    };
    const skills = [
      logos,
      {
        name: "ship",
        description: "Shadowed by the template",
        body: "never delivered",
        userInvokeOnly: false,
        root: ".agents/skills/ship",
      },
    ];
    const logosResource = skillPromptResource(logos);

    it("keeps a bare skill reference in the text and resolves its body beside it", () => {
      expect(expandCommandInvocation("/logos", templates, skills)).toEqual({
        text: "/logos",
        resources: [logosResource],
      });
    });

    it("keeps the invocation and its arguments exactly as typed", () => {
      expect(expandCommandInvocation("/logos make a wordmark", templates, skills)).toEqual({
        text: "/logos make a wordmark",
        resources: [logosResource],
      });
    });

    // VC-49's repro: a skill named mid-sentence must not garble the sentence.
    it("leaves a mid-sentence reference intact — the resource travels beside, never spliced in", () => {
      const expanded = expandCommandInvocation(
        "can you tell me what /logos does?",
        templates,
        skills,
      );
      expect(expanded.text).toBe("can you tell me what /logos does?");
      expect(expanded.text).not.toContain("BEGIN RESOURCE");
      expect(expanded.resources).toEqual([logosResource]);
    });

    it("resolves one resource however often the message names the skill", () => {
      const expanded = expandCommandInvocation("/logos a\n/logos b", templates, skills);
      expect(expanded.text).toBe("/logos a\n/logos b");
      expect(expanded.resources).toEqual([logosResource]);
    });

    it("delivers the body verbatim in the resource — no argument substitution", () => {
      const [resource] = expandCommandInvocation("/logos arg", templates, skills).resources;
      expect(resource?.text).toContain("awk '{print $1}'");
    });

    it("lets a template win a name a skill also claims", () => {
      expect(expandCommandInvocation("/ship", templates, skills)).toEqual({
        text: "Ship it.",
        resources: [],
      });
    });

    it("still consumes the skill's whole line — a template named there stays an argument", () => {
      expect(expandCommandInvocation("/logos then /ship", templates, skills)).toEqual({
        text: "/logos then /ship",
        resources: [logosResource],
      });
    });

    it("expands templates around an intact skill reference in the same draft", () => {
      expect(expandCommandInvocation("/ship\n/logos x\nthanks", templates, skills)).toEqual({
        text: "Ship it.\n/logos x\nthanks",
        resources: [logosResource],
      });
    });
  });
});

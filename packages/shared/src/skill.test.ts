import { describe, expect, it } from "vite-plus/test";

import { promptResourceBlock } from "./prompt-resource";
import type { PromptTemplate } from "./prompt-template";
import {
  isSkillName,
  projectSkillsDir,
  skillInvocationText,
  skillPromptResource,
  visibleSkills,
  type SkillReference,
} from "./skill";

function skill(overrides: Partial<SkillReference> = {}): SkillReference {
  return {
    name: "svg-logo-designer",
    description: "Create professional SVG logos",
    body: "# SVG Logo Designer\n\nUse `awk '{print $1}'` when needed.",
    ...overrides,
  };
}

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { name: "review", description: "Review a file", content: "Review $1.", ...overrides };
}

describe("projectSkillsDir", () => {
  it("joins the project path to .agents/skills", () => {
    expect(projectSkillsDir("/repo")).toBe("/repo/.agents/skills");
  });

  it("tolerates a single trailing slash", () => {
    expect(projectSkillsDir("/repo/")).toBe("/repo/.agents/skills");
  });
});

describe("isSkillName", () => {
  it("accepts the /name character class", () => {
    expect(isSkillName("svg-logo-designer")).toBe(true);
    expect(isSkillName("a_b:c-9")).toBe(true);
  });

  it("rejects a slug the / grammar cannot spell", () => {
    expect(isSkillName("My Skill")).toBe(false);
    expect(isSkillName("dot.name")).toBe(false);
    expect(isSkillName("")).toBe(false);
  });
});

describe("visibleSkills", () => {
  it("drops a skill whose name a template already takes", () => {
    const shadowed = skill({ name: "review" });
    const offered = skill({ name: "logos" });
    expect(visibleSkills([shadowed, offered], [template()])).toEqual([offered]);
  });

  it("sorts by name so the list does not reorder itself", () => {
    const b = skill({ name: "beta" });
    const a = skill({ name: "alpha" });
    expect(visibleSkills([b, a], [])).toEqual([a, b]);
  });
});

describe("skillPromptResource", () => {
  it("names the resource by the slug and carries the body as text", () => {
    const reference = skill();
    expect(skillPromptResource(reference)).toEqual({
      name: "svg-logo-designer",
      text: reference.body,
    });
  });
});

describe("skillInvocationText", () => {
  it("is the delimited block alone when the invocation carried no words", () => {
    const reference = skill();
    expect(skillInvocationText(reference, "")).toBe(
      promptResourceBlock({ name: reference.name, text: reference.body }),
    );
  });

  it("keeps the line's remaining words after the block instead of swallowing them", () => {
    const reference = skill();
    expect(skillInvocationText(reference, "make me a wordmark")).toBe(
      `${promptResourceBlock({ name: reference.name, text: reference.body })}\n\nmake me a wordmark`,
    );
  });

  it("never substitutes placeholders inside the body", () => {
    const reference = skill({ body: "run `awk '{print $1}'` on $@" });
    expect(skillInvocationText(reference, "arg")).toContain("awk '{print $1}'` on $@");
  });
});

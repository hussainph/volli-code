import { describe, expect, it } from "vite-plus/test";

import { promptResourceBlock } from "./prompt-resource";
import type { PromptTemplate } from "./prompt-template";
import {
  isSkillName,
  projectSkillsDir,
  skillInvocationText,
  skillPromptResource,
  skillRootDir,
  skillsIndexResource,
  SKILLS_INDEX_RESOURCE_NAME,
  visibleSkills,
  type SkillReference,
} from "./skill";

/** The one-line header `skillPromptResource` puts above a delivered body. */
function rootHeader(name: string): string {
  return `Skill directory: .agents/skills/${name}/ — file references in this skill resolve relative to it.`;
}

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

describe("skillRootDir", () => {
  it("is the workspace-relative skills path for the slug", () => {
    expect(skillRootDir("pdf-processing")).toBe(".agents/skills/pdf-processing");
  });
});

describe("skillPromptResource", () => {
  it("names the resource by the slug and delivers the body under its directory header", () => {
    const reference = skill();
    expect(skillPromptResource(reference)).toEqual({
      name: "svg-logo-designer",
      text: `${rootHeader("svg-logo-designer")}\n\n${reference.body}`,
    });
  });
});

describe("skillInvocationText", () => {
  it("is the delimited block alone when the invocation carried no words", () => {
    const reference = skill();
    expect(skillInvocationText(reference, "")).toBe(
      promptResourceBlock(skillPromptResource(reference)),
    );
  });

  it("keeps the line's remaining words after the block instead of swallowing them", () => {
    const reference = skill();
    expect(skillInvocationText(reference, "make me a wordmark")).toBe(
      `${promptResourceBlock(skillPromptResource(reference))}\n\nmake me a wordmark`,
    );
  });

  it("never substitutes placeholders inside the body", () => {
    const reference = skill({ body: "run `awk '{print $1}'` on $@" });
    expect(skillInvocationText(reference, "arg")).toContain("awk '{print $1}'` on $@");
  });
});

describe("skillsIndexResource", () => {
  it("lists every skill handed in, name-sorted, as name + path + description", () => {
    // Whether to disclose at all is the caller's per-project gate; this
    // function never filters on anything inside a skill.
    const second = skill({ name: "beta", description: "Do beta things" });
    const first = skill({ name: "alpha", description: "Do alpha things" });

    const resource = skillsIndexResource([second, first]);

    expect(resource?.name).toBe(SKILLS_INDEX_RESOURCE_NAME);
    expect(resource?.text).toContain(
      "- alpha (.agents/skills/alpha/SKILL.md): Do alpha things\n" +
        "- beta (.agents/skills/beta/SKILL.md): Do beta things",
    );
  });

  it("is null for no skills at all, so the prompt composes exactly as before", () => {
    expect(skillsIndexResource([])).toBeNull();
  });

  it("tells the model how to activate a skill and where its files resolve", () => {
    const resource = skillsIndexResource([skill()]);
    expect(resource?.text).toContain("read its SKILL.md and follow it");
    expect(resource?.text).toContain("resolve relative to\nits directory");
    expect(resource?.text).toContain("not authority");
  });

  it("skips a skill whose full body this Session already carries", () => {
    const injected = skill({ name: "carried" });
    const listed = skill({ name: "offered" });
    const resource = skillsIndexResource([injected, listed], ["carried"]);
    expect(resource?.text).toContain("offered");
    expect(resource?.text).not.toContain("carried");
  });

  it("is null when every skill was already injected", () => {
    expect(skillsIndexResource([skill()], [skill().name])).toBeNull();
  });

  it("clamps a bloated description to the spec's 1024-character ceiling, one line", () => {
    const resource = skillsIndexResource([
      skill({ description: `multi\nline ${"x".repeat(2000)}` }),
    ]);
    const entry = resource?.text.split("\n").at(-1) ?? "";
    expect(entry).toContain("multi line x");
    expect(entry.length).toBeLessThan(1200);
    expect(entry.endsWith("...")).toBe(true);
  });

  it("drops the trailing colon for a skill with no description at all", () => {
    const resource = skillsIndexResource([skill({ description: "" })]);
    expect(resource?.text).toContain(
      "- svg-logo-designer (.agents/skills/svg-logo-designer/SKILL.md)",
    );
    expect(resource?.text).not.toContain("SKILL.md):");
  });
});

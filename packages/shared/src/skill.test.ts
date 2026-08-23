import { describe, expect, it } from "vite-plus/test";

import type { PromptTemplate } from "./prompt-template";
import {
  applySkillModes,
  globalSkillsDir,
  isSkillName,
  isUserInvokeOnly,
  SKILL_RESOURCE_PART_TYPE,
  SKILL_USER_INVOKE_ONLY_KEY,
  mergeSkills,
  projectSkillsDir,
  readSkillResources,
  skillPromptResource,
  skillResourcePart,
  skillRootDir,
  parseSkillModes,
  resolveSkillMode,
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
  // Root follows the name by default, the way the project-tier reader spells
  // it, so a test that renames a skill does not have to restate its directory.
  const name = overrides.name ?? "svg-logo-designer";
  return {
    name,
    description: "Create professional SVG logos",
    body: "# SVG Logo Designer\n\nUse `awk '{print $1}'` when needed.",
    userInvokeOnly: false,
    root: `.agents/skills/${name}`,
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

describe("globalSkillsDir", () => {
  it("is the convention's personal tier under the home directory", () => {
    expect(globalSkillsDir("/Users/me")).toBe("/Users/me/.agents/skills");
  });

  it("tolerates a single trailing slash", () => {
    expect(globalSkillsDir("/Users/me/")).toBe("/Users/me/.agents/skills");
  });
});

describe("mergeSkills", () => {
  it("lets a project skill replace the personal skill of the same slug", () => {
    const project = skill({ name: "shared", description: "vendored" });
    const global = skill({
      name: "shared",
      description: "personal",
      root: "/home/.agents/skills/shared",
    });

    expect(mergeSkills({ project: [project], global: [global] })).toEqual([project]);
  });

  it("keeps both tiers when their slugs differ, name-sorted", () => {
    const project = skill({ name: "vendored" });
    const global = skill({ name: "personal", root: "/home/.agents/skills/personal" });

    expect(mergeSkills({ project: [project], global: [global] })).toEqual([global, project]);
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

  it("drops a skill whose name a built-in verb has taken", () => {
    // Reserved above both lists: `expandCommandInvocation` refuses the name
    // too, so this row could never have been invoked as a skill.
    const shadowed = skill({ name: "compact" });
    const offered = skill({ name: "logos" });
    expect(visibleSkills([shadowed, offered], [])).toEqual([offered]);
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

  it("hands a personal-tier skill its OWN absolute root, not a workspace path", () => {
    // Deriving the header from the slug would point `~/.agents/skills/pdf` at
    // a workspace directory that does not exist, dangling its bundled files.
    const reference = skill({ name: "pdf", root: "/Users/me/.agents/skills/pdf" });
    expect(skillPromptResource(reference).text).toContain(
      "Skill directory: /Users/me/.agents/skills/pdf/ —",
    );
  });
});

describe("skillResourcePart", () => {
  it("wraps a resolved resource as the message part that carries it", () => {
    const resource = skillPromptResource(skill());
    expect(skillResourcePart(resource)).toEqual({
      type: SKILL_RESOURCE_PART_TYPE,
      data: { name: resource.name, text: resource.text },
    });
  });

  it("keeps the body's placeholders verbatim — no argument substitution, ever", () => {
    const resource = skillPromptResource(skill({ body: "run `awk '{print $1}'` on $@" }));
    expect(skillResourcePart(resource).data.text).toContain("awk '{print $1}'` on $@");
  });
});

describe("readSkillResources", () => {
  it("round-trips what skillResourcePart wrote, in part order", () => {
    const first = skillPromptResource(skill({ name: "alpha" }));
    const second = skillPromptResource(skill({ name: "beta" }));
    const parts = [
      { type: "text", text: "can you tell me what /alpha does?" },
      skillResourcePart(first),
      skillResourcePart(second),
    ];
    expect(readSkillResources(parts)).toEqual([first, second]);
  });

  it("ignores every part that is not a skill resource", () => {
    expect(
      readSkillResources([
        { type: "text", text: "prose" },
        { type: "data-interaction-resolution", data: { optionIds: [] } },
      ]),
    ).toEqual([]);
  });

  it("drops a malformed part rather than delivering a half-read block", () => {
    expect(
      readSkillResources([
        null,
        "not a part",
        { type: SKILL_RESOURCE_PART_TYPE },
        { type: SKILL_RESOURCE_PART_TYPE, data: null },
        { type: SKILL_RESOURCE_PART_TYPE, data: { name: "no-text" } },
        { type: SKILL_RESOURCE_PART_TYPE, data: { name: 7, text: "typed wrong" } },
      ]),
    ).toEqual([]);
  });
});

describe("skillsIndexResource", () => {
  it("lists every skill handed in, name-sorted, as name + path + description", () => {
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

  it("leaves out a skill that asked to be user-invoked only, and nothing else", () => {
    const quiet = skill({ name: "quiet", userInvokeOnly: true });
    const loud = skill({ name: "loud", description: "Advertised" });

    const resource = skillsIndexResource([quiet, loud]);

    expect(resource?.text).toContain("- loud (");
    expect(resource?.text).not.toContain("quiet");
  });

  it("is null when every skill opted out, so the prompt composes as if none existed", () => {
    expect(skillsIndexResource([skill({ userInvokeOnly: true })])).toBeNull();
  });

  it("points a personal-tier entry at its absolute SKILL.md", () => {
    const personal = skill({
      name: "pdf",
      description: "Fill PDFs",
      root: "/home/.agents/skills/pdf",
    });
    expect(skillsIndexResource([personal])?.text).toContain(
      "- pdf (/home/.agents/skills/pdf/SKILL.md): Fill PDFs",
    );
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

describe("isUserInvokeOnly", () => {
  it("reads the namespaced key out of the spec's metadata map", () => {
    expect(isUserInvokeOnly({ [SKILL_USER_INVOKE_ONLY_KEY]: "true" })).toBe(true);
    expect(isUserInvokeOnly({ [SKILL_USER_INVOKE_ONLY_KEY]: "TRUE " })).toBe(true);
    expect(isUserInvokeOnly({ [SKILL_USER_INVOKE_ONLY_KEY]: true })).toBe(true);
  });

  it("leaves a skill advertised for anything else — the format's default wins", () => {
    expect(isUserInvokeOnly(undefined)).toBe(false);
    expect(isUserInvokeOnly(null)).toBe(false);
    expect(isUserInvokeOnly("not a map")).toBe(false);
    expect(isUserInvokeOnly({})).toBe(false);
    expect(isUserInvokeOnly({ author: "someone" })).toBe(false);
    expect(isUserInvokeOnly({ [SKILL_USER_INVOKE_ONLY_KEY]: "false" })).toBe(false);
    expect(isUserInvokeOnly({ [SKILL_USER_INVOKE_ONLY_KEY]: false })).toBe(false);
    expect(isUserInvokeOnly({ [SKILL_USER_INVOKE_ONLY_KEY]: { nested: "map" } })).toBe(false);
  });
});

describe("applySkillModes", () => {
  const tdd = skill({ name: "tdd" });
  const diagnose = skill({ name: "diagnose" });
  const quiet = skill({ name: "quiet", userInvokeOnly: true });

  it("leaves an unruled project exactly as it loaded", () => {
    expect(applySkillModes([tdd, diagnose], {})).toEqual([tdd, diagnose]);
  });

  it("removes an off skill entirely", () => {
    expect(applySkillModes([tdd, diagnose], { diagnose: "off" })).toEqual([tdd]);
  });

  it("keeps a manual skill invokable but withholds it from the model's index", () => {
    // This is the whole point of the middle state: the index is ~94% of a
    // fresh Session's Volli-composed context, and an entry costs that budget
    // on every single turn. `manual` buys the budget back without losing the
    // skill — `/tdd` still resolves it.
    const [ruled] = applySkillModes([tdd], { tdd: "manual" });

    expect(ruled?.userInvokeOnly).toBe(true);
    expect(skillsIndexResource(applySkillModes([tdd], { tdd: "manual" }))).toBeNull();
    expect(applySkillModes([tdd], { tdd: "manual" })).toHaveLength(1);
  });

  it("does not clone a skill that is already manual", () => {
    // `toBe`, not `toEqual`: the point is that a rule matching what the
    // frontmatter already says hands back the SAME object, so a no-op rule
    // costs nothing. A deep-equality check would pass even if it cloned.
    expect(applySkillModes([quiet], { quiet: "manual" })[0]).toBe(quiet);
  });

  it("cannot currently promote a frontmatter-quiet skill, because storage drops an auto rule", () => {
    // The shipped limitation, pinned so it is a decision rather than a
    // surprise: `parseSkillModes` drops `auto` to keep "never touched" and
    // "set to the default" one state, and it cannot tell that `auto` IS a
    // departure for this particular skill. Reachable only by widening the
    // stored vocabulary, which is a change to make deliberately.
    expect(applySkillModes([quiet], parseSkillModes({ quiet: "auto" }))).toEqual([quiet]);
  });

  it("honours the author's opt-out when the project has said nothing", () => {
    expect(applySkillModes([quiet], {})).toEqual([quiet]);
    expect(skillsIndexResource(applySkillModes([quiet], {}))).toBeNull();
  });

  it("keeps the existing reference when a manual rule already agrees", () => {
    expect(applySkillModes([quiet], { quiet: "manual" })[0]).toBe(quiet);
  });

  it("ignores a rule naming a skill that is no longer installed", () => {
    expect(applySkillModes([tdd], { "uninstalled-last-week": "off" })).toEqual([tdd]);
  });
});

describe("resolveSkillMode", () => {
  it("reads auto for a skill nobody has ruled on", () => {
    expect(resolveSkillMode({}, skill({ name: "tdd" }))).toBe("auto");
  });

  it("reads manual for a skill whose own frontmatter opted out", () => {
    expect(resolveSkillMode({}, skill({ name: "quiet", userInvokeOnly: true }))).toBe("manual");
  });

  it("lets the project's rule outrank the frontmatter default", () => {
    const quiet = skill({ name: "quiet", userInvokeOnly: true });
    expect(resolveSkillMode({ quiet: "auto" }, quiet)).toBe("auto");
  });
});

describe("parseSkillModes", () => {
  it("keeps only the slugs and modes the vocabulary defines", () => {
    expect(parseSkillModes({ tdd: "off", bad: "sideways", "not a slug": "off" })).toEqual({
      tdd: "off",
    });
  });

  it("drops an auto rule, which is the same as no rule at all", () => {
    // Storing the default would make "never touched" and "explicitly set to
    // the default" two states that read identically everywhere above the db.
    expect(parseSkillModes({ tdd: "auto" })).toEqual({});
  });

  it("reads anything that is not an object as no rules", () => {
    expect(parseSkillModes(null)).toEqual({});
    expect(parseSkillModes(["tdd"])).toEqual({});
    expect(parseSkillModes("tdd")).toEqual({});
  });
});

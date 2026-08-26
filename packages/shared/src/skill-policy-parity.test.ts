/**
 * One skill, every consumer, one answer (VC-181).
 *
 * These cases walk the production seams: one effective policy is resolved,
 * then the model index, slash picker, explicit submit and human attach-time
 * selection each consume the axis that belongs to them.
 */
import { describe, expect, it } from "vite-plus/test";

import { expandCommandInvocation } from "./prompt-template";
import {
  applySkillModes,
  skillsIndexResource,
  SKILL_POLICY_DEFAULT,
  userInvokableSkills,
  type SkillInvocationPolicy,
  type SkillModes,
  type SkillReference,
} from "./skill";
import { resolveSlashNamespace, slashTargets } from "./slash-namespace";

function skill(name: string, authorPolicy: SkillInvocationPolicy = SKILL_POLICY_DEFAULT) {
  return {
    name,
    description: `What ${name} does`,
    body: `# ${name}\n\nbody-of-${name}`,
    authorPolicy,
    effectivePolicy: authorPolicy,
    policyDiagnostic: null,
    root: `.agents/skills/${name}`,
  } satisfies SkillReference;
}

/** What each consumer says about one skill, under one project's rules. */
function consumers(skills: readonly SkillReference[], modes: SkillModes, name: string) {
  const ruled = applySkillModes(skills, modes);
  const namespace = resolveSlashNamespace({ templates: [], skills: ruled });
  const expanded = expandCommandInvocation(`/${name} please`, [], ruled);
  return {
    indexed: skillsIndexResource(ruled)?.text.includes(`- ${name} (`) ?? false,
    offered: namespace.entries.some((entry) => entry.bareName === name),
    resolvable: slashTargets(namespace).has(name),
    delivered: expanded.resources.some((resource) => resource.name === name),
    // Attach-time “Chat with skill” is a human invocation surface too.
    attachable: userInvokableSkills(ruled).some((candidate) => candidate.name === name),
  };
}

const MODEL_AND_USER = {
  indexed: true,
  offered: true,
  resolvable: true,
  delivered: true,
  attachable: true,
};
const USER_ONLY = {
  indexed: false,
  offered: true,
  resolvable: true,
  delivered: true,
  attachable: true,
};
const MODEL_ONLY = {
  indexed: true,
  offered: false,
  resolvable: false,
  delivered: false,
  attachable: false,
};
const NEITHER = {
  indexed: false,
  offered: false,
  resolvable: false,
  delivered: false,
  attachable: false,
};

describe("the Project mode matrix, across every consumer", () => {
  const skills = [skill("tdd")];

  it("Auto: model discoverable and user invokable", () => {
    expect(consumers(skills, {}, "tdd")).toEqual(MODEL_AND_USER);
    expect(consumers(skills, { tdd: "auto" }, "tdd")).toEqual(MODEL_AND_USER);
  });

  it("Manual: out of the catalogue, still available to both human routes", () => {
    expect(consumers(skills, { tdd: "manual" }, "tdd")).toEqual(USER_ONLY);
  });

  it("Off: neither route resolves it", () => {
    expect(consumers(skills, { tdd: "off" }, "tdd")).toEqual(NEITHER);
  });
});

describe("the author's declaration, with no Project override", () => {
  it("honours disable-model-invocation: true as Manual", () => {
    const skills = [skill("wait-what", { modelDiscoverable: false, userInvokable: true })];
    expect(consumers(skills, {}, "wait-what")).toEqual(USER_ONLY);
  });

  it("keeps user-invocable: false as author-only background knowledge", () => {
    const skills = [skill("house-style", { modelDiscoverable: true, userInvokable: false })];
    expect(consumers(skills, {}, "house-style")).toEqual(MODEL_ONLY);
  });

  it("honours both flags together as unavailable", () => {
    const skills = [skill("retired", { modelDiscoverable: false, userInvokable: false })];
    expect(consumers(skills, {}, "retired")).toEqual(NEITHER);
  });
});

describe("Project precedence against author defaults", () => {
  const manual = [skill("wait-what", { modelDiscoverable: false, userInvokable: true })];
  const background = [skill("house-style", { modelDiscoverable: true, userInvokable: false })];

  it("promotes an author-manual skill with Auto", () => {
    expect(consumers(manual, { "wait-what": "auto" }, "wait-what")).toEqual(MODEL_AND_USER);
  });

  it("demotes an author-default skill with Manual", () => {
    expect(consumers([skill("tdd")], { tdd: "manual" }, "tdd")).toEqual(USER_ONLY);
  });

  it("overrides author model-only with Auto's complete matrix", () => {
    expect(consumers(background, { "house-style": "auto" }, "house-style")).toEqual(MODEL_AND_USER);
  });

  it("overrides author model-only with Manual's complete matrix", () => {
    expect(consumers(background, { "house-style": "manual" }, "house-style")).toEqual(USER_ONLY);
  });

  it("removes it under Off, whatever its author said", () => {
    for (const supply of [manual, background]) {
      const name = supply[0]!.name;
      expect(consumers(supply, { [name]: "off" }, name)).toEqual(NEITHER);
    }
  });
});

describe("what an unoffered reference does to the message", () => {
  it("leaves `/name` as ordinary prose and delivers nothing", () => {
    for (const authorPolicy of [
      { modelDiscoverable: true, userInvokable: false },
      { modelDiscoverable: false, userInvokable: false },
    ]) {
      const ruled = applySkillModes([skill("quiet", authorPolicy)], {});
      const expanded = expandCommandInvocation("/quiet please", [], ruled);
      expect(expanded.text).toBe("/quiet please");
      expect(expanded.resources).toEqual([]);
    }
  });

  it("never lets an offered row degrade into unexplained slash prose", () => {
    const supply = [
      skill("tdd"),
      skill("wait-what", { modelDiscoverable: false, userInvokable: true }),
      skill("house-style", { modelDiscoverable: true, userInvokable: false }),
    ];
    const ruled = applySkillModes(supply, { tdd: "manual" });
    const offered = resolveSlashNamespace({ templates: [], skills: ruled }).entries;

    expect(offered.map((entry) => entry.name)).toEqual(["tdd", "wait-what"]);
    for (const entry of offered) {
      const expanded = expandCommandInvocation(`/${entry.name}`, [], ruled);
      expect(expanded.resources.map((resource) => resource.name)).toEqual([entry.name]);
      expect(expanded.resources[0]?.text).toContain(`body-of-${entry.bareName}`);
      expect(expanded.resources[0]?.text).toContain(
        `Skill directory: .agents/skills/${entry.bareName}/`,
      );
    }
  });
});

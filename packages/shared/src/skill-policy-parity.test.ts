/**
 * One skill, every consumer, one answer (VC-181).
 *
 * The unit suites beside this one each check a single seam. This file checks
 * the property the seams exist FOR: that the model catalogue, the `/` picker
 * and submit-time expansion never disagree about what a skill is currently
 * allowed to do. That is the failure this ticket was written about — a picker
 * offering `/wait-what` while submit resolved nothing, so the reference went
 * out as unexplained prose and the model asked what it meant.
 *
 * Every case walks the real production path: `applySkillModes` to get the
 * ruled supply, then `skillsIndexResource` (what the model is told),
 * `resolveSlashNamespace` (what the person is offered) and
 * `expandCommandInvocation` (what an explicit reference actually delivers).
 * Nothing is stubbed, so a change that teaches one consumer a new rule and
 * forgets another fails here rather than in a Session.
 */
import { describe, expect, it } from "vite-plus/test";

import { expandCommandInvocation } from "./prompt-template";
import {
  applySkillModes,
  skillsIndexResource,
  SKILL_POLICY_DEFAULT,
  type SkillInvocationPolicy,
  type SkillModes,
  type SkillReference,
} from "./skill";
import { resolveSlashNamespace, slashTargets } from "./slash-namespace";

function skill(name: string, invocation: SkillInvocationPolicy = SKILL_POLICY_DEFAULT) {
  return {
    name,
    description: `What ${name} does`,
    body: `# ${name}\n\nbody-of-${name}`,
    invocation,
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
    /** Is its metadata in the model's catalogue? */
    indexed: skillsIndexResource(ruled)?.text.includes(`- ${name} (`) ?? false,
    /** Does the `/` menu offer a row for it? */
    offered: namespace.entries.some((entry) => entry.bareName === name),
    /** Does an explicit reference resolve to a target? */
    resolvable: slashTargets(namespace).has(name),
    /** Does submitting `/name` actually deliver its body? */
    delivered: expanded.resources.some((resource) => resource.name === name),
    /** Is it in the supply attach-time selection and the picker both read? */
    supplied: ruled.some((candidate) => candidate.name === name),
  };
}

const MODEL_AND_USER = { indexed: true, offered: true, resolvable: true, delivered: true };
const USER_ONLY = { indexed: false, offered: true, resolvable: true, delivered: true };
const MODEL_ONLY = { indexed: true, offered: false, resolvable: false, delivered: false };
const NEITHER = { indexed: false, offered: false, resolvable: false, delivered: false };

describe("the Project mode matrix, across every consumer", () => {
  const skills = [skill("tdd")];

  it("Auto: model discoverable and user invokable", () => {
    expect(consumers(skills, {}, "tdd")).toEqual({ ...MODEL_AND_USER, supplied: true });
    expect(consumers(skills, { tdd: "auto" }, "tdd")).toEqual({
      ...MODEL_AND_USER,
      supplied: true,
    });
  });

  it("Manual: out of the catalogue, still typed by name", () => {
    expect(consumers(skills, { tdd: "manual" }, "tdd")).toEqual({ ...USER_ONLY, supplied: true });
  });

  it("Off: neither route resolves it, and it leaves the supply", () => {
    expect(consumers(skills, { tdd: "off" }, "tdd")).toEqual({ ...NEITHER, supplied: false });
  });
});

describe("the author's declaration, with no Project override at all", () => {
  it("honours disable-model-invocation: true as Manual", () => {
    // The headline acceptance case. Before VC-181 this skill was indexed
    // regardless, and only a separately-stored Project override made it behave
    // — which is exactly why the repo's own `google-developer-docs` skill was
    // being advertised against its own frontmatter.
    const skills = [skill("wait-what", { modelDiscoverable: false, userInvokable: true })];
    expect(consumers(skills, {}, "wait-what")).toEqual({ ...USER_ONLY, supplied: true });
  });

  it("honours user-invocable: false as catalogue-only background knowledge", () => {
    const skills = [skill("house-style", { modelDiscoverable: true, userInvokable: false })];
    expect(consumers(skills, {}, "house-style")).toEqual({ ...MODEL_ONLY, supplied: true });
  });

  it("honours both flags together as unavailable", () => {
    const skills = [skill("retired", { modelDiscoverable: false, userInvokable: false })];
    expect(consumers(skills, {}, "retired")).toEqual({ ...NEITHER, supplied: false });
  });
});

describe("a Project override against an author default", () => {
  const manual = [skill("wait-what", { modelDiscoverable: false, userInvokable: true })];
  const background = [skill("house-style", { modelDiscoverable: true, userInvokable: false })];

  it("promotes an author-manual skill into the catalogue, without snapping back", () => {
    expect(consumers(manual, { "wait-what": "auto" }, "wait-what")).toEqual({
      ...MODEL_AND_USER,
      supplied: true,
    });
  });

  it("demotes an author-default skill out of the catalogue", () => {
    expect(consumers([skill("tdd")], { tdd: "manual" }, "tdd")).toEqual({
      ...USER_ONLY,
      supplied: true,
    });
  });

  it("leaves user-invocable: false alone under Auto — the fourth combination is the author's", () => {
    expect(consumers(background, { "house-style": "auto" }, "house-style")).toEqual({
      ...MODEL_ONLY,
      supplied: true,
    });
  });

  it("makes a background-only skill unavailable under Manual, rather than half-offered", () => {
    expect(consumers(background, { "house-style": "manual" }, "house-style")).toEqual({
      ...NEITHER,
      supplied: false,
    });
  });

  it("removes it under Off, whatever its author said", () => {
    for (const supply of [manual, background]) {
      const name = supply[0]!.name;
      expect(consumers(supply, { [name]: "off" }, name)).toEqual({ ...NEITHER, supplied: false });
    }
  });
});

describe("what an unoffered reference does to the message", () => {
  it("leaves `/name` as ordinary prose and delivers nothing", () => {
    // The ticket's rule: a reference is allowed to stay text only when it was
    // never offered as a resolvable row. Both of these were never offered.
    for (const invocation of [
      { modelDiscoverable: true, userInvokable: false },
      { modelDiscoverable: false, userInvokable: false },
    ]) {
      const ruled = applySkillModes([skill("quiet", invocation)], {});
      const expanded = expandCommandInvocation("/quiet please", [], ruled);
      expect(expanded.text).toBe("/quiet please");
      expect(expanded.resources).toEqual([]);
    }
  });

  it("never lets an offered row degrade into unexplained slash prose", () => {
    // The converse, and the real regression guard: every row the picker offers
    // must deliver a body when it is typed. Asserted over the whole namespace
    // rather than one name, so a new source or filter cannot break it quietly.
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
      // And the body arrives under its skill root, so bundled relative files
      // still resolve on the far side of delivery.
      expect(expanded.resources[0]?.text).toContain(
        `Skill directory: .agents/skills/${entry.bareName}/`,
      );
    }
  });
});

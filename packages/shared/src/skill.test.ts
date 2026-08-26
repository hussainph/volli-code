import { describe, expect, it } from "vite-plus/test";

import {
  applySkillModes,
  authorSkillMode,
  globalSkillsDir,
  isSkillName,
  isSkillUnavailable,
  readAuthorInvocationPolicy,
  resolveSkillPolicy,
  sameSkillPolicy,
  skillModePolicy,
  SKILL_DISABLE_MODEL_INVOCATION_KEY,
  SKILL_POLICY_DEFAULT,
  SKILL_RESOURCE_PART_TYPE,
  SKILL_USER_INVOCABLE_KEY,
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
  type SkillInvocationPolicy,
  type SkillReference,
} from "./skill";

/** "Manual": out of the index, still typable — the common author declaration. */
const MANUAL: SkillInvocationPolicy = { modelDiscoverable: false, userInvokable: true };
/** The fourth combination: background knowledge with no `/` row. */
const BACKGROUND: SkillInvocationPolicy = { modelDiscoverable: true, userInvokable: false };
/** Both axes closed — what `off` means, and what an author can declare too. */
const CLOSED: SkillInvocationPolicy = { modelDiscoverable: false, userInvokable: false };

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
    invocation: SKILL_POLICY_DEFAULT,
    policyDiagnostic: null,
    root: `.agents/skills/${name}`,
    ...overrides,
  };
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

  it("leaves out a skill that is not model-discoverable, and nothing else", () => {
    const quiet = skill({ name: "quiet", invocation: MANUAL });
    const loud = skill({ name: "loud", description: "Advertised" });

    const resource = skillsIndexResource([quiet, loud]);

    expect(resource?.text).toContain("- loud (");
    expect(resource?.text).not.toContain("quiet");
  });

  it("is null when every skill opted out, so the prompt composes as if none existed", () => {
    expect(skillsIndexResource([skill({ invocation: MANUAL })])).toBeNull();
  });

  it("still advertises a skill that is only withheld from the PICKER", () => {
    // The fourth combination. `user-invocable: false` is background knowledge:
    // the model must still be able to find it, which is the whole difference
    // between the two axes.
    const background = skill({ name: "house-style", invocation: BACKGROUND });
    expect(skillsIndexResource([background])?.text).toContain("- house-style (");
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

describe("readAuthorInvocationPolicy", () => {
  it("defaults to the format's own default when a file declares nothing", () => {
    expect(readAuthorInvocationPolicy({})).toEqual({
      policy: SKILL_POLICY_DEFAULT,
      diagnostic: null,
    });
  });

  it("reads the portable disable-model-invocation flag, boolean or string", () => {
    for (const raw of [true, "true", "TRUE ", " True"]) {
      expect(readAuthorInvocationPolicy({ disableModelInvocation: raw }).policy).toEqual(MANUAL);
    }
    for (const raw of [false, "false", "FALSE"]) {
      expect(readAuthorInvocationPolicy({ disableModelInvocation: raw }).policy).toEqual(
        SKILL_POLICY_DEFAULT,
      );
    }
  });

  it("reads user-invocable as the independent second axis", () => {
    expect(readAuthorInvocationPolicy({ userInvocable: false }).policy).toEqual(BACKGROUND);
    expect(
      readAuthorInvocationPolicy({ userInvocable: false, disableModelInvocation: true }).policy,
    ).toEqual(CLOSED);
    expect(readAuthorInvocationPolicy({ userInvocable: true }).policy).toEqual(
      SKILL_POLICY_DEFAULT,
    );
  });

  it("reads the legacy metadata alias when the portable field is absent", () => {
    expect(
      readAuthorInvocationPolicy({ metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: "true" } }).policy,
    ).toEqual(MANUAL);
    expect(
      readAuthorInvocationPolicy({ metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: true } }).policy,
    ).toEqual(MANUAL);
    expect(readAuthorInvocationPolicy({ metadata: { author: "someone" } }).policy).toEqual(
      SKILL_POLICY_DEFAULT,
    );
    expect(readAuthorInvocationPolicy({ metadata: "not a map" }).policy).toEqual(
      SKILL_POLICY_DEFAULT,
    );
  });

  it("lets the portable field outrank the legacy alias, and says which won", () => {
    // Deterministic in BOTH directions, because a conflict is a conflict
    // whichever way round it is written.
    const withheld = readAuthorInvocationPolicy({
      disableModelInvocation: true,
      metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: false },
    });
    expect(withheld.policy).toEqual(MANUAL);
    expect(withheld.diagnostic).toContain(`${SKILL_DISABLE_MODEL_INVOCATION_KEY} wins`);

    const advertised = readAuthorInvocationPolicy({
      disableModelInvocation: false,
      metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: true },
    });
    expect(advertised.policy).toEqual(SKILL_POLICY_DEFAULT);
    expect(advertised.diagnostic).toContain(`${SKILL_DISABLE_MODEL_INVOCATION_KEY} wins`);
  });

  it("says nothing when the two spellings agree", () => {
    expect(
      readAuthorInvocationPolicy({
        disableModelInvocation: true,
        metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: true },
      }),
    ).toEqual({ policy: MANUAL, diagnostic: null });
  });

  it("falls through to the next rung on a value it cannot read, and names it", () => {
    // `disable-model-invocation: yes` is an author who believes their skill is
    // withheld and is wrong about that. Reading it as `false` in silence is
    // the failure mode this diagnostic exists for.
    const fuzzy = readAuthorInvocationPolicy({ disableModelInvocation: "yes" });
    expect(fuzzy.policy).toEqual(SKILL_POLICY_DEFAULT);
    expect(fuzzy.diagnostic).toContain(SKILL_DISABLE_MODEL_INVOCATION_KEY);
    expect(fuzzy.diagnostic).toContain("is not true or false");

    // ...and the alias still decides the axis, since the portable read failed.
    expect(
      readAuthorInvocationPolicy({
        disableModelInvocation: { nested: "map" },
        metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: true },
      }).policy,
    ).toEqual(MANUAL);
  });

  it("names a malformed user-invocable and keeps the person's axis open", () => {
    const fuzzy = readAuthorInvocationPolicy({ userInvocable: "maybe" });
    expect(fuzzy.policy).toEqual(SKILL_POLICY_DEFAULT);
    expect(fuzzy.diagnostic).toContain(SKILL_USER_INVOCABLE_KEY);
  });

  it("names a malformed legacy alias too", () => {
    const fuzzy = readAuthorInvocationPolicy({
      metadata: { [SKILL_USER_INVOKE_ONLY_KEY]: { nested: "map" } },
    });
    expect(fuzzy.policy).toEqual(SKILL_POLICY_DEFAULT);
    expect(fuzzy.diagnostic).toContain(SKILL_USER_INVOKE_ONLY_KEY);
  });

  it("treats an empty or absent value as absent rather than malformed", () => {
    expect(readAuthorInvocationPolicy({ disableModelInvocation: "  " }).diagnostic).toBeNull();
    expect(readAuthorInvocationPolicy({ disableModelInvocation: null }).diagnostic).toBeNull();
    expect(readAuthorInvocationPolicy({ userInvocable: undefined }).diagnostic).toBeNull();
  });
});

describe("skillModePolicy", () => {
  it("is the ticket's matrix for a skill whose author declared nothing", () => {
    expect(skillModePolicy("auto", SKILL_POLICY_DEFAULT)).toEqual({
      modelDiscoverable: true,
      userInvokable: true,
    });
    expect(skillModePolicy("manual", SKILL_POLICY_DEFAULT)).toEqual(MANUAL);
    expect(skillModePolicy("off", SKILL_POLICY_DEFAULT)).toEqual(CLOSED);
  });

  it("governs the model axis outright, in both directions", () => {
    expect(skillModePolicy("auto", MANUAL).modelDiscoverable).toBe(true);
    expect(skillModePolicy("manual", SKILL_POLICY_DEFAULT).modelDiscoverable).toBe(false);
  });

  it("leaves user-invocable: false to the author under auto and manual alike", () => {
    // The decision this ticket asked for, pinned: the fourth combination is
    // AUTHOR-ONLY. A mode is a prompt-budget lever, and promoting a skill into
    // the index is not a reason to start offering a `/` row its author
    // deliberately withheld.
    expect(skillModePolicy("auto", BACKGROUND)).toEqual(BACKGROUND);
    expect(skillModePolicy("manual", BACKGROUND)).toEqual(CLOSED);
  });

  it("closes both axes for off, which is a removal rather than a budget answer", () => {
    expect(skillModePolicy("off", SKILL_POLICY_DEFAULT)).toEqual(CLOSED);
    expect(skillModePolicy("off", BACKGROUND)).toEqual(CLOSED);
  });
});

describe("resolveSkillPolicy", () => {
  it("falls back to the author's declaration when the project has no rule", () => {
    expect(resolveSkillPolicy({}, skill({ invocation: MANUAL }))).toEqual(MANUAL);
    expect(resolveSkillPolicy({}, skill({ invocation: BACKGROUND }))).toEqual(BACKGROUND);
  });

  it("lets the project override the author in both directions", () => {
    const quiet = skill({ name: "quiet", invocation: MANUAL });
    const loud = skill({ name: "loud" });
    expect(resolveSkillPolicy({ quiet: "auto" }, quiet).modelDiscoverable).toBe(true);
    expect(resolveSkillPolicy({ loud: "manual" }, loud).modelDiscoverable).toBe(false);
  });

  it("ignores a rule that names some other skill", () => {
    expect(resolveSkillPolicy({ elsewhere: "off" }, skill({ name: "here" }))).toEqual(
      SKILL_POLICY_DEFAULT,
    );
  });
});

describe("sameSkillPolicy / isSkillUnavailable / authorSkillMode", () => {
  it("compares both axes", () => {
    expect(sameSkillPolicy(SKILL_POLICY_DEFAULT, { ...SKILL_POLICY_DEFAULT })).toBe(true);
    expect(sameSkillPolicy(MANUAL, BACKGROUND)).toBe(false);
    expect(sameSkillPolicy(BACKGROUND, SKILL_POLICY_DEFAULT)).toBe(false);
  });

  it("calls a policy unavailable only when neither route resolves", () => {
    expect(isSkillUnavailable(CLOSED)).toBe(true);
    expect(isSkillUnavailable(MANUAL)).toBe(false);
    expect(isSkillUnavailable(BACKGROUND)).toBe(false);
  });

  it("reads a policy back as the mode column's value", () => {
    expect(authorSkillMode(SKILL_POLICY_DEFAULT)).toBe("auto");
    expect(authorSkillMode(MANUAL)).toBe("manual");
    expect(authorSkillMode(CLOSED)).toBe("off");
    // Judged on the axis the column governs: background knowledge is Auto.
    expect(authorSkillMode(BACKGROUND)).toBe("auto");
  });
});

describe("applySkillModes", () => {
  const tdd = skill({ name: "tdd" });
  const diagnose = skill({ name: "diagnose" });
  const quiet = skill({ name: "quiet", invocation: MANUAL });

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
    const ruled = applySkillModes([tdd], { tdd: "manual" });

    expect(ruled[0]?.invocation).toEqual(MANUAL);
    expect(skillsIndexResource(ruled)).toBeNull();
    expect(ruled).toHaveLength(1);
  });

  it("does not clone a skill whose policy the rule does not change", () => {
    // `toBe`, not `toEqual`: the point is that a rule matching what the
    // frontmatter already says hands back the SAME object, so a no-op rule
    // costs nothing. A deep-equality check would pass even if it cloned.
    expect(applySkillModes([quiet], { quiet: "manual" })[0]).toBe(quiet);
  });

  it("promotes an author-manual skill when the project explicitly says auto", () => {
    // The regression this ticket exists to close. `parseSkillModes` used to
    // drop `auto`, so this override round-tripped to nothing and the Settings
    // Select snapped back — which is why the pane had stopped offering it.
    const ruled = applySkillModes([quiet], parseSkillModes({ quiet: "auto" }));

    expect(ruled[0]?.invocation).toEqual(SKILL_POLICY_DEFAULT);
    expect(skillsIndexResource(ruled)?.text).toContain("- quiet (");
  });

  it("honours the author's opt-out when the project has said nothing", () => {
    expect(applySkillModes([quiet], {})).toEqual([quiet]);
    expect(skillsIndexResource(applySkillModes([quiet], {}))).toBeNull();
  });

  it("drops a skill whose author closed both axes, with no project rule at all", () => {
    // There is no empty-rules fast path for exactly this: "no rules" is not
    // the same as "nothing to do".
    expect(applySkillModes([skill({ name: "disabled", invocation: CLOSED })], {})).toEqual([]);
  });

  it("drops a background-only skill that a project then set to manual", () => {
    // Neither route can reach it: the author refused the picker, the project
    // refused the index. Leaving the row in the supply would offer a `/` name
    // that resolves to nothing.
    const background = skill({ name: "house-style", invocation: BACKGROUND });
    expect(applySkillModes([background], { "house-style": "manual" })).toEqual([]);
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
    expect(resolveSkillMode({}, skill({ name: "quiet", invocation: MANUAL }))).toBe("manual");
  });

  it("lets the project's rule outrank the frontmatter default, both ways", () => {
    const quiet = skill({ name: "quiet", invocation: MANUAL });
    expect(resolveSkillMode({ quiet: "auto" }, quiet)).toBe("auto");
    expect(resolveSkillMode({ quiet: "off" }, quiet)).toBe("off");

    const loud = skill({ name: "loud" });
    expect(resolveSkillMode({ loud: "manual" }, loud)).toBe("manual");
  });

  it("reads off for a skill whose author closed both axes", () => {
    expect(resolveSkillMode({}, skill({ name: "disabled", invocation: CLOSED }))).toBe("off");
  });
});

describe("parseSkillModes", () => {
  it("keeps only the slugs and modes the vocabulary defines", () => {
    expect(parseSkillModes({ tdd: "off", bad: "sideways", "not a slug": "off" })).toEqual({
      tdd: "off",
    });
  });

  it("keeps an auto rule, because for some skills it IS a departure", () => {
    // The storage normalization this ticket removed. Dropping `auto` here made
    // an override the Settings pane offered snap straight back for exactly the
    // skill it mattered for — one whose author wrote
    // `disable-model-invocation: true`. Minimality now belongs to the writer,
    // which is the layer that can tell a departure from a restatement.
    expect(parseSkillModes({ tdd: "auto" })).toEqual({ tdd: "auto" });
  });

  it("reads anything that is not an object as no rules", () => {
    expect(parseSkillModes(null)).toEqual({});
    expect(parseSkillModes(["tdd"])).toEqual({});
    expect(parseSkillModes("tdd")).toEqual({});
  });
});

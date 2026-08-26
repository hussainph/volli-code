import { describe, expect, it } from "vite-plus/test";

import { COMPOSER_VERBS } from "./composer-verb";
import { expandCommandInvocation, type PromptTemplate } from "./prompt-template";
import { SKILL_POLICY_DEFAULT, type SkillReference } from "./skill";
import { resolveSlashNamespace, SLASH_SOURCE_REGISTRY, slashTargets } from "./slash-namespace";
import { isSlashInvocationName } from "./slash-name";

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { name: "review", description: "Review a file", content: "Review $1.", ...overrides };
}

function skill(overrides: Partial<SkillReference> = {}): SkillReference {
  const name = overrides.name ?? "logos";
  return {
    name,
    description: "Create professional SVG logos",
    body: "# Logos",
    invocation: SKILL_POLICY_DEFAULT,
    policyDiagnostic: null,
    root: `.agents/skills/${name}`,
    ...overrides,
  };
}

/** Every name the namespace hands out, including the reserved verbs. */
function allNames(input: {
  templates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
}): string[] {
  return [
    ...COMPOSER_VERBS.map((verb) => verb.name),
    ...resolveSlashNamespace(input).entries.map((entry) => entry.name),
  ];
}

describe("the source registry", () => {
  it("holds the ordered command and skill adapters behind one iterable seam", () => {
    expect([...SLASH_SOURCE_REGISTRY.keys()]).toEqual(["command", "skill"]);
  });

  it("leaves an ordinary supply alone and keeps source order", () => {
    const namespace = resolveSlashNamespace({
      templates: [template(), template({ name: "plan" })],
      skills: [skill()],
    });

    expect(namespace.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ["command", "review"],
      ["command", "plan"],
      ["skill", "logos"],
    ]);
    for (const entry of namespace.entries) {
      expect(entry.shadowedBy).toBeNull();
      expect(entry.syntaxQualified).toBe(false);
      expect(entry.name).toBe(entry.bareName);
      expect(isSlashInvocationName(entry.name)).toBe(true);
    }
  });
});

describe("verb reservation", () => {
  it("keeps a shadowed template under a command-qualified name", () => {
    const own = template({ name: "compact", description: "my own compaction prompt" });
    const [entry] = resolveSlashNamespace({ templates: [own], skills: [] }).entries;

    expect(entry).toMatchObject({
      kind: "command",
      name: "command:compact",
      bareName: "compact",
      shadowedBy: "verb",
      syntaxQualified: false,
      target: { kind: "command", template: own },
    });
  });

  it("qualifies a skill a verb shadowed", () => {
    const [entry] = resolveSlashNamespace({
      templates: [],
      skills: [skill({ name: "compact" })],
    }).entries;

    expect(entry).toMatchObject({ name: "skill:compact", shadowedBy: "verb" });
  });

  it("reserves verbs even when the current moment would refuse them", () => {
    const entries = resolveSlashNamespace({
      templates: [template({ name: "copy" }), template({ name: "reload" })],
      skills: [],
    }).entries;

    expect(entries.map((entry) => entry.name)).toEqual(["command:copy", "command:reload"]);
  });
});

describe("source precedence and truthful ownership", () => {
  it("preserves template over skill for a shared bare name", () => {
    const entries = resolveSlashNamespace({
      templates: [template({ name: "review" })],
      skills: [skill({ name: "review" })],
    }).entries;

    expect(entries.map((entry) => [entry.kind, entry.name, entry.shadowedBy])).toEqual([
      ["command", "review", null],
      ["skill", "skill:review", "command"],
    ]);
  });

  it("sorts skills before assigning names", () => {
    const entries = resolveSlashNamespace({
      templates: [],
      skills: [skill({ name: "beta" }), skill({ name: "alpha" })],
    }).entries;

    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
  });

  it("reports a duplicate template as shadowed by a command, not a verb", () => {
    const entries = resolveSlashNamespace({
      templates: [template({ name: "review" }), template({ name: "review" })],
      skills: [],
    }).entries;

    expect(entries.map((entry) => [entry.name, entry.shadowedBy])).toEqual([
      ["review", null],
      ["command:review", "command"],
    ]);
  });

  it("reports a generated alias that takes a later skill name as a skill collision", () => {
    const entries = resolveSlashNamespace({
      templates: [],
      skills: [skill({ name: "compact" }), skill({ name: "skill:compact" })],
    }).entries;

    expect(entries.map((entry) => [entry.name, entry.shadowedBy])).toEqual([
      ["skill:compact", "verb"],
      ["skill:skill:compact", "skill"],
    ]);
  });
});

describe("fallback names", () => {
  it("hands out no name twice however the supply collides", () => {
    const names = allNames({
      templates: [template({ name: "compact" }), template({ name: "review" })],
      skills: [skill({ name: "compact" }), skill({ name: "review" }), skill()],
    });

    expect(new Set(names).size).toBe(names.length);
  });

  it("executes the numeric suffix loop when a qualified base is already taken", () => {
    const qualified = template({ name: "command:compact", content: "First $1." });
    const shadowed = template({ name: "compact", content: "Second $1." });
    const entries = resolveSlashNamespace({ templates: [qualified, shadowed], skills: [] }).entries;

    expect(entries.map((entry) => entry.name)).toEqual(["command:compact", "command:compact1"]);
    expect(expandCommandInvocation("/command:compact1 now", [qualified, shadowed]).text).toBe(
      "Second now.",
    );
  });

  it("normalizes an unspellable basename instead of offering a dead row", () => {
    const spaced = template({ name: "ship it", content: "Ship $1." });
    const punctuation = template({ name: "...", content: "Fallback." });
    const entries = resolveSlashNamespace({ templates: [spaced, punctuation], skills: [] }).entries;

    expect(entries.map((entry) => [entry.name, entry.syntaxQualified])).toEqual([
      ["command:ship-it", true],
      ["command:item", true],
    ]);
    expect(entries.every((entry) => isSlashInvocationName(entry.name))).toBe(true);
    expect(expandCommandInvocation("/command:ship-it now", [spaced, punctuation]).text).toBe(
      "Ship now.",
    );
  });
});

describe("submit resolution", () => {
  it("expands a shadowed template while its verb-owned bare name passes through", () => {
    const own = template({ name: "compact", content: "Summarize $1 my way." });

    expect(expandCommandInvocation("/compact now", [own]).text).toBe("/compact now");
    expect(expandCommandInvocation("/command:compact now", [own]).text).toBe(
      "Summarize now my way.",
    );
  });

  it("delivers a shadowed skill under its qualified name", () => {
    const shadowed = skill({ name: "review", body: "# Review" });
    const expanded = expandCommandInvocation(
      "/skill:review please",
      [template({ name: "review" })],
      [shadowed],
    );

    expect(expanded.text).toBe("/skill:review please");
    expect(expanded.resources.map((resource) => resource.name)).toEqual(["review"]);
  });

  it("keeps distinct duplicated skill rows distinct when both are invoked", () => {
    const first = skill({ name: "review", body: "first", root: "first" });
    const second = skill({ name: "review", body: "second", root: "second" });
    const expanded = expandCommandInvocation("/review\n/skill:review", [], [first, second]);

    expect(expanded.resources.map((resource) => resource.text)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });

  it("maps every resolved entry directly to its target and no verb", () => {
    const namespace = resolveSlashNamespace({
      templates: [template({ name: "compact" })],
      skills: [skill()],
    });
    const targets = slashTargets(namespace);

    expect(targets.get("command:compact")?.kind).toBe("command");
    expect(targets.get("logos")?.kind).toBe("skill");
    expect(targets.has("compact")).toBe(false);
  });

  it("resolves a qualified invocation mid-draft", () => {
    const own = template({ name: "compact", content: "Summarize $1." });
    expect(expandCommandInvocation("please /command:compact now", [own]).text).toBe(
      "please Summarize now.",
    );
  });

  it("leaves a qualified invocation inside another command's arguments as an argument", () => {
    const review = template({ name: "review", content: "Review $1." });
    const own = template({ name: "compact", content: "Never here $1." });
    expect(expandCommandInvocation("/review /command:compact", [review, own]).text).toBe(
      "Review /command:compact.",
    );
  });
});

describe("the user-invokable axis (VC-181)", () => {
  const manual = skill({
    name: "wait-what",
    invocation: { modelDiscoverable: false, userInvokable: true },
  });
  const background = skill({
    name: "house-style",
    invocation: { modelDiscoverable: true, userInvokable: false },
  });

  it("offers a manual skill — withheld from the model is not withheld from the person", () => {
    const namespace = resolveSlashNamespace({ templates: [], skills: [manual] });

    expect(namespace.entries.map((entry) => entry.name)).toEqual(["wait-what"]);
    expect(slashTargets(namespace).get("wait-what")?.kind).toBe("skill");
  });

  it("withholds a user-invocable: false skill from the namespace entirely", () => {
    const namespace = resolveSlashNamespace({ templates: [], skills: [background] });

    expect(namespace.entries).toEqual([]);
    expect(slashTargets(namespace).has("house-style")).toBe(false);
  });

  it("keeps the picker and submit in exact agreement about both", () => {
    // Parity is structural: `expandCommandInvocation` resolves through the
    // same namespace the picker lists, so there is no arrangement in which one
    // offers a row the other cannot resolve.
    const skills = [manual, background];
    const offered = new Set(
      resolveSlashNamespace({ templates: [], skills }).entries.map((e) => e.name),
    );

    const expanded = expandCommandInvocation("/wait-what and /house-style please", [], skills);

    expect(offered).toEqual(new Set(["wait-what"]));
    // The offered one delivered a resource; the unoffered one stayed prose.
    expect(expanded.resources.map((resource) => resource.name)).toEqual(["wait-what"]);
    expect(expanded.text).toBe("/wait-what and /house-style please");
  });

  it("does not let a withheld skill free up a name a later skill then takes", () => {
    // The filter runs before naming, so `house-style` never reserves anything.
    const other = skill({ name: "house-style", root: "/home/.agents/skills/house-style" });
    const namespace = resolveSlashNamespace({ templates: [], skills: [background, other] });

    expect(namespace.entries.map((entry) => entry.name)).toEqual(["house-style"]);
    expect(namespace.entries[0]?.shadowedBy).toBeNull();
  });
});

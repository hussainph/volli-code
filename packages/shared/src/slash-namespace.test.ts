import { describe, expect, it } from "vite-plus/test";

import { COMPOSER_VERBS } from "./composer-verb";
import { expandCommandInvocation, type PromptTemplate } from "./prompt-template";
import type { SkillReference } from "./skill";
import { resolveSlashNamespace, slashTargets } from "./slash-namespace";

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { name: "review", description: "Review a file", content: "Review $1.", ...overrides };
}

function skill(overrides: Partial<SkillReference> = {}): SkillReference {
  const name = overrides.name ?? "logos";
  return {
    name,
    description: "Create professional SVG logos",
    body: "# Logos",
    userInvokeOnly: false,
    root: `.agents/skills/${name}`,
    ...overrides,
  };
}

/** Every name the namespace hands out, in one list — what must never repeat. */
function allNames(input: {
  templates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
}): string[] {
  const namespace = resolveSlashNamespace(input);
  return [
    ...COMPOSER_VERBS.map((verb) => verb.name),
    ...namespace.templates.map((entry) => entry.name),
    ...namespace.skills.map((entry) => entry.name),
  ];
}

describe("names nothing collides with", () => {
  it("leaves an ordinary supply entirely alone", () => {
    const templates = [template(), template({ name: "plan" })];
    const skills = [skill()];
    const namespace = resolveSlashNamespace({ templates, skills });

    // Nothing here wants a name anything else has, so nothing is qualified and
    // every row is spelled the way its file is.
    expect(namespace.templates.map((entry) => entry.name)).toEqual(["review", "plan"]);
    expect(namespace.skills.map((entry) => entry.name)).toEqual(["logos"]);
    for (const entry of [...namespace.templates, ...namespace.skills]) {
      expect(entry.shadowedBy).toBeNull();
      expect(entry.name).toBe(entry.bareName);
    }
  });
});

describe("what happens to the name a verb owns", () => {
  it("keeps the template, under a name that says which kind it is", () => {
    const own = template({ name: "compact", description: "my own compaction prompt" });
    const namespace = resolveSlashNamespace({ templates: [own, template()], skills: [] });

    // THE CHANGE THIS MODULE EXISTS FOR. The verb still wins `/compact` — an
    // operation must never silently become a message — but the file the user
    // wrote is no longer deleted from the surface for having wanted the name.
    // It is renamed, and it still runs.
    expect(namespace.templates[0]).toEqual({
      item: own,
      name: "command:compact",
      bareName: "compact",
      shadowedBy: "verb",
    });
    expect(namespace.templates[1]?.name).toBe("review");
  });

  it("qualifies a template spelled like any of the newer verbs, too", () => {
    // `model` and `settings` are words a project plausibly used for a prompt
    // before these verbs existed. Reservation covers every verb, not just the
    // first one's — and now costs those projects a rename rather than the row.
    const templates = [
      template({ name: "model" }),
      template({ name: "settings" }),
      template({ name: "copy" }),
    ];
    const namespace = resolveSlashNamespace({ templates, skills: [] });
    expect(namespace.templates.map((entry) => entry.name)).toEqual([
      "command:model",
      "command:settings",
      "command:copy",
    ]);
  });

  it("qualifies a skill a verb shadowed, and says the verb did it", () => {
    const namespace = resolveSlashNamespace({
      templates: [],
      skills: [skill({ name: "compact" })],
    });
    expect(namespace.skills[0]?.name).toBe("skill:compact");
    expect(namespace.skills[0]?.shadowedBy).toBe("verb");
  });

  it("reserves a verb's name even in a moment that would refuse the verb", () => {
    // `/copy` is refused with nothing to copy and `/reload` with no project,
    // but reservation does not consult `refusal` — a name that changed meaning
    // as a Session progressed would be worse than a name that is taken.
    const namespace = resolveSlashNamespace({
      templates: [template({ name: "copy" }), template({ name: "reload" })],
      skills: [],
    });
    expect(namespace.templates.map((entry) => entry.name)).toEqual([
      "command:copy",
      "command:reload",
    ]);
  });
});

describe("template over skill, still", () => {
  it("renames the skill and leaves the command its bare name", () => {
    const shadowed = skill({ name: "review" });
    const namespace = resolveSlashNamespace({
      templates: [template({ name: "review" })],
      skills: [shadowed, skill()],
    });

    // Which of the two wins is unchanged — `expandCommandInvocation` has always
    // resolved template-first. Only the loser's fate changed.
    expect(namespace.templates[0]?.name).toBe("review");
    expect(namespace.skills.find((entry) => entry.item === shadowed)).toEqual({
      item: shadowed,
      name: "skill:review",
      bareName: "review",
      shadowedBy: "command",
    });
  });

  it("sorts skills by name so a directory read's order cannot decide", () => {
    const namespace = resolveSlashNamespace({
      templates: [],
      skills: [skill({ name: "beta" }), skill({ name: "alpha" })],
    });
    expect(namespace.skills.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
  });
});

describe("one name means one thing", () => {
  it("hands out no name twice, however the supply collides", () => {
    const names = allNames({
      templates: [template({ name: "compact" }), template({ name: "review" })],
      skills: [skill({ name: "compact" }), skill({ name: "review" }), skill({ name: "logos" })],
    });
    expect(new Set(names).size).toBe(names.length);
  });

  it("suffixes when the qualified name is itself taken", () => {
    // `:` is legal in a name, so a skill really can be called `skill:compact`
    // and collide with the qualified form of another. Without the suffix one
    // would overwrite the other and the picker would run the wrong thing.
    const namespace = resolveSlashNamespace({
      templates: [],
      skills: [skill({ name: "compact" }), skill({ name: "skill:compact" })],
    });
    const names = namespace.skills.map((entry) => entry.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain("skill:compact");
    expect(names).toContain("skill:skill:compact");
  });
});

describe("the qualified name actually runs the thing", () => {
  it("expands a shadowed template at submit, where its bare name expands to nothing", () => {
    const own = template({ name: "compact", content: "Summarize $1 my way." });

    // The bare name is the verb's: it expands to nothing and passes through
    // verbatim, which is what leaves the press free to run the operation.
    expect(expandCommandInvocation("/compact now", [own]).text).toBe("/compact now");

    // The qualified name is this template's, and it expands. This round-trip
    // is the whole claim: a renamed row is reachable, not merely visible.
    expect(expandCommandInvocation("/command:compact now", [own]).text).toBe(
      "Summarize now my way.",
    );
  });

  it("delivers a shadowed skill's body under its qualified name", () => {
    const shadowed = skill({ name: "review", body: "# Review" });
    const expanded = expandCommandInvocation(
      "/skill:review please",
      [template({ name: "review" })],
      [shadowed],
    );

    // The reference stays verbatim and the body rides beside it, exactly as an
    // unshadowed skill's does.
    expect(expanded.text).toBe("/skill:review please");
    expect(expanded.resources.map((resource) => resource.name)).toEqual(["review"]);
  });

  it("still resolves the template that kept its bare name", () => {
    const kept = template({ name: "review", content: "Review $1." });
    const shadowed = skill({ name: "review" });
    expect(expandCommandInvocation("/review a.ts", [kept], [shadowed]).text).toBe("Review a.ts.");
  });
});

describe("slashTargets", () => {
  it("maps every resolved name to what it runs, and holds no verb", () => {
    const own = template({ name: "compact" });
    const namespace = resolveSlashNamespace({ templates: [own], skills: [skill()] });
    const targets = slashTargets(namespace);

    expect(targets.get("command:compact")).toEqual({ kind: "command", template: own });
    expect(targets.get("logos")?.kind).toBe("skill");
    // A verb expands to nothing, so it is deliberately absent rather than
    // present-and-ignored.
    expect(targets.has("compact")).toBe(false);
  });
});

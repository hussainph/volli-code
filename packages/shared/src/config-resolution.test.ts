import { describe, expect, it } from "vite-plus/test";

import {
  configPlan,
  resolveConfigEntries,
  resolveConfigValue,
  type ConfigPlan,
} from "./config-resolution";

describe("configPlan", () => {
  it("keeps the repo tier first for skills, whatever the cloud flag", () => {
    expect(configPlan("skills")).toEqual({
      merge: "union",
      order: ["policy", "repo", "personal"],
      deny: ["policy"],
    });
    // @ts-expect-error -- the skills order does not move under the flag, so it takes none.
    expect(configPlan("skills", true).order).toEqual(["policy", "repo", "personal"]);
  });

  it("keeps the project tier first for prompt templates with cloud off", () => {
    expect(configPlan("promptTemplates", false)).toEqual({
      merge: "union",
      order: ["policy", "project", "personal"],
      deny: ["policy"],
    });
  });

  it("puts personal over the project tier for prompt templates with cloud on", () => {
    expect(configPlan("promptTemplates", true)).toEqual({
      merge: "union",
      order: ["policy", "personal", "project"],
      deny: ["policy"],
    });
  });

  it("declares the override surfaces in their current order", () => {
    expect(configPlan("skillMode")).toEqual({ merge: "override", order: ["project"] });
    expect(configPlan("decisionModel")).toEqual({
      merge: "override",
      order: ["project", "personal"],
    });
    expect(configPlan("theme")).toEqual({ merge: "override", order: ["project", "personal"] });
  });
});

describe("resolveConfigValue", () => {
  const plan: ConfigPlan<"override"> = {
    merge: "override",
    order: ["policy", "repo", "personal", "project", "workspace"],
  };

  it("takes the highest level that sets a value, with its provenance", () => {
    expect(resolveConfigValue(plan, { project: "p", workspace: "w" })).toEqual({
      value: "p",
      level: "project",
    });
    expect(resolveConfigValue(plan, { personal: "me", workspace: "w", repo: "r" })).toEqual({
      value: "r",
      level: "repo",
    });
    expect(resolveConfigValue(plan, { policy: "admin", personal: "me" })).toEqual({
      value: "admin",
      level: "policy",
    });
  });

  it("reads null and undefined as inherit", () => {
    expect(
      resolveConfigValue(plan, { personal: null, project: undefined, workspace: "w" }),
    ).toEqual({ value: "w", level: "workspace" });
  });

  it("keeps falsy values that are set", () => {
    expect(resolveConfigValue(plan, { personal: false, project: true })).toEqual({
      value: false,
      level: "personal",
    });
    expect(resolveConfigValue(plan, { project: 0 })).toEqual({ value: 0, level: "project" });
  });

  it("answers null when no level sets a value", () => {
    expect(resolveConfigValue(plan, {})).toBeNull();
    expect(resolveConfigValue(plan, { personal: null })).toBeNull();
  });

  it("ignores levels outside the plan's order", () => {
    expect(resolveConfigValue(configPlan("theme"), { policy: "x", repo: "y" })).toBeNull();
  });

  it("resolves a surface's own level vocabulary", () => {
    const scoped: ConfigPlan<"override", "near" | "far"> = {
      merge: "override",
      order: ["near", "far"],
    };
    expect(resolveConfigValue(scoped, { far: 1 })).toEqual({ value: 1, level: "far" });
  });
});

type Entry = { name: string; body: string };
const entry = (name: string, body: string): Entry => ({ name, body });
const byName = (item: Entry): string => item.name;

describe("resolveConfigEntries", () => {
  const plan: ConfigPlan<"union"> = {
    merge: "union",
    order: ["policy", "repo", "personal", "project", "workspace"],
    deny: ["policy", "project"],
  };

  it("unions every level and lets the highest level win a shared key outright", () => {
    const resolved = resolveConfigEntries(
      plan,
      {
        workspace: [entry("review", "workspace"), entry("lint", "workspace")],
        personal: [entry("review", "personal"), entry("mine", "personal")],
      },
      byName,
    );
    expect(resolved).toEqual([
      { key: "review", value: entry("review", "personal"), level: "personal" },
      { key: "lint", value: entry("lint", "workspace"), level: "workspace" },
      { key: "mine", value: entry("mine", "personal"), level: "personal" },
    ]);
  });

  it("keeps a repo entry against every configured level that defines its name", () => {
    const resolved = resolveConfigEntries(
      plan,
      {
        repo: [entry("review", "repo")],
        workspace: [entry("review", "workspace")],
        project: [entry("review", "project")],
        personal: [entry("review", "personal"), entry("mine", "personal")],
      },
      byName,
    );
    expect(resolved).toEqual([
      { key: "review", value: entry("review", "repo"), level: "repo" },
      { key: "mine", value: entry("mine", "personal"), level: "personal" },
    ]);
  });

  it("lets a later entry replace an earlier one within a level", () => {
    expect(
      resolveConfigEntries(plan, { project: [entry("a", "first"), entry("a", "second")] }, byName),
    ).toEqual([{ key: "a", value: entry("a", "second"), level: "project" }]);
  });

  it("removes a denied key from the denying level and every level below it", () => {
    const resolved = resolveConfigEntries(
      plan,
      {
        repo: [entry("risky", "repo"), entry("safe", "repo")],
        project: [entry("risky", "project")],
        personal: [entry("other", "personal")],
      },
      byName,
      { policy: ["risky"] },
    );
    expect(resolved.map(({ key }) => key)).toEqual(["other", "safe"]);
  });

  it("lets a level above a deny define the denied key again", () => {
    const resolved = resolveConfigEntries(
      plan,
      { workspace: [entry("tool", "workspace")], personal: [entry("tool", "personal")] },
      byName,
      { project: ["tool"] },
    );
    expect(resolved).toEqual([
      { key: "tool", value: entry("tool", "personal"), level: "personal" },
    ]);
  });

  it("ignores deny lists from levels the plan does not let deny", () => {
    const resolved = resolveConfigEntries(
      plan,
      { workspace: [entry("tool", "workspace")] },
      byName,
      { repo: ["tool"], personal: ["tool"], workspace: ["tool"] },
    );
    expect(resolved.map(({ key }) => key)).toEqual(["tool"]);
    expect(
      resolveConfigEntries(
        { merge: "union", order: ["personal", "workspace"] },
        { workspace: [entry("tool", "workspace")] },
        byName,
        { personal: ["tool"] },
      ),
    ).toHaveLength(1);
  });

  it("keeps a repo skill against a same-named personal one, beside the personal additions", () => {
    expect(
      resolveConfigEntries(
        configPlan("skills"),
        {
          repo: [entry("review", "repo")],
          personal: [entry("review", "personal"), entry("mine", "personal")],
        },
        byName,
      ),
    ).toEqual([
      { key: "review", value: entry("review", "repo"), level: "repo" },
      { key: "mine", value: entry("mine", "personal"), level: "personal" },
    ]);
  });

  it("lets policy deny a skill whatever level defines it", () => {
    expect(
      resolveConfigEntries(
        configPlan("skills"),
        { repo: [entry("risky", "repo")], personal: [entry("risky", "personal")] },
        byName,
        { policy: ["risky"] },
      ),
    ).toEqual([]);
  });

  it("ignores levels outside the plan's order", () => {
    expect(
      resolveConfigEntries(
        configPlan("skills"),
        { project: [entry("x", "project")], repo: [entry("y", "repo")] },
        byName,
      ),
    ).toEqual([{ key: "y", value: entry("y", "repo"), level: "repo" }]);
  });

  it("answers an empty list when no level contributes", () => {
    expect(resolveConfigEntries(plan, {}, byName)).toEqual([]);
  });

  it("resolves a surface's own level vocabulary", () => {
    const scoped: ConfigPlan<"union", "session" | "always"> = {
      merge: "union",
      order: ["session", "always"],
    };
    expect(
      resolveConfigEntries(
        scoped,
        { always: [entry("TOKEN", "always")], session: [entry("TOKEN", "session")] },
        byName,
      ),
    ).toEqual([{ key: "TOKEN", value: entry("TOKEN", "session"), level: "session" }]);
  });
});

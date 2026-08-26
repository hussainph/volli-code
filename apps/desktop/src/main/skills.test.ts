import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  SKILL_POLICY_DEFAULT,
  SKILL_POLICY_UNAVAILABLE,
  skillRootDir,
  type SkillInvocationPolicy,
} from "@volli/shared";

import { loadSkills, readSkillDir } from "./skills";

/** The project tier's root spelling — what every `readSkillDir` case below reads under. */
const readProjectSkills = (dir: string) => readSkillDir(dir, skillRootDir);

/** Slug → effective author policy, the shape the invocation cases assert on. */
async function policiesIn(dir: string): Promise<Record<string, SkillInvocationPolicy>> {
  const result = await readProjectSkills(dir);
  if (!result.ok) throw new Error(result.error);
  return Object.fromEntries(result.skills.map((skill) => [skill.name, skill.authorPolicy]));
}

const tempDirs: string[] = [];

/** A skills dir holding one SKILL.md per named slug. */
function makeSkillsDir(skills: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "volli-skills-test-"));
  tempDirs.push(root);
  const dir = join(root, "skills");
  mkdirSync(dir, { recursive: true });
  for (const [slug, content] of Object.entries(skills)) {
    mkdirSync(join(dir, slug), { recursive: true });
    writeFileSync(join(dir, slug, "SKILL.md"), content, "utf8");
  }
  return dir;
}

/** A path inside a real temp root that deliberately does not exist. */
function missingDir(): string {
  const root = mkdtempSync(join(tmpdir(), "volli-skills-test-"));
  tempDirs.push(root);
  return join(root, "skills");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("readProjectSkills", () => {
  it("reads each skill directory's SKILL.md as slug + description + body", async () => {
    const dir = makeSkillsDir({
      "svg-logo-designer":
        '---\nname: "SVG Logo Designer"\ndescription: Draw logos\n---\n# Logos\n\nDo the thing.',
    });

    const result = await readProjectSkills(dir);

    expect(result).toEqual({
      ok: true,
      skills: [
        {
          name: "svg-logo-designer",
          description: "Draw logos",
          body: "# Logos\n\nDo the thing.",
          authorPolicy: SKILL_POLICY_DEFAULT,
          effectivePolicy: SKILL_POLICY_DEFAULT,
          policyDiagnostic: null,
          root: ".agents/skills/svg-logo-designer",
        },
      ],
    });
  });

  it("treats a missing directory as empty, never as an error", async () => {
    await expect(readProjectSkills(missingDir())).resolves.toEqual({ ok: true, skills: [] });
  });

  it("sorts skills by slug so the list is stable", async () => {
    const dir = makeSkillsDir({ beta: "B", alpha: "A" });

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  });

  it("skips a directory the /name grammar cannot spell", async () => {
    const dir = makeSkillsDir({ "My Skill": "body", spellable: "body" });

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skills.map((skill) => skill.name)).toEqual(["spellable"]);
  });

  it("skips a directory without a SKILL.md rather than failing the batch", async () => {
    const dir = makeSkillsDir({ real: "body" });
    mkdirSync(join(dir, "not-a-skill"));

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skills.map((skill) => skill.name)).toEqual(["real"]);
  });

  it("ignores loose files beside the skill directories", async () => {
    const dir = makeSkillsDir({ real: "body" });
    writeFileSync(join(dir, "README.md"), "not a skill", "utf8");

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skills.map((skill) => skill.name)).toEqual(["real"]);
  });

  it("follows a symlinked skill directory", async () => {
    const dir = makeSkillsDir({ target: "linked body" });
    symlinkSync(join(dir, "target"), join(dir, "linked"), "dir");

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skills.map((skill) => skill.name)).toEqual(["linked", "target"]);
    }
  });

  it("defaults a skill to advertised — the format's own default", async () => {
    const dir = makeSkillsDir({ plain: "---\ndescription: d\n---\nBody" });

    const result = await readProjectSkills(dir);

    expect(result).toEqual({
      ok: true,
      skills: [
        {
          name: "plain",
          description: "d",
          body: "Body",
          authorPolicy: SKILL_POLICY_DEFAULT,
          effectivePolicy: SKILL_POLICY_DEFAULT,
          policyDiagnostic: null,
          root: ".agents/skills/plain",
        },
      ],
    });
  });

  it("honours the portable disable-model-invocation flag, string or bare boolean", async () => {
    const dir = makeSkillsDir({
      quiet: '---\ndescription: d\ndisable-model-invocation: "true"\n---\nBody',
      yamlish: "---\ndescription: d\ndisable-model-invocation: true\n---\nBody",
      loud: "---\ndescription: d\ndisable-model-invocation: false\n---\nBody",
    });

    // The acceptance case: a skill whose ONLY declaration is this flag is
    // withheld from the model and still typable, with no Project override.
    await expect(policiesIn(dir)).resolves.toEqual({
      quiet: { modelDiscoverable: false, userInvokable: true },
      yamlish: { modelDiscoverable: false, userInvokable: true },
      loud: SKILL_POLICY_DEFAULT,
    });
  });

  it("honours user-invocable: false as the other axis", async () => {
    const dir = makeSkillsDir({
      background: "---\ndescription: d\nuser-invocable: false\n---\nBody",
      both: "---\ndescription: d\nuser-invocable: false\ndisable-model-invocation: true\n---\nBody",
    });

    await expect(policiesIn(dir)).resolves.toEqual({
      background: { modelDiscoverable: true, userInvokable: false },
      both: { modelDiscoverable: false, userInvokable: false },
    });
  });

  it("still honours the legacy metadata alias when the portable field is absent", async () => {
    const dir = makeSkillsDir({
      quiet: '---\ndescription: d\nmetadata:\n  volli-user-invoke-only: "true"\n---\nBody',
      yamlish: "---\ndescription: d\nmetadata:\n  volli-user-invoke-only: true\n---\nBody",
      loud: '---\ndescription: d\nmetadata:\n  volli-user-invoke-only: "false"\n---\nBody',
      unrelated: "---\ndescription: d\nmetadata:\n  author: someone\n---\nBody",
    });

    await expect(policiesIn(dir)).resolves.toEqual({
      quiet: { modelDiscoverable: false, userInvokable: true },
      yamlish: { modelDiscoverable: false, userInvokable: true },
      loud: SKILL_POLICY_DEFAULT,
      unrelated: SKILL_POLICY_DEFAULT,
    });
  });

  it("resolves a conflicting pair deterministically and says so on the row", async () => {
    const dir = makeSkillsDir({
      conflicted:
        "---\ndescription: d\ndisable-model-invocation: false\nmetadata:\n  volli-user-invoke-only: true\n---\nBody",
    });

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The portable field wins, because it is the one the author wrote for
    // every other harness they use.
    expect(result.skills[0]?.authorPolicy).toEqual(SKILL_POLICY_DEFAULT);
    expect(result.skills[0]?.policyDiagnostic).toContain("disable-model-invocation wins");
  });

  it("reports a flag it cannot read rather than silently reading it as false", async () => {
    const dir = makeSkillsDir({
      fuzzy: "---\ndescription: d\ndisable-model-invocation: yes\n---\nBody",
    });

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills[0]?.authorPolicy).toEqual(SKILL_POLICY_DEFAULT);
    expect(result.skills[0]?.policyDiagnostic).toContain("is not true or false");
  });

  it("fails malformed YAML closed and surfaces a useful diagnostic", async () => {
    const dir = makeSkillsDir({
      broken: "---\ndescription: [not closed\ndisable-model-invocation: true\n---\nBody",
      unfenced: "---\ndisable-model-invocation: true\nBody",
    });

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const loaded of result.skills) {
      expect(loaded.authorPolicy).toEqual(SKILL_POLICY_UNAVAILABLE);
      expect(loaded.effectivePolicy).toEqual(SKILL_POLICY_UNAVAILABLE);
      expect(loaded.policyDiagnostic).toContain("unavailable until SKILL.md is fixed");
    }
  });

  it("does not read a sibling Codex agents/openai.yaml as frontmatter", async () => {
    const dir = makeSkillsDir({ codexy: "---\ndescription: d\n---\nBody" });
    mkdirSync(join(dir, "codexy", "agents"), { recursive: true });
    writeFileSync(
      join(dir, "codexy", "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
      "utf8",
    );

    // Another client's configuration file, beside the skill rather than in it.
    await expect(policiesIn(dir)).resolves.toEqual({ codexy: SKILL_POLICY_DEFAULT });
  });

  it("derives a description from the body when the frontmatter has none", async () => {
    const dir = makeSkillsDir({ plain: "First line says it.\n\nMore." });

    const result = await readProjectSkills(dir);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skills[0]?.description).toBe("First line says it.");
  });

  it("reports a directory that exists but cannot be read", async () => {
    const dir = makeSkillsDir();
    chmodSync(dir, 0o000);
    try {
      const result = await readProjectSkills(dir);
      expect(result.ok).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe("loadSkills", () => {
  it("offers both tiers, and roots each the way its tier is addressed", async () => {
    const project = makeSkillsDir({ vendored: "---\ndescription: p\n---\nProject body" });
    const global = makeSkillsDir({ personal: "---\ndescription: g\n---\nPersonal body" });

    const result = await loadSkills({ projectSkillsDir: project, globalSkillsDir: global });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills.map((skill) => skill.name)).toEqual(["personal", "vendored"]);
    // A project skill is workspace-relative; a personal one has to be
    // absolute, because no workspace-relative path reaches `~`.
    expect(result.skills.find((skill) => skill.name === "vendored")?.root).toBe(
      ".agents/skills/vendored",
    );
    expect(result.skills.find((skill) => skill.name === "personal")?.root).toBe(
      `${global}/personal`,
    );
  });

  it("lets the project tier win a slug the personal tier also defines", async () => {
    const project = makeSkillsDir({ shared: "---\ndescription: from project\n---\nProject body" });
    const global = makeSkillsDir({ shared: "---\ndescription: from home\n---\nPersonal body" });

    const result = await loadSkills({ projectSkillsDir: project, globalSkillsDir: global });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skills).toEqual([
      {
        name: "shared",
        description: "from project",
        body: "Project body",
        authorPolicy: SKILL_POLICY_DEFAULT,
        effectivePolicy: SKILL_POLICY_DEFAULT,
        policyDiagnostic: null,
        root: ".agents/skills/shared",
      },
    ]);
  });

  it("treats either tier's absence as an empty tier", async () => {
    const global = makeSkillsDir({ personal: "body" });

    await expect(
      loadSkills({ projectSkillsDir: missingDir(), globalSkillsDir: global }),
    ).resolves.toMatchObject({ ok: true, skills: [{ name: "personal" }] });
    await expect(
      loadSkills({ projectSkillsDir: missingDir(), globalSkillsDir: missingDir() }),
    ).resolves.toEqual({ ok: true, skills: [] });
  });

  it("surfaces an unreadable tier — either one — rather than silently dropping it", async () => {
    const readable = makeSkillsDir({ fine: "body" });
    const locked = makeSkillsDir();
    chmodSync(locked, 0o000);
    try {
      await expect(
        loadSkills({ projectSkillsDir: locked, globalSkillsDir: readable }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        loadSkills({ projectSkillsDir: readable, globalSkillsDir: locked }),
      ).resolves.toMatchObject({ ok: false });
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

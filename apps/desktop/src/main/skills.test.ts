import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { readProjectSkills } from "./skills";

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

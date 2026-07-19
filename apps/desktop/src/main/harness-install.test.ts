import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildHarnessInstallPlan, genericHarnessActions } from "@volli/shared";

import { applyHarnessInstallPlan, uninstallHarnessPlan } from "./harness-install";

let root: string | undefined;

afterEach(async () => {
  if (!root) return;
  await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("harness install executor", () => {
  it("installs idempotently and preserves user-owned custom content", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-harness-test-"));
    const plan = buildHarnessInstallPlan({
      home: root,
      detected: ["claude-code", "codex", "opencode"],
    });
    const manifestPath = join(root, ".agents/skills/volli/.volli-managed.json");

    const first = await applyHarnessInstallPlan(plan, manifestPath);
    await mkdir(join(root, ".agents/skills/volli/custom"), { recursive: true });
    await writeFile(join(root, ".agents/skills/volli/custom/mine.md"), "user owned");
    const second = await applyHarnessInstallPlan(plan, manifestPath);

    expect(first.conflicts).toEqual([]);
    expect(first.written).toHaveLength(5);
    expect(second.written).toEqual([]);
    expect(second.skipped).toHaveLength(5);
    expect(await readFile(join(root, ".agents/skills/volli/custom/mine.md"), "utf8")).toBe(
      "user owned",
    );
    expect((await stat(join(root, ".claude/skills/volli"))).isDirectory()).toBe(true);
  });

  it("hash-guards user-edited managed files and uninstalls only managed content", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-harness-test-"));
    const plan = buildHarnessInstallPlan({ home: root, detected: ["claude-code", "codex"] });
    const manifestPath = join(root, ".agents/skills/volli/.volli-managed.json");
    await applyHarnessInstallPlan(plan, manifestPath);
    const skillPath = join(root, ".agents/skills/volli/SKILL.md");
    await writeFile(skillPath, "my edited skill\n");
    await mkdir(join(root, ".agents/skills/volli/custom"), { recursive: true });
    const customPath = join(root, ".agents/skills/volli/custom/mine.md");
    await writeFile(customPath, "keep me");

    const refreshed = await applyHarnessInstallPlan(plan, manifestPath);
    expect(refreshed.conflicts).toHaveLength(1);
    expect(refreshed.conflicts[0]?.path).toBe(skillPath);
    expect(refreshed.conflicts[0]?.currentContent).toBe("my edited skill\n");
    expect(refreshed.conflicts[0]?.desiredContent.length).toBeGreaterThan(0);
    expect(await readFile(skillPath, "utf8")).toBe("my edited skill\n");

    const cliPath = join(root, ".agents/skills/volli/cli.md");
    const removal = await uninstallHarnessPlan(plan, manifestPath);
    // The user-edited SKILL.md is preserved (install protected it as a conflict;
    // uninstall must honor the same boundary), while pristine managed files go.
    expect(removal.preserved).toContain(skillPath);
    expect(removal.removed).toContain(cliPath);
    expect(await readFile(skillPath, "utf8")).toBe("my edited skill\n");
    await expect(readFile(cliPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(customPath, "utf8")).toBe("keep me");
  });

  it("removes an owned symlink but preserves one the user repointed", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-harness-test-"));
    const manifestPath = join(root, ".agents/skills/volli/.volli-managed.json");
    const claudeLink = join(root, ".claude/skills/volli");

    const ownedPlan = buildHarnessInstallPlan({ home: root, detected: ["claude-code"] });
    await applyHarnessInstallPlan(ownedPlan, manifestPath);
    await rm(claudeLink, { force: true });
    await symlink(join(root, "somewhere-else"), claudeLink, "dir");

    const removal = await uninstallHarnessPlan(ownedPlan, manifestPath);
    expect(removal.preserved).toContain(claudeLink);
    expect((await lstat(claudeLink)).isSymbolicLink()).toBe(true);

    // A pristine (still-ours) link is removed.
    await rm(claudeLink, { force: true });
    await applyHarnessInstallPlan(ownedPlan, manifestPath);
    const second = await uninstallHarnessPlan(ownedPlan, manifestPath);
    expect(second.removed).toContain(claudeLink);
    await expect(lstat(claudeLink)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("guards a CRLF user-edited fenced block as a conflict instead of overwriting", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-harness-test-"));
    const instructionsPath = join(root, "AGENTS.md");
    const manifestPath = join(root, ".volli-managed.json");
    const plan = genericHarnessActions(instructionsPath);
    await applyHarnessInstallPlan(plan, manifestPath);

    // User rewrites the managed body and saves with Windows line endings.
    const crlfEdited = "<!-- volli:begin v=1 -->\r\nmy hand edits\r\n<!-- volli:end -->\r\n";
    await writeFile(instructionsPath, crlfEdited);

    const refreshed = await applyHarnessInstallPlan(plan, manifestPath);
    expect(refreshed.conflicts.map((conflict) => conflict.path)).toContain(instructionsPath);
    expect(refreshed.conflicts[0]?.currentContent).toBe("my hand edits");
    expect(await readFile(instructionsPath, "utf8")).toBe(crlfEdited);
  });

  it("refuses to follow a dangling managed-file symlink", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-harness-test-"));
    const plan = buildHarnessInstallPlan({ home: root, detected: ["codex"] });
    const skillPath = join(root, ".agents/skills/volli/SKILL.md");
    const outsideTarget = join(root, "must-not-be-created.md");
    const manifestPath = join(root, ".agents/skills/volli/.volli-managed.json");
    await mkdir(join(root, ".agents/skills/volli"), { recursive: true });
    await symlink(outsideTarget, skillPath);

    await expect(applyHarnessInstallPlan(plan, manifestPath)).rejects.toThrow(
      "Refusing to manage non-regular file",
    );
    expect((await lstat(skillPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(outsideTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

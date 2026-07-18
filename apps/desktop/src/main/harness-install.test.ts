import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildHarnessInstallPlan } from "@volli/shared";

import { applyHarnessInstallPlan, uninstallHarnessPlan } from "./harness-install";

let root: string | undefined;

afterEach(async () => {
  if (!root) return;
  const { rm } = await import("node:fs/promises");
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
    expect(refreshed.conflicts).toEqual([skillPath]);
    expect(await readFile(skillPath, "utf8")).toBe("my edited skill\n");

    await uninstallHarnessPlan(plan, manifestPath);
    await expect(readFile(skillPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(customPath, "utf8")).toBe("keep me");
  });
});

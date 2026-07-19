import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildHarnessInstallPlan, HARNESS_IDS } from "@volli/shared";

import { applyHarnessInstallPlan } from "./harness-install";
import {
  detectInstalledHarnesses,
  globalCliLinkShellCommand,
  runAgentToolsConsent,
  uninstallAllHarnessSkills,
} from "./agent-tools";

let root: string | undefined;

afterEach(async () => {
  if (!root) return;
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("detectInstalledHarnesses", () => {
  it("returns only executable harnesses present on PATH", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-detect-test-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await writeFile(join(bin, "opencode"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    await chmod(join(bin, "opencode"), 0o755);

    expect(await detectInstalledHarnesses(bin)).toEqual(["codex", "opencode"]);
  });
});

describe("globalCliLinkShellCommand", () => {
  it("creates /usr/local/bin before linking so fresh macOS never fails permanently", () => {
    const command = globalCliLinkShellCommand("/Users/me/Library/App/bin/volli");
    expect(command).toBe(
      "/bin/mkdir -p /usr/local/bin && " +
        "if [ -L /usr/local/bin/volli ] && [ \"$(/usr/bin/readlink /usr/local/bin/volli)\" = '/Users/me/Library/App/bin/volli' ]; then :; " +
        "elif [ -e /usr/local/bin/volli ] || [ -L /usr/local/bin/volli ]; then echo 'Refusing to replace existing /usr/local/bin/volli' >&2; exit 1; " +
        "else /bin/ln -sn '/Users/me/Library/App/bin/volli' /usr/local/bin/volli; fi",
    );
    expect(command.indexOf("/bin/mkdir")).toBeLessThan(command.indexOf("/bin/ln -sn"));
    expect(command).not.toContain(" -f");
  });
});

describe("uninstallAllHarnessSkills", () => {
  it("removes the skill pack for every first-class harness", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-uninstall-test-"));
    const plan = buildHarnessInstallPlan({ home: root, detected: HARNESS_IDS });
    const manifestPath = join(root, ".agents/skills/volli/.volli-managed.json");
    await applyHarnessInstallPlan(plan, manifestPath);
    const skill = join(root, ".agents/skills/volli/SKILL.md");
    expect((await stat(skill)).isFile()).toBe(true);

    const removal = await uninstallAllHarnessSkills({ home: root });
    expect(removal.removed).toContain(skill);
    expect(removal.preserved).toEqual([]);
    await expect(readFile(skill, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("runAgentToolsConsent", () => {
  it("installs only after explicit first-launch consent and persists the choice", async () => {
    const prompt = vi.fn(async () => "install" as const);
    const install = vi.fn(async () => undefined);
    const persist = vi.fn(async () => undefined);

    expect(await runAgentToolsConsent({ current: null, prompt, install, persist })).toBe(
      "installed",
    );
    expect(install).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("installed");

    prompt.mockClear();
    install.mockClear();
    await runAgentToolsConsent({ current: "deferred", prompt, install, persist });
    expect(prompt).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });
});

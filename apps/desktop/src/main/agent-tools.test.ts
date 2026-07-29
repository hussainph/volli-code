import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildHarnessInstallPlan, FIRST_CLASS_HARNESS_IDS } from "@volli/shared";

import { applyHarnessInstallPlan } from "./harness-install";
import {
  detectHarnesses,
  detectInstalledHarnesses,
  globalCliLinkShellCommand,
  resolveOnPath,
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

describe("resolveOnPath", () => {
  /** Two bin dirs, each holding an executable named `command`. */
  async function twoBins(command: string): Promise<{ first: string; second: string }> {
    root = await mkdtemp(join(tmpdir(), "volli-resolve-"));
    const first = join(root, "first");
    const second = join(root, "second");
    for (const dir of [first, second]) {
      await mkdir(dir);
      await writeFile(join(dir, command), "#!/bin/sh\n");
      await chmod(join(dir, command), 0o755);
    }
    return { first, second };
  }

  it("answers with the first executable of that name, as a shell would", async () => {
    const { first, second } = await twoBins("my-harness");

    expect(await resolveOnPath(`${first}:${second}`, "my-harness")).toBe(join(first, "my-harness"));
  });

  it("walks past Volli's own bin dir, which holds the wrapper rather than the harness", async () => {
    const { first, second } = await twoBins("my-harness");

    expect(await resolveOnPath(`${first}:${second}`, "my-harness", first)).toBe(
      join(second, "my-harness"),
    );
  });

  it("answers null for a command that is on no PATH entry", async () => {
    const { first } = await twoBins("my-harness");

    expect(await resolveOnPath(first, "other-harness")).toBeNull();
  });
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

describe("detectHarnesses", () => {
  /** A bin directory holding one executable named after a first-class harness. */
  async function binWith(command: string): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "volli-detect-login-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, command), "#!/bin/sh\n");
    await chmod(join(bin, command), 0o755);
    return bin;
  }

  it("finds a harness on the login shell's PATH that the app's own PATH cannot see", async () => {
    const bin = await binWith("codex");
    // What a Finder or Dock launch actually inherits: launchd's PATH, which
    // holds none of the directories a harness installs into.
    const launchd = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" };

    const detected = await detectHarnesses({
      env: launchd,
      runShell: async () => `${bin}:${launchd.PATH}\n`,
    });

    expect(detected).toEqual(["codex"]);
  });

  it("reports null when the login PATH could not be resolved, not an empty host", async () => {
    await binWith("codex");

    const detected = await detectHarnesses({
      env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
      runShell: async () => {
        throw new Error("shell is wedged");
      },
    });

    expect(detected).toBeNull();
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

  it("lets a packaged install replace only the exact legacy dev launcher", () => {
    expect(
      globalCliLinkShellCommand(
        "/Users/me/Library/Application Support/Volli Code/bin/volli",
        "/Users/me/Library/Application Support/Volli Code-dev/bin/volli",
      ),
    ).toContain(
      `elif [ -L /usr/local/bin/volli ] && [ "$(/usr/bin/readlink /usr/local/bin/volli)" = '/Users/me/Library/Application Support/Volli Code-dev/bin/volli' ]; then /bin/ln -sfn '/Users/me/Library/Application Support/Volli Code/bin/volli' /usr/local/bin/volli;`,
    );
  });
});

describe("uninstallAllHarnessSkills", () => {
  it("removes the skill pack for every first-class harness", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-uninstall-test-"));
    const plan = buildHarnessInstallPlan({ home: root, detected: FIRST_CLASS_HARNESS_IDS });
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

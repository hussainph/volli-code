import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { buildHarnessInstallPlan, harnessAdapters, VOLLI_PATH_PROFILE_BLOCK } from "@volli/shared";
import type { HarnessAdapter, HarnessId } from "@volli/shared";

import { applyHarnessInstallPlan } from "./harness-install";
import {
  cleanupLegacyGlobalCliLink,
  detectHarnesses,
  detectInstalledHarnesses,
  ensureUserBinOnPath,
  ensureUserCliLink,
  installHarnessSkills,
  loginPathHasUserBin,
  removeUserBinPathBlock,
  removeUserCliLinkIfOurs,
  resolveOnPath,
  uninstallAllHarnessSkills,
  userCliLinkPath,
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
      // Marked, as the probe's own `printf` marks it: an interactive shell
      // talks on both sides of the command, so only the marked line counts.
      runShell: async () => `__VOLLI_PATH__${bin}:${launchd.PATH}\n`,
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

describe("ensureUserCliLink", () => {
  it("creates ~/.local/bin/volli pointing at the shim, directories included", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-user-link-"));
    const shimPath = join(root, "userData", "bin", "volli");

    const result = await ensureUserCliLink({ home: root, shimPath });

    expect(result).toEqual({ state: "linked", changed: true });
    expect(await readlink(userCliLinkPath(root))).toBe(shimPath);
  });

  it("is a no-op when the link already points at this shim", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-user-link-"));
    const shimPath = join(root, "userData", "bin", "volli");
    await ensureUserCliLink({ home: root, shimPath });

    expect(await ensureUserCliLink({ home: root, shimPath })).toEqual({
      state: "linked",
      changed: false,
    });
  });

  it("repoints a managed sibling's link but keeps a foreign one exactly as it is", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-user-link-"));
    const devShim = join(root, "Volli Code-dev", "bin", "volli");
    const shimPath = join(root, "Volli Code", "bin", "volli");
    await mkdir(join(root, ".local", "bin"), { recursive: true });
    await symlink(devShim, userCliLinkPath(root));

    expect(await ensureUserCliLink({ home: root, shimPath, managedTargets: [devShim] })).toEqual({
      state: "linked",
      changed: true,
    });
    expect(await readlink(userCliLinkPath(root))).toBe(shimPath);

    // Now make it foreign: someone else's volli.
    const foreign = join(root, "other-tool", "volli");
    const { rm } = await import("node:fs/promises");
    await rm(userCliLinkPath(root));
    await symlink(foreign, userCliLinkPath(root));
    expect(await ensureUserCliLink({ home: root, shimPath, managedTargets: [devShim] })).toEqual({
      state: "kept",
      target: foreign,
    });
    expect(await readlink(userCliLinkPath(root))).toBe(foreign);
  });

  it("never replaces a regular file wearing the name", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-user-link-"));
    await mkdir(join(root, ".local", "bin"), { recursive: true });
    await writeFile(userCliLinkPath(root), "#!/bin/sh\n");

    expect(await ensureUserCliLink({ home: root, shimPath: join(root, "shim") })).toEqual({
      state: "kept",
      target: null,
    });
    expect((await lstat(userCliLinkPath(root))).isSymbolicLink()).toBe(false);
  });
});

describe("removeUserCliLinkIfOurs", () => {
  it("removes our link, leaves a foreign one, and reports an absent one as not removed", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-user-unlink-"));
    const shimPath = join(root, "userData", "bin", "volli");
    await ensureUserCliLink({ home: root, shimPath });

    expect(await removeUserCliLinkIfOurs({ home: root, shimPath })).toBe(true);
    expect(await removeUserCliLinkIfOurs({ home: root, shimPath })).toBe(false);

    await symlink(join(root, "other", "volli"), userCliLinkPath(root));
    expect(await removeUserCliLinkIfOurs({ home: root, shimPath })).toBe(false);
    expect(await readlink(userCliLinkPath(root))).toBe(join(root, "other", "volli"));
  });
});

describe("cleanupLegacyGlobalCliLink", () => {
  it("removes the legacy link only when it points at our shim (or a managed sibling's)", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-legacy-link-"));
    const shimPath = join(root, "userData", "bin", "volli");
    const legacyLinkPath = join(root, "usr-local-bin-volli");
    await symlink(shimPath, legacyLinkPath);

    expect(await cleanupLegacyGlobalCliLink({ shimPath, legacyLinkPath })).toBe("removed");
    expect(await cleanupLegacyGlobalCliLink({ shimPath, legacyLinkPath })).toBe("absent");
  });

  it("keeps a foreign link and a regular file, reporting them as kept", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-legacy-link-"));
    const shimPath = join(root, "userData", "bin", "volli");

    const foreignLink = join(root, "foreign-link");
    await symlink(join(root, "someone-elses", "volli"), foreignLink);
    expect(await cleanupLegacyGlobalCliLink({ shimPath, legacyLinkPath: foreignLink })).toBe(
      "kept",
    );
    expect(await readlink(foreignLink)).toBe(join(root, "someone-elses", "volli"));

    const plainFile = join(root, "plain-volli");
    await writeFile(plainFile, "#!/bin/sh\n");
    expect(await cleanupLegacyGlobalCliLink({ shimPath, legacyLinkPath: plainFile })).toBe("kept");
  });
});

describe("login PATH wiring", () => {
  it("recognizes ~/.local/bin on the login PATH, trailing slashes tolerated", () => {
    expect(loginPathHasUserBin(`/usr/bin:${join("/home/me", ".local/bin")}`, "/home/me")).toBe(
      true,
    );
    expect(loginPathHasUserBin(`/usr/bin:${join("/home/me", ".local/bin")}/`, "/home/me")).toBe(
      true,
    );
    expect(loginPathHasUserBin("/usr/bin:/bin", "/home/me")).toBe(false);
  });

  it("writes the fenced PATH block to ~/.zprofile only when the login shell misses ~/.local/bin", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-path-wiring-"));

    const already = await ensureUserBinOnPath({
      home: root,
      loginPath: `/usr/bin:${join(root, ".local/bin")}`,
    });
    expect(already).toEqual({ state: "on-path", conflicts: [] });
    await expect(readFile(join(root, ".zprofile"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const written = await ensureUserBinOnPath({ home: root, loginPath: "/usr/bin:/bin" });
    expect(written.state).toBe("written");
    const profile = await readFile(join(root, ".zprofile"), "utf8");
    expect(profile).toContain("# volli:begin v=1");
    expect(profile).toContain(VOLLI_PATH_PROFILE_BLOCK);
    expect(profile).toContain("# volli:end");
    // A zsh profile must never carry an HTML comment — that is a syntax error.
    expect(profile).not.toContain("<!--");
  });

  it("writes nothing when the login shell could not be asked", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-path-wiring-"));

    expect(await ensureUserBinOnPath({ home: root, loginPath: null })).toEqual({
      state: "unknown",
      conflicts: [],
    });
    await expect(readFile(join(root, ".zprofile"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a user-edited block as a conflict instead of clobbering it", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-path-wiring-"));
    await ensureUserBinOnPath({ home: root, loginPath: "/usr/bin" });
    const profile = await readFile(join(root, ".zprofile"), "utf8");
    const edited = profile.replace("$HOME/.local/bin", "$HOME/custom/bin");
    await writeFile(join(root, ".zprofile"), edited);

    const second = await ensureUserBinOnPath({ home: root, loginPath: "/usr/bin" });
    expect(second.state).toBe("conflict");
    expect(second.conflicts).toHaveLength(1);
    expect(await readFile(join(root, ".zprofile"), "utf8")).toBe(edited);
  });

  it("excises exactly the managed block on removal, leaving the user's profile", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-path-wiring-"));
    await writeFile(join(root, ".zprofile"), "export EDITOR=vim\n");
    await ensureUserBinOnPath({ home: root, loginPath: "/usr/bin" });

    const removal = await removeUserBinPathBlock(root);
    expect(removal.removed).toContain(join(root, ".zprofile"));
    const profile = await readFile(join(root, ".zprofile"), "utf8");
    expect(profile).toContain("export EDITOR=vim");
    expect(profile).not.toContain("volli:begin");
  });
});

describe("installHarnessSkills", () => {
  /** The adapter shape a trusted manifest parses into: reachable by no id lookup. */
  const registeredAdapter: HarnessAdapter = {
    id: "my-harness" as HarnessId,
    label: "My Harness",
    command: "my-harness",
    promptFlag: null,
    surfaces: {
      skillsDir: "{home}/.my-harness/skills",
      commandsDir: null,
      instructionsFile: "{home}/.my-harness/AGENTS.md",
    },
    injection: { kind: "none" },
    sessionId: { kind: "none" },
    resume: { byId: null, latest: null, userResumeTokens: [] },
    events: [],
    startupEvent: null,
    launchSettings: [],
    sessionMarkers: [],
  };

  it("delivers the skill pack to a registered harness, not only to the built-ins", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-install-registered-"));

    const result = await installHarnessSkills({ home: root, adapters: [registeredAdapter] });

    const link = join(root, ".my-harness/skills/volli");
    expect(result.conflicts).toEqual([]);
    expect(result.written).toContain(link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join(root, ".agents/skills/volli"));
    expect(await readFile(join(root, ".my-harness/AGENTS.md"), "utf8")).toContain("volli:begin");
    // The canonical pack the symlink points at has to exist, or the link dangles.
    expect((await stat(join(root, ".agents/skills/volli/SKILL.md"))).isFile()).toBe(true);
  });

  it("writes nothing at all when the caller can name no harness", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-install-empty-"));

    const result = await installHarnessSkills({ home: root, adapters: [] });

    expect(result).toEqual({ written: [], skipped: [], conflicts: [] });
    await expect(stat(join(root, ".agents/skills/volli/SKILL.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("uninstallAllHarnessSkills", () => {
  it("removes the skill pack for every first-class harness", async () => {
    root = await mkdtemp(join(tmpdir(), "volli-uninstall-test-"));
    const plan = buildHarnessInstallPlan({ home: root, adapters: harnessAdapters });
    const manifestPath = join(root, ".agents/skills/volli/.volli-managed.json");
    await applyHarnessInstallPlan(plan, manifestPath);
    const skill = join(root, ".agents/skills/volli/SKILL.md");
    expect((await stat(skill)).isFile()).toBe(true);

    const removal = await uninstallAllHarnessSkills({ home: root, adapters: harnessAdapters });
    expect(removal.removed).toContain(skill);
    expect(removal.preserved).toEqual([]);
    await expect(readFile(skill, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

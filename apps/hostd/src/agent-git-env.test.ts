import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { agentGitEnvironment } from "./agent-git-env";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-agent-git-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a Session's git environment", () => {
  it("on a Mac, resets every credential helper and turns prompts off, then adds Volli's", () => {
    expect(agentGitEnvironment("darwin")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(agentGitEnvironment("darwin", ["!volli-helper"])).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!volli-helper",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("elsewhere, changes nothing unless a helper is given", () => {
    expect(agentGitEnvironment("linux")).toEqual({});
    expect(agentGitEnvironment("linux", ["!volli-helper"])).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!volli-helper",
    });
  });

  /**
   * Real git, against a scratch configuration that names `osxkeychain`, with
   * a stand-in `git-credential-osxkeychain` that only records that it ran.
   * No system configuration, no repository, and a scratch exec path: the
   * machine's own keychain helper is unreachable from this test.
   */
  it("never runs the keychain helper a git configuration names (real git)", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const ran = join(root, "osxkeychain-ran");
    writeFileSync(join(bin, "git-credential-osxkeychain"), `#!/bin/sh\necho "$@" >> '${ran}'\n`, {
      mode: 0o755,
    });
    const volliRan = join(root, "volli-ran");
    const volliHelper = join(root, "volli-helper");
    writeFileSync(volliHelper, `#!/bin/sh\necho "$@" >> '${volliRan}'\n`, { mode: 0o755 });
    const global = join(root, "gitconfig");
    writeFileSync(global, "[credential]\n\thelper = osxkeychain\n");
    const base = {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: root,
      GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXEC_PATH: bin,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: tmpdir(),
    };
    const fill = (env: Record<string, string>) =>
      spawnSync("git", ["credential", "fill"], {
        // Outside any repository: no local configuration answers instead.
        cwd: root,
        env,
        input: "protocol=https\nhost=example.com\n\n",
        encoding: "utf8",
        timeout: 10_000,
      });

    // Without the reset, git runs the configured helper: the stand-in records it.
    fill(base);
    expect(existsSync(ran)).toBe(true);
    rmSync(ran);

    // With it, never; and Volli's own helper, appended after, is the one asked.
    const isolated = fill({ ...base, ...agentGitEnvironment("darwin", [`!${volliHelper}`]) });
    expect(existsSync(ran)).toBe(false);
    expect(readFileSync(volliRan, "utf8")).toContain("get");
    // Nothing answered and prompts are off: git fails rather than wait for a person.
    expect(isolated.status).not.toBe(0);
    rmSync(volliRan);
    fill({ ...base, ...agentGitEnvironment("darwin") });
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(volliRan)).toBe(false);
  });
});

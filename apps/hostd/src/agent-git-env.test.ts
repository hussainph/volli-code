import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { appendGitConfig } from "@volli/host-core/session-runtime";

import { sessionGitEnv, withAgentGit } from "./agent-git-env";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-agent-git-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a Session's git environment", () => {
  it("on a Mac, resets every credential helper and turns prompts off", () => {
    expect(withAgentGit({ PATH: "/bin" }, "darwin")).toEqual({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
    });
    // Elsewhere the record is left as it is.
    expect(withAgentGit({ PATH: "/bin" }, "linux")).toEqual({ PATH: "/bin" });
  });

  it("appends after whatever the record holds, so two writers compose", () => {
    const reset = withAgentGit({}, "darwin");
    // VC-702's helper, appended after the reset.
    expect(appendGitConfig(reset, [["credential.helper", "!volli-helper"]])).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!volli-helper",
    });
    // And the reset after an entry already there still clears it.
    expect(
      withAgentGit(
        { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" },
        "darwin",
      ),
    ).toMatchObject({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: "credential.helper" });
    // A count that is not one starts over.
    expect(appendGitConfig({ GIT_CONFIG_COUNT: "nope" }, [["a.b", "c"]])).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
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
    const isolated = fill(
      appendGitConfig(withAgentGit(base, "darwin"), [["credential.helper", `!${volliHelper}`]]),
    );
    expect(existsSync(ran)).toBe(false);
    expect(readFileSync(volliRan, "utf8")).toContain("get");
    // Nothing answered and prompts are off: git fails rather than wait for a person.
    expect(isolated.status).not.toBe(0);
    rmSync(volliRan);
    fill(withAgentGit(base, "darwin"));
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(volliRan)).toBe(false);
  });

  it("composes the record a Session gets: on a Mac the reset first, Volli's helper after", () => {
    const helper = "!'/opt/volli-hostd/bin/volli-hostd' git-credential --data-dir '/data'";
    expect(sessionGitEnv({ PATH: "/bin" }, "darwin", helper)).toEqual({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: helper,
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(sessionGitEnv({ PATH: "/bin" }, "linux", helper)).toEqual({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: helper,
    });
    // The cloud flag off: no helper, and on Linux nothing at all.
    expect(sessionGitEnv({ PATH: "/bin" }, "linux", null)).toEqual({ PATH: "/bin" });
  });

  /**
   * The composed record itself (`sessionGitEnv`, what `concurrencyEnvFor`
   * hands every Session command), on the darwin path, through real git: a
   * configuration naming `osxkeychain` and a stand-in that only records it
   * ran, and a stand-in for Volli's helper that answers. Isolated git: no
   * system file, a scratch HOME and GIT_CONFIG_GLOBAL, a scratch exec path.
   */
  it("on a Mac, real git asks Volli's helper and never the keychain (the composed record)", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const keychainRan = join(root, "osxkeychain-ran");
    writeFileSync(
      join(bin, "git-credential-osxkeychain"),
      `#!/bin/sh\necho "$@" >> '${keychainRan}'\n`,
      { mode: 0o755 },
    );
    const volliRan = join(root, "volli-ran");
    const volli = join(root, "volli-helper");
    writeFileSync(
      volli,
      `#!/bin/sh\necho "$@" >> '${volliRan}'\n[ "$1" = get ] && printf 'username=x-access-token\\npassword=from-volli\\n'\n`,
      { mode: 0o755 },
    );
    const global = join(root, "gitconfig");
    writeFileSync(global, "[credential]\n\thelper = osxkeychain\n");
    const record = sessionGitEnv(
      {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        HOME: root,
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_EXEC_PATH: bin,
        GIT_CEILING_DIRECTORIES: tmpdir(),
      },
      "darwin",
      `!${volli}`,
    );
    expect([record["GIT_CONFIG_VALUE_0"], record["GIT_CONFIG_VALUE_1"]]).toEqual(["", `!${volli}`]);
    const filled = spawnSync("git", ["credential", "fill"], {
      cwd: root,
      env: record,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(filled.status).toBe(0);
    expect(filled.stdout).toContain("password=from-volli");
    expect(readFileSync(volliRan, "utf8")).toContain("get");
    expect(existsSync(keychainRan)).toBe(false);
  });
});

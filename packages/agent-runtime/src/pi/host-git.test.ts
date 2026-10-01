import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { gitVariables, hostGitReadables, NO_HOST_GIT, readHostGitSettings } from "./host-git";

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "volli-host-git-")));
}

/** A `git config` that answers from a table, and "" (unset) for anything else. */
function reader(answers: Record<string, string>) {
  return async (args: readonly string[]) => answers[args.at(-1)!] ?? "";
}

describe("readHostGitSettings", () => {
  it("hands over identity, existing global files, safe directories, and signing", async () => {
    const base = scratch();
    writeFileSync(join(base, "ignore"), ".env.local\n");
    writeFileSync(join(base, "attributes"), "*.png binary\n");
    const settings = await readHostGitSettings(
      base,
      reader({
        "user.name": " Host Person \n",
        "user.email": "host@volli.test\n",
        "core.excludesFile": `${join(base, "ignore")}\n`,
        "core.attributesFile": `${join(base, "attributes")}\n`,
        "safe.directory": "/shared/a\n\n/shared/b\n",
        "commit.gpgsign": "true\n",
        "tag.gpgsign": "false\n",
      }),
      {},
    );
    expect(settings).toEqual({
      identity: { name: "Host Person", email: "host@volli.test" },
      excludesFile: join(base, "ignore"),
      attributesFile: join(base, "attributes"),
      safeDirectories: ["/shared/a", "/shared/b"],
      signCommits: true,
      signTags: false,
    });
    expect(hostGitReadables(settings)).toEqual([join(base, "ignore"), join(base, "attributes")]);
  });

  it("falls back to the XDG files only when nothing is configured, and to none when they are missing", async () => {
    const base = scratch();
    mkdirSync(join(base, "git"));
    writeFileSync(join(base, "git", "ignore"), "x\n");
    const settings = await readHostGitSettings(
      base,
      reader({
        // Half an identity is none.
        "user.name": "Host Person",
        // A configured file that does not exist is not replaced by the default.
        "core.attributesFile": join(base, "missing"),
      }),
      { XDG_CONFIG_HOME: base },
    );
    expect(settings).toEqual({
      ...NO_HOST_GIT,
      excludesFile: join(base, "git", "ignore"),
    });
    expect(hostGitReadables(settings)).toEqual([join(base, "git", "ignore")]);
    // Without XDG_CONFIG_HOME the default is under the home directory.
    expect((await readHostGitSettings(base, reader({}), {})).identity).toBeNull();
  });

  it("reads the real host config of a repository, and nothing from a failing git", async () => {
    const settings = await readHostGitSettings(scratch(), undefined, {});
    expect(settings.safeDirectories).toEqual(expect.any(Array));
    expect(await readHostGitSettings(join(scratch(), "missing"))).toMatchObject({
      safeDirectories: [],
      signCommits: false,
    });
  });
});

describe("gitVariables", () => {
  it("points git at no global config and passes exactly the chosen settings", () => {
    expect(gitVariables(NO_HOST_GIT)).toEqual({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.attributesFile",
      GIT_CONFIG_VALUE_1: "/dev/null",
    });
    expect(
      gitVariables({
        ...NO_HOST_GIT,
        identity: { name: "P", email: "p@volli.test" },
        attributesFile: "/a",
        signTags: true,
      }),
    ).toEqual({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.attributesFile",
      GIT_CONFIG_VALUE_1: "/a",
      GIT_CONFIG_KEY_2: "tag.gpgsign",
      GIT_CONFIG_VALUE_2: "true",
      GIT_AUTHOR_NAME: "P",
      GIT_AUTHOR_EMAIL: "p@volli.test",
      GIT_COMMITTER_NAME: "P",
      GIT_COMMITTER_EMAIL: "p@volli.test",
    });
  });
});
